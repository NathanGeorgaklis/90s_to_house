"""Rework service: job API, rights gate, per-song cache, timing and cost metrics.

Shared by the local server (app.py) and the Modal deployment (modal_app.py). Storage is a directory tree
(a Modal Volume on Modal), and the two compute stages are injected as a Runner:

    runner.separate(sha)                              -> timing dict   (GPU on Modal)
    runner.render(sha, job_id, style, seed, pitch, cached) -> (report, timing dict)   (CPU on Modal)

Layout under the base directory:
    rights/approved.json              {sha256: {title, rights_basis, confirmed_by, approved_at}}
    songs/<sha>/song                  uploaded audio
    songs/<sha>/vocal.wav             AI vocal stem (cached)
    songs/<sha>/analysis.json         song analysis (cached)
    jobs/<id>/status.json             state, stage, report, metrics, error
    jobs/<id>/rework.wav              finished rework
"""
from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse

# Modal list prices in US$ per second, checked 7 Nov 2026 (modal.com/pricing). Update here if they change.
RATES = {"gpu": {"L4": 0.000222, "A10": 0.000306, "T4": 0.000164, "L40S": 0.000542}, "cpu_core": 0.0000131, "mem_gib": 0.00000222}
# Resources reserved by each Modal function (must match modal_app.py). CPU is billed per physical core.
RESOURCES = {"separate": {"gpu": "L4", "cpu": 2.0, "mem_gib": 8.0}, "render": {"cpu": 2.0, "mem_gib": 4.0},
             "orchestrate": {"cpu": 0.125, "mem_gib": 0.5}}
STYLES = ["peak", "bounce", "minimal", "melodic", "afro", "speedg", "bibi", "pawsa", "cruz", "beltran", "rossi",
          "lukedean", "maxdean", "baker", "prospa", "stussy", "vocal", "deep", "piano"]


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _atomic_write(p: Path, text: str) -> None:
    """Write via a temporary file and rename, so a concurrent reader never sees a half-written file."""
    tmp = p.with_name(f".{p.name}.{uuid.uuid4().hex[:8]}.tmp")
    tmp.write_text(text)
    os.replace(tmp, p)


def cost_usd(stage: str, seconds: float) -> float:
    r = RESOURCES[stage]
    per_s = r["cpu"] * RATES["cpu_core"] + r["mem_gib"] * RATES["mem_gib"] + (RATES["gpu"][r["gpu"]] if "gpu" in r else 0.0)
    return seconds * per_s


class Runner(Protocol):
    def separate(self, sha: str) -> dict: ...
    def render(self, sha: str, job_id: str, style: str, seed: int | None, pitch: str, cached: bool) -> tuple[dict, dict]: ...


@dataclass
class Store:
    base: Path
    on_write: Callable[[], None] = lambda: None   # Modal: volume.commit()
    on_read: Callable[[], None] = lambda: None    # Modal: volume.reload()

    def song_dir(self, sha: str) -> Path: return self.base / "songs" / sha
    def job_dir(self, jid: str) -> Path: return self.base / "jobs" / jid

    def approved(self) -> dict:
        p = self.base / "rights" / "approved.json"
        return json.loads(p.read_text()) if p.exists() else {}

    def set_approved(self, entries: dict) -> None:
        p = self.base / "rights" / "approved.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write(p, json.dumps(entries, indent=2))
        self.on_write()

    def status(self, jid: str) -> dict:
        p = self.job_dir(jid) / "status.json"
        if not p.exists():
            raise KeyError(jid)
        return json.loads(p.read_text())

    def write_status(self, jid: str, **kv) -> dict:
        d = self.job_dir(jid); d.mkdir(parents=True, exist_ok=True)
        p = d / "status.json"
        cur = json.loads(p.read_text()) if p.exists() else {}
        cur.update(kv)
        _atomic_write(p, json.dumps(cur, indent=2))
        self.on_write()
        return cur

    def cached(self, sha: str) -> bool:
        d = self.song_dir(sha)
        return (d / "vocal.wav").exists() and (d / "analysis.json").exists()


