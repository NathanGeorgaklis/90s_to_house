"""Regression: 'new beat' must reuse the saved analysis and vocal, skip separation and analysis,
keep the song analysis identical, and change the beat. Same seed + same cache must reproduce the same audio."""
from pathlib import Path
import numpy as np, soundfile as sf
import pipeline

SONG = Path(__file__).with_name("synth_mix.wav")

def test_new_beat_reuses_analysis(tmp_path):
    an, voc = tmp_path / "analysis.json", tmp_path / "vocal.wav"
    first = pipeline.render(SONG, None, "pawsa", tmp_path / "a.wav", seed=111, analysis_out=an, vocal_out=voc)
    assert an.exists() and voc.exists() and first["analysis_cached"] is False
    second = pipeline.render(SONG, voc, "pawsa", tmp_path / "b.wav", seed=222, analysis_in=an)
    assert second["analysis_cached"] is True
    for skipped in ("decode_ms", "tempo_ms", "mix_analysis_ms", "vocal_analysis_ms"):
        assert skipped not in second["timings_ms"], skipped
    assert second["song"] == first["song"]                      # identical analysis
    assert second["beat_code"] != first["beat_code"]            # new beat
    assert (tmp_path / "b.wav").stat().st_size > 1000

def test_cached_render_reproduces_audio(tmp_path):
    an, voc = tmp_path / "analysis.json", tmp_path / "vocal.wav"
    pipeline.render(SONG, None, "afro", tmp_path / "x.wav", seed=5, analysis_out=an, vocal_out=voc)
    pipeline.render(SONG, voc, "afro", tmp_path / "y.wav", seed=5, analysis_in=an)
    pipeline.render(SONG, voc, "afro", tmp_path / "z.wav", seed=5, analysis_in=an)
    y, _ = sf.read(tmp_path / "y.wav"); z, _ = sf.read(tmp_path / "z.wav")
    assert y.shape == z.shape and np.max(np.abs(y - z)) < 1e-3    # deterministic for a beat code
