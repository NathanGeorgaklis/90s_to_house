"""API tests on the synthetic song with the DSP fallback (no GPU, no model download)."""
import importlib, os, time
from pathlib import Path
from fastapi.testclient import TestClient

SONG = Path(__file__).with_name("synth_mix.wav").read_bytes()


def client(tmp_path, allow=False, key=None):
    os.environ["REWORK_DATA_DIR"] = str(tmp_path)
    os.environ["REWORK_USE_AI"] = "0"
    os.environ.pop("MODAL_TASK_ID", None)
    for k, v in (("REWORK_ALLOW_UNVERIFIED_UPLOADS", "1" if allow else None), ("REWORK_API_KEY", key)):
        if v is None: os.environ.pop(k, None)
        else: os.environ[k] = v
    import app; importlib.reload(app)
    return TestClient(app.app), app


def wait(c, jid, headers=None, timeout=240):
    t = time.time()
    while time.time() - t < timeout:
        s = c.get(f"/reworks/{jid}", headers=headers or {}).json()
        if s["state"] in ("done", "failed"): return s
        time.sleep(1)
    raise AssertionError("timed out")


def test_rights_gate_refuses_unapproved_and_stores_nothing(tmp_path):
    c, _ = client(tmp_path)
    r = c.post("/reworks", files={"file": ("s.wav", SONG)}, data={"style": "pawsa"})
    assert r.status_code == 403 and "rights check" in r.json()["detail"]
    assert not (tmp_path / "songs").exists() and not (tmp_path / "jobs").exists()


def test_unverified_switch_is_ignored_on_modal(tmp_path):
    c, _ = client(tmp_path, allow=True)
    os.environ["MODAL_TASK_ID"] = "ta-test"          # pretend we are inside Modal
    try:
        assert c.post("/reworks", files={"file": ("s.wav", SONG)}, data={"style": "pawsa"}).status_code == 403
    finally:
        os.environ.pop("MODAL_TASK_ID")


def test_approved_hash_is_accepted(tmp_path):
    c, app = client(tmp_path)
    sha = app.service.sha256_bytes(SONG)
    app.store.set_approved({sha: {"title": "synthetic", "rights_basis": "generated test audio", "confirmed_by": "test"}})
    r = c.post("/reworks", files={"file": ("s.wav", SONG)}, data={"style": "afro", "seed": "3"})
    assert r.status_code == 202 and r.json()["sha256"] == sha
    assert wait(c, r.json()["id"])["state"] == "done"
    other = c.post("/reworks", files={"file": ("s.wav", SONG + b"\0")}, data={"style": "afro"})
    assert other.status_code == 403                   # a different file is not covered by the approval


def test_api_key_required_when_set(tmp_path):
    c, _ = client(tmp_path, allow=True, key="k123")
    assert c.get("/styles").status_code == 401
    assert c.get("/styles", headers={"Authorization": "Bearer k123"}).status_code == 200


def test_rework_metrics_stem_and_new_beat(tmp_path):
    c, _ = client(tmp_path, allow=True)
    jid = c.post("/reworks", files={"file": ("s.wav", SONG)}, data={"style": "pawsa", "seed": "111"}).json()["id"]
    s = wait(c, jid)
    assert s["state"] == "done", s.get("error")
    m = s["metrics"]
    for k in ("total_wall_s", "gpu_billed_s", "cpu_billed_s", "song_seconds", "rtf_total", "cost_total_usd"):
        assert k in m, k
    assert m["separation_cached"] is False and s["report"]["song"]["bpm"] == 100
    assert c.get(f"/reworks/{jid}/audio").content[:4] == b"RIFF"
    assert c.get(f"/reworks/{jid}/stem").content[:4] == b"RIFF"
    assert c.get(f"/reworks/{jid}/analysis").json()["srcBpm"] == 100
    nb = c.post(f"/reworks/{jid}/new-beat", data={"seed": "222"}).json()
    assert nb["parent"] == jid and nb["id"] != jid
    s2 = wait(c, nb["id"])
    assert s2["state"] == "done"
    assert s2["metrics"]["separation_cached"] is True and s2["metrics"]["gpu_billed_s"] == 0.0
    assert s2["report"]["analysis_cached"] is True
    assert s2["report"]["beat_code"] != s["report"]["beat_code"]
    assert s2["report"]["song"] == s["report"]["song"]


def test_corrupt_file_records_failed_stage(tmp_path):
    c, _ = client(tmp_path, allow=True)
    jid = c.post("/reworks", files={"file": ("s.wav", b"not audio at all" * 100)}, data={"style": "afro"}).json()["id"]
    s = wait(c, jid)
    assert s["state"] == "failed" and s["failed_stage"] and "render failed" in s["error"]
    assert c.get(f"/reworks/{jid}/audio").status_code == 409