def rights_check(store: Store, sha: str) -> tuple[bool, str]:
    """Fail closed. A song is accepted only if its exact audio file (SHA-256) is in the approved list, which
    records who confirmed the rights and on what basis. REWORK_ALLOW_UNVERIFIED_UPLOADS=1 is honoured only
    outside Modal (local testing), exactly as before."""
    entry = store.approved().get(sha)
    if entry:
        return True, f"approved: {entry.get('rights_basis')} (confirmed by {entry.get('confirmed_by')})"
    if os.environ.get("REWORK_ALLOW_UNVERIFIED_UPLOADS") == "1" and not os.environ.get("MODAL_TASK_ID"):
        return True, "unverified upload allowed by REWORK_ALLOW_UNVERIFIED_UPLOADS (local testing only)"
    return False, "rights check: this exact audio file is not in the approved list; add it with its rights basis first"


def create_job(store: Store, sha: str, style: str, seed: int | None, pitch: str, parent: str | None = None) -> str:
    jid = uuid.uuid4().hex[:12]
    store.write_status(jid, id=jid, sha=sha, style=style, seed=seed, pitch=pitch, parent=parent, state="queued",
                       stage="queued", created_at=time.time())
    return jid


def process_job(store: Store, runner: Runner, jid: str) -> dict:
    """Run one job: separation (unless cached), then render. Records per-stage timing and cost."""
    st = store.status(jid)
    sha, t0 = st["sha"], time.time()
    m: dict = {"separation_cached": store.cached(sha)}
    try:
        if not m["separation_cached"]:
            store.write_status(jid, state="running", stage="separating vocal")
            s = time.time()
            sep = runner.separate(sha)
            m["separation_wall_s"] = round(time.time() - s, 2)          # includes queueing and cold start
            m["gpu_billed_s"] = round(sep["billed_s"], 2)                # container time attributable to this call
            m["separation_s"] = round(sep["separation_s"], 2)
            m["model_load_s"] = round(sep.get("model_load_s", 0.0), 2)
            m["gpu_cold_start"] = bool(sep.get("cold_start"))
            m["gpu_type"] = RESOURCES["separate"]["gpu"]
        else:
            m.update(separation_wall_s=0.0, gpu_billed_s=0.0, separation_s=0.0)
        store.write_status(jid, state="running", stage="analysing, generating beat, arranging, rendering")
        s = time.time()
        report, rt = runner.render(sha, jid, st["style"], st.get("seed"), st.get("pitch", "natural"), cached=m["separation_cached"])
        m["render_wall_s"] = round(time.time() - s, 2)
        m["cpu_billed_s"] = round(rt["billed_s"], 2)
        m["cpu_cold_start"] = bool(rt.get("cold_start"))
        m["total_wall_s"] = round(time.time() - t0, 2)
        song_s = report["song"]["seconds"]
        m["song_seconds"] = song_s
        m["rework_seconds"] = report["rework"]["seconds"]
        m["rtf_total"] = round(m["total_wall_s"] / song_s, 3) if song_s else None             # processing time / song length
        m["rtf_separation"] = round(m["separation_s"] / song_s, 3) if song_s and m["separation_s"] else None
        m["cost_gpu_usd"] = round(cost_usd("separate", m["gpu_billed_s"]), 5)
        m["cost_cpu_usd"] = round(cost_usd("render", m["cpu_billed_s"]), 5)
        m["cost_orchestration_usd"] = round(cost_usd("orchestrate", m["total_wall_s"]), 6)
        m["cost_total_usd"] = round(m["cost_gpu_usd"] + m["cost_cpu_usd"] + m["cost_orchestration_usd"], 5)
        m["cost_note"] = ("estimate from metered container seconds x Modal list prices; excludes idle time before "
                          "containers scale down and network egress. Reconcile with the Modal usage dashboard.")
        return store.write_status(jid, state="done", stage="done", report=report, metrics=m, finished_at=time.time())
    except Exception as e:  # record the failing stage; never leave a half-made file
        (store.job_dir(jid) / "rework.wav").unlink(missing_ok=True)
        stage = store.status(jid).get("stage")
        return store.write_status(jid, state="failed", failed_stage=stage, error=f"{type(e).__name__}: {e}", metrics=m,
                                  finished_at=time.time())


