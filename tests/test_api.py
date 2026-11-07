"""API tests on the synthetic song, using the DSP fallback (no GPU) so they run anywhere in about a minute."""
import importlib, os, time
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

SONG = Path(__file__).with_name("synth_mix.wav").read_bytes()

def client(tmp_path, allow):
    os.environ["REWORK_DATA_DIR"] = str(tmp_path)
    os.environ["REWORK_USE_AI"] = "0"
    if allow: os.environ["REWORK_ALLOW_UNVERIFIED_UPLOADS"] = "1"
    else: os.environ.pop("REWORK_ALLOW_UNVERIFIED_UPLOADS", None)
    import app; importlib.reload(app)
    return TestClient(app.app)

def wait(c, jid, timeout=240):
    t = time.time()
    while time.time() - t < timeout:
        s = c.get(f"/reworks/{jid}").json()
        if s["state"] in ("done", "failed"): return s
        time.sleep(1)
    raise AssertionError("timed out")

def test_rights_check_fails_closed(tmp_path):
    c = client(tmp_path, allow=False)
    r = c.post("/reworks", files={"file": ("s.wav", SONG)}, data={"style": "pawsa"})
    assert r.status_code == 403 and "rights check" in r.json()["detail"]
    assert list(tmp_path.iterdir()) == []          # nothing kept from a refused upload

def test_unknown_style_and_empty_file(tmp_path):
    c = client(tmp_path, allow=True)
    assert c.post("/reworks", files={"file": ("s.wav", SONG)}, data={"style": "nope"}).status_code == 422
    assert c.post("/reworks", files={"file": ("s.wav", b"")}, data={"style": "pawsa"}).status_code == 422

def test_rework_then_new_beat(tmp_path):
    c = client(tmp_path, allow=True)
    r = c.post("/reworks", files={"file": ("s.wav", SONG)}, data={"style": "pawsa", "seed": "111"})
    assert r.status_code == 202
    jid = r.json()["id"]
    s = wait(c, jid)
    assert s["state"] == "done", s.get("error")
    rep = s["report"]
    assert rep["song"]["bpm"] == 100 and rep["beat_code"] and rep["rework"]["seconds"] > 30
    a = c.get(f"/reworks/{jid}/audio"); assert a.status_code == 200 and a.content[:4] == b"RIFF"
    first_code = rep["beat_code"]
    assert c.post(f"/reworks/{jid}/new-beat", data={"seed": "222"}).status_code == 202
    s2 = wait(c, jid)
    assert s2["state"] == "done" and s2["report"]["beat_code"] != first_code

def test_corrupt_file_reports_failure(tmp_path):
    c = client(tmp_path, allow=True)
    jid = c.post("/reworks", files={"file": ("s.wav", b"not audio at all" * 100)}, data={"style": "afro"}).json()["id"]
    s = wait(c, jid)
    assert s["state"] == "failed" and "render failed" in s["error"]
    assert c.get(f"/reworks/{jid}/audio").status_code == 409
