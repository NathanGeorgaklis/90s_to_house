"""Unit tests for the evaluation measurements."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "eval"))
import metrics as M
import pytest

def test_parse_key_forms():
    assert M.parse_key("A minor") == (9, "minor") and M.parse_key("Am") == (9, "minor")
    assert M.parse_key("F# major") == (6, "major") and M.parse_key("Eb") == (3, "major") and M.parse_key("Bbm") == (10, "minor")
    assert M.parse_key("unknown") is None and M.parse_key("") is None
    with pytest.raises(ValueError): M.parse_key("H dorian")

def test_tempo_octave_and_exact():
    assert M.tempo_check(100.0, 100.4)["tempo_ok"]
    r = M.tempo_check(60.0, 120.0); assert not r["tempo_ok"] and r["tempo_octave_error"] and r["tempo_relation"] == "double"
    assert not M.tempo_check(110.0, 100.0)["tempo_ok"]

def test_downbeat_wrong_beat_detected():
    r = M.downbeat_check(0.6 + 0.5, 0.5, 100)   # one beat (0.6 s) late: beat grid right, bar start wrong
    assert not r["downbeat_ok"] and r["downbeat_wrong_beat"]
    assert M.downbeat_check(0.51, 0.5, 100)["downbeat_ok"]

def test_key_relations():
    assert M.key_check({"pc": 9, "mode": "minor", "name": "A minor"}, (0, "major"))["key_relation"] == "relative"
    assert M.key_check({"pc": 7, "mode": "major", "name": "G major"}, (0, "major"))["key_relation"] == "fifth"
    assert M.key_check({"pc": 2, "mode": "major", "name": "D major"}, (0, "major"))["key_relation"] == "wrong"

def test_chord_accuracy():
    det = [{"pc": 0, "q": "maj"}, {"pc": 9, "q": "min"}, {"pc": 5, "q": "maj"}, {"pc": 2, "q": "maj"}]
    r = M.chord_check(det, ["C", "Am", "F", "G"]); assert r["chord_bar_accuracy"] == 0.75 and r["chords_ok"]

def test_audio_indicators_on_test_clip():
    here = Path(__file__).parent
    s = M.stem_indicators(str(here / "real_voice_true_vocal.wav"))
    mix = M.stem_indicators(str(here / "real_voice_mix.wav"))
    ai = M.stem_indicators("/tmp/real/stems/real_mix_(Vocals)_model_bs_roformer_ep_317_sdr_12.wav") if Path("/tmp/real/stems").exists() else None
    assert s["stem_floor_db"] < -40 and not s["stem_floor_flag"]      # clean voice: gaps are silent
    assert mix["stem_floor_db"] > -20 and mix["stem_floor_flag"]      # full mix: backing keeps the floor up
    if ai: assert ai["stem_floor_db"] < -40 and not ai["stem_floor_flag"]   # AI stem measured at 20.8 dB SDR: passes
    m = M.master_indicators(str(here / "real_voice_mix.wav"))
    assert -40 < m["lufs_integrated"] < 0 and m["true_peak_dbtp"] < 1
