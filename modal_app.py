"""Modal deployment: AI vocal separation on an L4 GPU, everything else on CPU, job API over HTTPS.

One-time setup (run from your Mac, in this folder):
    pip install modal && modal setup                       # sign in (opens the browser)
    modal secret create rework-api REWORK_API_KEY=<long random string>
    modal deploy modal_app.py                              # prints the API URL

Then:
    modal run modal_app.py::selftest                       # deployment check on the bundled test clip
    modal run modal_app.py::approve --manifest eval/songs.csv   # record rights approvals for your songs

Same job logic as the local server (service.py). Storage is the Modal Volume "rework-data" mounted at /data.
Written against Modal 1.x; this file has not yet been run on Modal (the build sandbox cannot reach Modal's API).
"""
from __future__ import annotations

import time
from pathlib import Path

import modal

APP_DIR = "/root/app"
app = modal.App("ai-house-rework")
vol = modal.Volume.from_name("rework-data", create_if_missing=True)
api_secret = modal.Secret.from_name("rework-api")

# Small image for the API, the job orchestrator and admin tasks (fast cold starts).
light = (modal.Image.debian_slim(python_version="3.12")
         .pip_install("fastapi[standard]==0.115.*", "python-multipart")
         .add_local_python_source("service"))

# GPU image: PyTorch + audio-separator for stage 1.
gpu_image = (modal.Image.debian_slim(python_version="3.12")
             .apt_install("ffmpeg")
             .pip_install("torch", "torchaudio", "audio-separator", "audioread", "soundfile", "fastapi[standard]==0.115.*", "python-multipart")
             .add_local_python_source("pipeline", "service"))

# CPU image: Node + the shared production engine for stages 2-6.
cpu_image = (modal.Image.debian_slim(python_version="3.12")
             .apt_install("curl", "ca-certificates", "ffmpeg")
             .run_commands("curl -fsSL https://deb.nodesource.com/setup_22.x | bash -", "apt-get install -y nodejs")
             .pip_install("fastapi[standard]==0.115.*", "python-multipart")
             .add_local_dir("engine", f"{APP_DIR}/engine", copy=True, ignore=["node_modules", "__pycache__"])
             .run_commands(f"cd {APP_DIR}/engine && npm install --omit=dev")
             .add_local_file("pipeline.py", f"{APP_DIR}/pipeline.py", copy=True)
             .add_local_python_source("service"))

VOLUMES = {"/data": vol}
_CONTAINER_START = time.time()     # set when a container imports this module
_CALLS = {"n": 0}


def _billed(call_start: float) -> tuple[float, bool]:
    """Seconds attributable to this call. The first call in a container also pays for container start-up and imports."""
    first = _CALLS["n"] == 0
    _CALLS["n"] += 1
    return time.time() - (_CONTAINER_START if first else call_start), first


@app.function(image=gpu_image, gpu="L4", cpu=2.0, memory=8192, volumes=VOLUMES, timeout=1800, scaledown_window=30)
def separate_gpu(sha: str) -> dict:
    """Stage 1. Writes songs/<sha>/vocal.wav. Refuses to run without CUDA."""
    import os, shutil, sys
    os.environ["REWORK_MODEL_DIR"] = "/data/models"
    sys.path.insert(0, APP_DIR)
    import pipeline
    pipeline.MODEL_DIR = Path("/data/models")
    start = time.time()
    vol.reload()
    d = Path("/data/songs") / sha
    stem, t = pipeline.separate_vocal_timed(d / "song", Path("/tmp") / sha, require_gpu=True)
    shutil.move(str(stem), d / "vocal.wav")
    vol.commit()
    billed, cold = _billed(start)
    return {"billed_s": billed, "cold_start": cold, **t}


@app.function(image=cpu_image, cpu=2.0, memory=4096, volumes=VOLUMES, timeout=1800, scaledown_window=30)
def render_cpu(sha: str, jid: str, style: str, seed: int | None, pitch: str, cached: bool) -> tuple[dict, dict]:
    """Stages 2-6. Saves the analysis on first render; reuses it (and the vocal) for new beats."""
    import sys
    sys.path.insert(0, APP_DIR)
    import pipeline
    start = time.time()
    vol.reload()
    d, j = Path("/data/songs") / sha, Path("/data/jobs") / jid
    j.mkdir(parents=True, exist_ok=True)
    kw = {"analysis_in": d / "analysis.json"} if cached else {"analysis_out": d / "analysis.json"}
    report = pipeline.render(d / "song", d / "vocal.wav", style, j / "rework.wav", seed=seed, pitch=pitch, **kw)
    vol.commit()
    billed, cold = _billed(start)
    return report, {"billed_s": billed, "cold_start": cold}


