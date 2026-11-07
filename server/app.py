"""Local development server: the same API and job logic as the Modal deployment (service.py),
with both stages run in-process by pipeline.py.

    REWORK_ALLOW_UNVERIFIED_UPLOADS=1 uvicorn app:app --port 8000      # internal testing only
    REWORK_USE_AI=0 ...                                                  # DSP fallback, no model download

The rights gate is unchanged: uploads are refused unless the file's SHA-256 is approved
(rights/approved.json) or REWORK_ALLOW_UNVERIFIED_UPLOADS=1 is set on a local machine.
"""
from __future__ import annotations

import os
import shutil
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pipeline
import service

BASE = Path(os.environ.get("REWORK_DATA_DIR", Path(__file__).resolve().parent / "data"))
USE_AI = os.environ.get("REWORK_USE_AI", "1") == "1"
store = service.Store(BASE)
pool = ThreadPoolExecutor(max_workers=int(os.environ.get("REWORK_WORKERS", "1")))


class LocalRunner:
    """Runs both stages in this process. Billed seconds = wall time (no containers locally)."""

    def separate(self, sha: str) -> dict:
        d = store.song_dir(sha)
        t = time.time()
        if USE_AI:
            stem = pipeline.separate_vocal(d / "song", d / "work")
            shutil.move(str(stem), d / "vocal.wav")
        # without AI the render step writes the DSP vocal it used as vocal.wav (see render below)
        s = time.time() - t
        return {"billed_s": s, "separation_s": s, "model_load_s": 0.0, "cold_start": False}

    def render(self, sha, jid, style, seed, pitch, cached):
        d, j = store.song_dir(sha), store.job_dir(jid)
        t = time.time()
        vocal = d / "vocal.wav" if (d / "vocal.wav").exists() else None
        kw = {"analysis_in": d / "analysis.json"} if cached else {"analysis_out": d / "analysis.json",
                                                                   "vocal_out": None if vocal else d / "vocal.wav"}
        report = pipeline.render(d / "song", vocal, style, j / "rework.wav", seed=seed, pitch=pitch, **kw)
        return report, {"billed_s": time.time() - t, "cold_start": False}


runner = LocalRunner()
app = service.make_api(store, submit=lambda jid: pool.submit(service.process_job, store, runner, jid),
                       require_key=False)