# ---------------------------------------------------------------- HTTP API
def make_api(store: Store, submit: Callable[[str], None], require_key: bool):
    """FastAPI app. submit(job_id) starts processing (a thread locally, a spawned function on Modal)."""
    api = FastAPI(title="AI House Rework API", version="0.2.0")
    key = os.environ.get("REWORK_API_KEY", "")
    max_mb = int(os.environ.get("REWORK_MAX_UPLOAD_MB", "80"))

    def auth(authorization: str | None):
        if require_key and not key:
            raise HTTPException(503, "server misconfigured: REWORK_API_KEY is not set, so all requests are refused")
        if key and authorization != f"Bearer {key}":
            raise HTTPException(401, "missing or wrong API key")

    def job(jid: str) -> dict:
        store.on_read()
        try:
            return store.status(jid)
        except KeyError:
            raise HTTPException(404, "no such rework")

    @api.get("/health")
    def health():
        return {"ok": True}

    @api.get("/styles")
    def styles(authorization: str | None = Header(None)):
        auth(authorization)
        return {"styles": STYLES}

    @api.post("/reworks", status_code=202)
    async def create(file: UploadFile = File(...), style: str = Form("pawsa"), seed: int | None = Form(None),
                     pitch: str = Form("natural"), authorization: str | None = Header(None)):
        auth(authorization)
        if style not in STYLES:
            raise HTTPException(422, f"unknown style; choose one of {STYLES}")
        data = await file.read()
        if not data:
            raise HTTPException(422, "empty file")
        if len(data) > max_mb * 1024 * 1024:
            raise HTTPException(413, f"file over {max_mb} MB")
        sha = sha256_bytes(data)
        store.on_read()
        ok, why = rights_check(store, sha)
        if not ok:
            raise HTTPException(403, why)            # nothing is stored for a refused upload
        d = store.song_dir(sha); d.mkdir(parents=True, exist_ok=True)
        if not (d / "song").exists():
            (d / "song").write_bytes(data)
        jid = create_job(store, sha, style, seed, pitch)
        store.write_status(jid, rights=why, filename=file.filename)
        submit(jid)
        return {"id": jid, "state": "queued", "sha256": sha}

    @api.get("/reworks/{jid}")
    def status(jid: str, authorization: str | None = Header(None)):
        auth(authorization)
        return job(jid)

    def done_file(jid: str, path: Path, media: str, name: str):
        st = job(jid)
        if st.get("state") != "done":
            raise HTTPException(409, f"rework is {st.get('state')}")
        if not path.exists():
            raise HTTPException(500, f"{name} missing from storage")
        return FileResponse(path, media_type=media, filename=name)

    @api.get("/reworks/{jid}/audio")
    def audio(jid: str, authorization: str | None = Header(None)):
        auth(authorization)
        return done_file(jid, store.job_dir(jid) / "rework.wav", "audio/wav", f"rework-{jid}.wav")

    @api.get("/reworks/{jid}/stem")
    def stem(jid: str, authorization: str | None = Header(None)):
        """The AI vocal stem used, for evaluating separation quality."""
        auth(authorization)
        st = job(jid)
        return done_file(jid, store.song_dir(st["sha"]) / "vocal.wav", "audio/wav", f"vocal-{st['sha'][:12]}.wav")

    @api.get("/reworks/{jid}/analysis")
    def analysis(jid: str, authorization: str | None = Header(None)):
        auth(authorization)
        st = job(jid)
        p = store.song_dir(st["sha"]) / "analysis.json"
        if not p.exists():
            raise HTTPException(409, "no analysis yet")
        return json.loads(p.read_text())

    @api.post("/reworks/{jid}/new-beat", status_code=202)
    def new_beat(jid: str, seed: int | None = Form(None), authorization: str | None = Header(None)):
        auth(authorization)
        st = job(jid)
        if st.get("state") != "done":
            raise HTTPException(409, f"rework is {st.get('state')}")
        if not store.cached(st["sha"]):
            raise HTTPException(409, "no cached vocal and analysis for this song")
        child = create_job(store, st["sha"], st["style"], seed, st.get("pitch", "natural"), parent=jid)
        submit(child)
        return {"id": child, "state": "queued", "parent": jid, "reuses_vocal_and_analysis": True}

    return api
