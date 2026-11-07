"""AI house rework pipeline.

    song + style  ->  AI vocal separation (BS-RoFormer)  ->  analysis + unique beat + arrangement + render (Node engine)

The AI stage runs in Python (PyTorch, audio-separator). Everything after it runs in the shared production engine
(engine/rework-engine.js), the same code the browser app uses, so a rework sounds the same in both places.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ENGINE = ROOT / "engine" / "render.js"
# BS-RoFormer vocal model (viperx weights), ~12.97 dB vocal SDR. Confirm the checkpoint's licence before commercial use.
DEFAULT_MODEL = os.environ.get("REWORK_SEPARATION_MODEL", "model_bs_roformer_ep_317_sdr_12.9755.ckpt")
MODEL_DIR = Path(os.environ.get("REWORK_MODEL_DIR", ROOT / "models"))
STYLES = ["peak", "bounce", "minimal", "melodic", "afro", "speedg", "bibi", "pawsa", "cruz", "beltran", "rossi",
          "lukedean", "maxdean", "baker", "prospa", "stussy", "vocal", "deep", "piano"]


class ReworkError(RuntimeError):
    """A stage failed. The message says which stage and why."""


@dataclass
class ReworkResult:
    audio_path: Path
    vocal_path: Path | None
    report: dict = field(default_factory=dict)


def separate_vocal(mix_path: Path, work_dir: Path, model: str = DEFAULT_MODEL) -> Path:
    """Run the AI separation model and return the path of the vocal stem (WAV)."""
    try:
        from audio_separator.separator import Separator
    except ImportError as e:  # fail closed: never silently fall back
        raise ReworkError(f"vocal separation unavailable: audio-separator is not installed ({e})") from e
    out_dir = work_dir / "stems"
    out_dir.mkdir(parents=True, exist_ok=True)
    sep = Separator(output_dir=str(out_dir), model_file_dir=str(MODEL_DIR), output_single_stem="Vocals", output_format="WAV")
    sep.load_model(model_filename=model)
    files = sep.separate(str(mix_path))
    vocal = [out_dir / Path(f).name for f in files if "vocal" in Path(f).name.lower()]
    if not vocal or not vocal[0].exists():
        raise ReworkError(f"vocal separation produced no vocal stem (got {files})")
    return vocal[0]


def render(mix_path: Path, vocal_path: Path | None, style: str, out_path: Path, *, seed: int | None = None,
           pitch: str = "natural", intro: int = 8, outro: int = 8, trim: bool = True, timeout_s: int = 900) -> dict:
    """Run the Node production engine. Returns its report (tempo, key, chords, arrangement, beat code, timings)."""
    if style not in STYLES:
        raise ReworkError(f"unknown style '{style}'; choose one of {', '.join(STYLES)}")
    if shutil.which("node") is None:
        raise ReworkError("render unavailable: Node.js is not installed")
    with tempfile.TemporaryDirectory() as tmp:
        job = {"mix": str(mix_path), "vocal": str(vocal_path) if vocal_path else None, "style": style, "seed": seed,
               "pitch": pitch, "intro": intro, "outro": outro, "trim": trim, "out": str(out_path),
               "report": str(Path(tmp) / "report.json")}
        job_path = Path(tmp) / "job.json"
        job_path.write_text(json.dumps(job))
        p = subprocess.run(["node", str(ENGINE), str(job_path)], capture_output=True, text=True, timeout=timeout_s,
                           cwd=str(ENGINE.parent))
        if p.returncode != 0:
            msg = p.stderr.strip().splitlines()[-1] if p.stderr.strip() else "no error output"
            raise ReworkError(f"render failed: {msg}")
        return json.loads(Path(job["report"]).read_text())


def rework(mix_path: str | Path, style: str, out_path: str | Path, *, use_ai: bool = True, vocal_path: str | Path | None = None,
           seed: int | None = None, pitch: str = "natural", work_dir: str | Path | None = None) -> ReworkResult:
    """Full pipeline. use_ai=False uses the engine's built-in DSP extraction (lower quality, no GPU needed).
    vocal_path reuses a vocal stem from an earlier run (used by 'new beat': no second separation)."""
    mix_path, out_path = Path(mix_path), Path(out_path)
    if not mix_path.exists():
        raise ReworkError(f"song file not found: {mix_path}")
    work = Path(work_dir) if work_dir else out_path.parent
    work.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    vocal = Path(vocal_path) if vocal_path else None
    sep_s = 0.0
    if vocal is None and use_ai:
        s = time.time()
        vocal = separate_vocal(mix_path, work)
        sep_s = time.time() - s
    report = render(mix_path, vocal, style, out_path, seed=seed, pitch=pitch)
    report["timings_ms"]["separation_ms"] = round(sep_s * 1000)
    report["timings_ms"]["total_ms"] = round((time.time() - t0) * 1000)
    report["separation_model"] = DEFAULT_MODEL if (use_ai and not vocal_path) else ("reused stem" if vocal_path else "dsp-fallback")
    return ReworkResult(out_path, vocal, report)


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Rework a song as house music in a chosen style.")
    ap.add_argument("song"); ap.add_argument("--style", default="pawsa", choices=STYLES)
    ap.add_argument("--out", default="rework.wav"); ap.add_argument("--seed", type=int)
    ap.add_argument("--pitch", default="natural", help="natural, -2..2, or tempo")
    ap.add_argument("--no-ai", action="store_true", help="skip AI separation (DSP fallback)")
    ap.add_argument("--vocal", help="reuse an existing vocal stem")
    a = ap.parse_args()
    r = rework(a.song, a.style, a.out, use_ai=not a.no_ai, vocal_path=a.vocal, seed=a.seed, pitch=a.pitch)
    print(json.dumps(r.report, indent=2))
