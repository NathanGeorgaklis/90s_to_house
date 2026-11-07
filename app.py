"""HTTP API for the AI house rework service.

    POST /reworks                 upload a song + style -> job id
    GET  /reworks/{id}            status + report
    GET  /reworks/{id}/audio      finished WAV
    POST /reworks/{id}/new-beat   same vocal, new unique beat (no second AI separation)
    GET  /styles                  available styles

Rights check: uploads are refused unless REWORK_ALLOW_UNVERIFIED_UPLOADS=1. That switch exists for internal testing
with songs you hold rights to. A public deployment must replace `rights_check` with audio fingerprinting against
cleared catalogue before it accepts uploads.
"""
from __future__ import annotations

import json
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

import pipeline

DATA = Path(os.environ.get("REWORK_DATA_DIR", Path(__file__).resolve().parent / "data" / "jobs"))
USE_AI = os.environ.get("REWORK_USE_AI", "1") == "1"
MAX_UPLOAD_MB = int(os.environ.get("REWORK_MAX_UPLOAD_MB", "60"))
app = FastAPI(title="AI House Rework API", version="0.1.0")
pool = ThreadPoolExecutor(max_workers=int(os.environ.get("REWORK_WORKERS", "1")))
lock = threading.Lock()


def rights_check(path: Path) -> tuple[bool, str]:
    """Fail closed. Replace with fingerprint matching against cleared catalogue before any public use."""
    if os.environ.get("REWORK_ALLOW_UNVERIFIED_UPLOADS") == "1":
        return True, "unverified upload allowed by REWORK_ALLOW_UNVERIFIED_UPLOADS (internal testing only)"
    return False, "rights check not configured: uploads are refused until fingerprinting against cleared catalogue is in place"


def _job_dir(job_id: str) -> Path:
    d = DATA / job_id
    if not d.is_dir() or not (d / "status.json").exists():
        raise HTTPException(404, "no such rework")
    return d


def _write_status(d: Path, **kv) -> None:
    with lock:
        p = d / "status.json"
        cur = json.loads(p.read_text()) if p.exists() else {}
        cur.update(kv)
        p.write_text(json.dumps(cur, indent=2))


def _run(d: Path, style: str, seed: int | None, pitch: str, reuse_vocal: str | None = None) -> None:
    _write_status(d, state="running", stage="separating vocal" if (USE_AI and not reuse_vocal) else "rendering")
    try:
        res = pipeline.rework(d / "song", style, d / "rework.wav", use_ai=USE_AI, vocal_path=reuse_vocal, seed=seed,
                              pitch=pitch, work_dir=d)
        _write_status(d, state="done", stage="done", report=res.report,
                      vocal=str(res.vocal_path) if res.vocal_path else None)
    except Exception as e:  # report the failing stage; never return a half-made file
        (d / "rework.wav").unlink(missing_ok=True)
        _write_status(d, state="failed", stage="failed", error=str(e))


@app.get("/styles")
def styles():
    return {"styles": pipeline.STYLES}


@app.post("/reworks", status_code=202)
async def create(file: UploadFile = File(...), style: str = Form("pawsa"), seed: int | None = Form(None),
                 pitch: str = Form("natural")):
    if style not in pipeline.STYLES:
        raise HTTPException(422, f"unknown style; choose one of {pipeline.STYLES}")
    data = await file.read()
    if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"file over {MAX_UPLOAD_MB} MB")
    if not data:
        raise HTTPException(422, "empty file")
    job_id = uuid.uuid4().hex[:12]
    d = DATA / job_id
    d.mkdir(parents=True)
    (d / "song").write_bytes(data)
    ok, why = rights_check(d / "song")
    if not ok:
        (d / "song").unlink()
        d.rmdir()
        raise HTTPException(403, why)
    _write_status(d, id=job_id, state="queued", stage="queued", style=style, rights=why, filename=file.filename)
    pool.submit(_run, d, style, seed, pitch)
    return {"id": job_id, "state": "queued"}


@app.get("/reworks/{job_id}")
def status(job_id: str):
    return json.loads((_job_dir(job_id) / "status.json").read_text())


@app.get("/reworks/{job_id}/audio")
def audio(job_id: str):
    d = _job_dir(job_id)
    st = json.loads((d / "status.json").read_text())
    if st.get("state") != "done":
        raise HTTPException(409, f"rework is {st.get('state')}")
    return FileResponse(d / "rework.wav", media_type="audio/wav", filename=f"rework-{job_id}.wav")


@app.post("/reworks/{job_id}/new-beat", status_code=202)
def new_beat(job_id: str, seed: int | None = Form(None)):
    d = _job_dir(job_id)
    st = json.loads((d / "status.json").read_text())
    if st.get("state") != "done":
        raise HTTPException(409, f"rework is {st.get('state')}")
    vocal = st.get("vocal")
    _write_status(d, state="queued", stage="queued", report=None)
    pool.submit(_run, d, st["style"], seed, "natural", vocal)
    return {"id": job_id, "state": "queued", "reuses_vocal": bool(vocal)}
