"""Objective measurements for one evaluated song.

Vocal-to-beat alignment has no automatic measure here (see eval/NOTES.md): it is judged by the tempo and
downbeat checks against truth, which drive alignment in this pipeline, and by the listener.

Accuracy checks (tempo, downbeat, key, chords) compare the pipeline's analysis against ground truth that was
written into the manifest BEFORE the run. Separation and alignment have no ground truth for real songs, so those
numbers are indicators that sit beside the human listening ratings; they never replace them.

Screening thresholds below are uncalibrated starting points, documented here so a result can be traced.
Recalibrate them once enough human ratings exist.
"""
from __future__ import annotations

import math
import re

import numpy as np
import soundfile as sf

NOTES = {"C": 0, "C#": 1, "DB": 1, "D": 2, "D#": 3, "EB": 3, "E": 4, "F": 5, "F#": 6, "GB": 6, "G": 7, "G#": 8, "AB": 8,
         "A": 9, "A#": 10, "BB": 10, "B": 11}
THRESHOLDS = {  # uncalibrated screening thresholds
    "tempo_err_pct": 2.0,          # detected vs true BPM, after allowing double/half
    "downbeat_err_ms": 60.0,       # first downbeat position error, modulo one bar
    "chord_bar_accuracy": 0.6,     # share of bars whose detected chord matches the truth
    "stem_floor_db": -30.0,        # quietest vs loudest 0.25 s windows of the vocal stem (bleed keeps the floor up)
    "master_lufs_min": -11.0,      # club masters usually sit around -9 to -6 LUFS integrated
    "true_peak_max_dbtp": -0.3,
}


# ---------------------------------------------------------------- parsing
def parse_key(s: str) -> tuple[int, str] | None:
    """'A minor', 'Am', 'F# maj', 'Eb' -> (pitch class, 'major'|'minor'). None if blank/unknown."""
    if not s or s.strip().lower() in ("unknown", "?", "n/a"):
        return None
    m = re.match(r"^\s*([A-Ga-g])([#b♯♭]?)\s*(m(?!aj)|min|minor|maj|major)?\s*$", s.strip())
    if not m:
        raise ValueError(f"cannot read key '{s}' (examples: 'A minor', 'Am', 'F# major')")
    name = (m.group(1) + m.group(2).replace("♯", "#").replace("♭", "b")).upper()
    mode = "minor" if (m.group(3) or "").lower() in ("m", "min", "minor") else "major"
    return NOTES[name], mode


def parse_chord(s: str) -> tuple[int, str]:
    k = parse_key(s if not s.endswith("7") else s[:-1])
    if k is None:
        raise ValueError(f"cannot read chord '{s}'")
    return k


# ---------------------------------------------------------------- accuracy vs truth
def tempo_check(detected: float, truth: float) -> dict:
    cands = {"same": detected, "double": detected * 2, "half": detected / 2}
    rel, err = min(((k, abs(v - truth) / truth * 100) for k, v in cands.items()), key=lambda x: x[1])
    return {"tempo_detected": detected, "tempo_truth": truth, "tempo_err_pct": round(err, 2), "tempo_relation": rel,
            "tempo_ok": err <= THRESHOLDS["tempo_err_pct"] and rel == "same",
            "tempo_octave_error": err <= THRESHOLDS["tempo_err_pct"] and rel != "same"}


def downbeat_check(detected_s: float, truth_s: float, bpm_truth: float) -> dict:
    beat = 60.0 / bpm_truth
    bar = 4 * beat
    d = (detected_s - truth_s) % bar
    d = min(d, bar - d)                                   # circular error within one bar
    beat_err = (detected_s - truth_s) % beat
    beat_err = min(beat_err, beat - beat_err)
    return {"downbeat_err_ms": round(d * 1000, 1), "beat_phase_err_ms": round(beat_err * 1000, 1),
            "downbeat_ok": d * 1000 <= THRESHOLDS["downbeat_err_ms"],
            # beat grid right but bar start on the wrong beat (fixable with "move bar start")
            "downbeat_wrong_beat": beat_err * 1000 <= THRESHOLDS["downbeat_err_ms"] < d * 1000}


def key_check(detected: dict, truth: tuple[int, str]) -> dict:
    dpc, dmode = detected["pc"], detected["mode"]
    tpc, tmode = truth
    if (dpc, dmode) == (tpc, tmode): rel = "exact"
    elif dmode != tmode and ((tmode == "major" and dpc == (tpc + 9) % 12) or (tmode == "minor" and dpc == (tpc + 3) % 12)): rel = "relative"
    elif dmode == tmode and (dpc - tpc) % 12 in (5, 7): rel = "fifth"
    elif dpc == tpc: rel = "parallel"
    else: rel = "wrong"
    return {"key_detected": detected.get("name"), "key_relation": rel, "key_ok": rel in ("exact", "relative")}


