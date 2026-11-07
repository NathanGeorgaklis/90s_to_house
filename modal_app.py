"""Modal deployment: AI vocal separation on an L4 GPU, everything else on CPU, job API over HTTPS.

Use rework.sh (see RUN_ME_FIRST.md): setup, deploy, selftest, approve, eval, report.

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

# Package versions are pinned to the ones the tests ran against (7 Nov 2026).
API_PKGS = ["fastapi==0.162.0", "starlette==1.7.0", "pydantic==2.13.5", "python-multipart==0.0.32"]

# Small image for the API, the job orchestrator and admin tasks (fast cold starts).
light = (modal.Image.debian_slim(python_version="3.12")
         .pip_install(*API_PKGS)
         .add_local_python_source("service"))

# GPU image: PyTorch + audio-separator for stage 1.
gpu_image = (modal.Image.debian_slim(python_version="3.12")
             .apt_install("ffmpeg")
             .pip_install("torch==2.15.0", "torchaudio==2.11.1", "audio-separator==0.48.0", "audioread==3.1.0", "soundfile==0.14.0", *API_PKGS)
             .add_local_python_source("pipeline", "service"))

# CPU image: Node + the shared production engine for stages 2-6.
cpu_image = (modal.Image.debian_slim(python_version="3.12")
             .apt_install("curl", "ca-certificates", "ffmpeg")
             .run_commands("curl -fsSL https://deb.nodesource.com/setup_22.x | bash -", "apt-get install -y nodejs")
             .pip_install(*API_PKGS)
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


def _reload():
    """Best effort: a reload can fail while a file on the volume is open (e.g. a download in progress).
    Then this request sees the volume as of the last successful reload."""
    try:
        vol.reload()
    except Exception:
        pass


def _store():
    import service
    return service.Store(Path("/data"), on_write=vol.commit, on_read=_reload)


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
    _reload()
    cur = store.approved()
    cur.update(entries)
    store.set_approved(cur)
    return len(cur)
