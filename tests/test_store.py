"""Regression: status reads must never see a half-written file while a job is updating it."""
import json, threading
from pathlib import Path
import service

def test_concurrent_status_reads_never_see_partial_writes(tmp_path):
    st = service.Store(tmp_path)
    st.write_status("j1", id="j1", state="queued", report={"pad": "x" * 200_000})
    errors, stop = [], threading.Event()
    def writer():
        for i in range(300):
            st.write_status("j1", stage=f"step {i}", report={"pad": "y" * 200_000, "i": i})
        stop.set()
    def reader():
        while not stop.is_set():
            try: st.status("j1")
            except (json.JSONDecodeError, KeyError) as e: errors.append(repr(e))
    ts = [threading.Thread(target=writer)] + [threading.Thread(target=reader) for _ in range(3)]
    for t in ts: t.start()
    for t in ts: t.join()
    assert errors == [], errors[:3]
    assert not list(Path(tmp_path, "jobs", "j1").glob(".*.tmp"))       # no temp files left behind