class ModalRunner:
    def separate(self, sha):
        return separate_gpu.remote(sha)

    def render(self, sha, jid, style, seed, pitch, cached):
        return render_cpu.remote(sha, jid, style, seed, pitch, cached)


def _store():
    import service
    return service.Store(Path("/data"), on_write=vol.commit, on_read=vol.reload)


@app.function(image=light, cpu=0.125, memory=512, volumes=VOLUMES, timeout=3600)
def run_job(jid: str) -> dict:
    import service
    vol.reload()
    return service.process_job(_store(), ModalRunner(), jid)


@app.function(image=light, cpu=0.25, memory=512, volumes=VOLUMES, secrets=[api_secret], timeout=600)
@modal.asgi_app()
def web():
    import service
    return service.make_api(_store(), submit=lambda jid: run_job.spawn(jid), require_key=True)


@app.function(image=light, volumes=VOLUMES)
def write_approvals(entries: dict) -> int:
    """Merge rights approvals into /data/rights/approved.json (admin only: called from your machine via `approve`)."""
    store = _store()
    vol.reload()
    cur = store.approved()
    cur.update(entries)
    store.set_approved(cur)
    return len(cur)


@app.function(image=light, volumes=VOLUMES, timeout=3600)
def submit_direct(song: bytes, style: str, seed: int | None) -> str:
    """Admin path used by `selftest`: store an approved song and start a job without HTTP."""
    import service
    vol.reload()
    store = _store()
    sha = service.sha256_bytes(song)
    ok, why = service.rights_check(store, sha)
    if not ok:
        raise PermissionError(why)
    d = store.song_dir(sha); d.mkdir(parents=True, exist_ok=True)
    (d / "song").write_bytes(song)
    vol.commit()
    jid = service.create_job(store, sha, style, seed, "natural")
    return jid


@app.local_entrypoint()
def approve(manifest: str = "eval/songs.csv"):
    """Record rights approvals for every song in the manifest that has a rights basis and a confirmer."""
    import csv, hashlib, time as _t
    base = Path(manifest).parent
    entries, skipped = {}, []
    with open(manifest, newline="") as f:
        for row in csv.DictReader(f):
            p = (base / row["file"]) if not Path(row["file"]).is_absolute() else Path(row["file"])
            if not row.get("rights_basis", "").strip() or not row.get("rights_confirmed_by", "").strip():
                skipped.append(f"{row.get('id')}: missing rights_basis or rights_confirmed_by"); continue
            if not p.exists():
                skipped.append(f"{row.get('id')}: file not found {p}"); continue
            sha = hashlib.sha256(p.read_bytes()).hexdigest()
            entries[sha] = {"title": row.get("title"), "artist": row.get("artist"), "rights_basis": row["rights_basis"],
                            "confirmed_by": row["rights_confirmed_by"], "approved_at": _t.strftime("%Y-%m-%dT%H:%M:%S")}
    total = write_approvals.remote(entries) if entries else 0
    print(f"approved {len(entries)} songs (total on file: {total})")
    for s in skipped:
        print("SKIPPED", s)


@app.local_entrypoint()
def selftest(clip: str = "tests/real_voice_mix.wav", style: str = "pawsa"):
    """Deployment check on the bundled test clip (public-domain voice over a CC BY loop; not part of the evaluation).
    Runs a full rework, then a new beat, and prints timing and cost."""
    import hashlib, json
    data = Path(clip).read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    write_approvals.remote({sha: {"title": "selftest clip", "rights_basis": "public-domain voice (LibriVox) over CC BY loop (Admiral Bob, Choice)",
                                  "confirmed_by": "bundled test asset"}})
    t = time.time()
    jid = submit_direct.remote(data, style, 7)
    first = run_job.remote(jid)
    print("FIRST", json.dumps({"state": first["state"], "error": first.get("error"), "metrics": first.get("metrics")}, indent=1))
    print("client wall s", round(time.time() - t, 1))
    if first["state"] != "done":
        raise SystemExit(1)
    child = submit_direct.remote(data, style, 8)
    second = run_job.remote(child)
    print("NEW BEAT", json.dumps({"state": second["state"], "metrics": second.get("metrics")}, indent=1))
    ok = second["state"] == "done" and second["metrics"]["separation_cached"] and second["report"]["analysis_cached"]
    print("SELFTEST", "PASSED" if ok else "FAILED")
    if not ok:
        raise SystemExit(1)