def chord_check(detected: list[dict], truth: list[str], bar_shift: int = 0) -> dict:
    """Per-bar chord accuracy. Detected bar i is truth bar i + bar_shift (the two lists may start at different bars)."""
    pairs = [(d, truth[i + bar_shift]) for i, d in enumerate(detected) if 0 <= i + bar_shift < len(truth)]
    n = len(pairs)
    if n == 0:
        return {}
    hits = sum(1 for d, t in pairs if (d["pc"], "minor" if d["q"] == "min" else "major") == parse_chord(t))
    acc = hits / n
    return {"chord_bars_compared": n, "chord_bar_accuracy": round(acc, 3), "chords_ok": acc >= THRESHOLDS["chord_bar_accuracy"]}


# ---------------------------------------------------------------- audio indicators (no ground truth)
def _mono(x):
    return x.mean(axis=1) if x.ndim > 1 else x


def _stft_mag(x, n=2048, hop=512):
    w = np.hanning(n)
    frames = 1 + max(0, (len(x) - n) // hop)
    idx = np.arange(n)[None, :] + hop * np.arange(frames)[:, None]
    return np.abs(np.fft.rfft(x[idx] * w, axis=1))


def stem_indicators(stem_path: str) -> dict:
    """Bleed indicator for the vocal stem without ground truth: the stem's noise floor.
    Level of the quietest quarter-second windows (10th percentile) relative to the loudest (90th percentile).
    Checked on known audio: clean voice -160 dB (silent gaps), BS-RoFormer stem -50.6 dB, unseparated mix -14.5 dB.
    In a clean stem the gaps between phrases are near-silent; leaked drums or instruments keep the floor up.
    Also lists the three quietest windows so a listener can audition exactly where bleed would show."""
    x, sr = sf.read(stem_path)
    x = _mono(x).astype(np.float64)
    if np.sqrt(np.mean(x ** 2)) < 1e-5:
        return {"stem_silent": True}
    w = sr // 4
    n = len(x) // w
    if n < 16:
        return {"stem_silent": False}
    rms = np.sqrt(np.mean(x[: n * w].reshape(n, w) ** 2, axis=1)) + 1e-9
    floor_db = max(-90.0, 20 * math.log10(np.percentile(rms, 10) / np.percentile(rms, 90)))
    # three quietest windows that are not digital silence: where bleed would be audible
    audible = [i for i in np.argsort(rms) if rms[i] > 1e-6][:3]
    return {"stem_silent": False, "stem_floor_db": round(floor_db, 1),
            "stem_listen_at_s": sorted(round(i * w / sr, 2) for i in audible),
            "stem_floor_flag": floor_db > THRESHOLDS["stem_floor_db"]}


def master_indicators(wav_path: str) -> dict:
    import pyloudnorm as pyln
    from scipy.signal import resample_poly
    x, sr = sf.read(wav_path)
    if x.ndim == 1:
        x = x[:, None]
    lufs = pyln.Meter(sr).integrated_loudness(x)
    tp = 20 * math.log10(np.max(np.abs(resample_poly(x, 4, 1, axis=0))) + 1e-12)
    clipped = int(np.sum(np.abs(x) >= 0.999))
    rms = np.sqrt(np.mean(x ** 2))
    return {"lufs_integrated": round(lufs, 1), "true_peak_dbtp": round(tp, 2), "clipped_samples": clipped,
            "crest_db": round(20 * math.log10(np.max(np.abs(x)) / (rms + 1e-12)), 1),
            "loudness_ok": lufs >= THRESHOLDS["master_lufs_min"], "true_peak_ok": tp <= THRESHOLDS["true_peak_max_dbtp"]}


def _plain(v):
    """numpy scalars -> Python types, so JSON stores real booleans and numbers (np.bool_ would become the string "False")."""
    if isinstance(v, np.generic):
        return v.item()
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    return v


def measure(row: dict, status: dict, analysis: dict, paths: dict) -> dict:
    """All objective measurements for one song. `row` holds the frozen truth from the manifest."""
    out: dict = {}
    if row.get("truth_bpm"):
        out.update(tempo_check(float(analysis["srcBpm"]), float(row["truth_bpm"])))
        if row.get("truth_first_downbeat_s"):
            out.update(downbeat_check(float(analysis["offset"]), float(row["truth_first_downbeat_s"]), float(row["truth_bpm"])))
    if analysis.get("downbeatConf") is not None:
        out["downbeat_conf"] = analysis["downbeatConf"]
    tk = parse_key(row.get("truth_key", ""))
    if tk:
        out.update(key_check(analysis["songKey"], tk))
    if row.get("truth_chords", "").strip():
        shift = 0
        if row.get("truth_bpm") and row.get("truth_first_downbeat_s"):   # line the bars up in time
            bar = 4 * 60.0 / float(row["truth_bpm"])
            shift = round((float(analysis["offset"]) - float(row["truth_first_downbeat_s"])) / bar)
        out.update(chord_check(analysis["chords"], row["truth_chords"].split(), shift))
    if paths.get("stem"):
        out.update(stem_indicators(paths["stem"]))
    if paths.get("audio"):
        out.update(master_indicators(paths["audio"]))
    return {k: _plain(v) for k, v in out.items()}
