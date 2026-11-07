"""Read and check eval/songs.csv. Shared by approve.py and run_eval.py.

Required per song (write `unknown` for a value you don't know; a blank cell is treated as "forgot"):
    file             audio file name in eval/songs/ (WAV, AIFF, FLAC or MP3)
    rights_basis     why you may use it, e.g. "I own master and publishing", "written permission from X, 3 Nov 2026"
    bpm              true tempo
    first_downbeat_s time in seconds of the first downbeat (beat 1 of the first full bar)
    key              e.g. A minor, Am, F# major

Optional: style (default pawsa), title, artist, chords (one per bar from the first downbeat, e.g. "Am F C G"),
rights_confirmed_by, notes.
"""
from __future__ import annotations

import csv
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import metrics  # noqa: E402

EVAL = Path(__file__).resolve().parent
SONGS = EVAL / "songs"
AUDIO_OK = {".wav", ".aif", ".aiff", ".flac", ".mp3"}
STYLES = {"peak", "bounce", "minimal", "melodic", "afro", "speedg", "bibi", "pawsa", "cruz", "beltran", "rossi",
          "lukedean", "maxdean", "baker", "prospa", "stussy", "vocal", "deep", "piano"}
ALIASES = {"truth_bpm": "bpm", "truth_first_downbeat_s": "first_downbeat_s", "truth_key": "key", "truth_chords": "chords"}


def _resolve(name: str) -> Path:
    p = Path(name).expanduser()
    if p.is_absolute():
        return p
    for base in (SONGS, EVAL):
        if (base / name).exists():
            return base / name
    return SONGS / name


def load(path: Path) -> list[dict]:
    """Return normalised rows, or print every problem and exit without running anything."""
    if not path.exists():
        sys.exit(f"STOPPED: {path} not found. Copy eval/songs.template.csv to eval/songs.csv and fill it in.")
    with open(path, newline="", encoding="utf-8-sig") as f:
        raw = [r for r in csv.DictReader(f) if any((v or "").strip() for v in r.values())]
    if not raw:
        sys.exit(f"STOPPED: {path} has no songs yet. Add one row per song (see eval/songs.template.csv).")
    problems, rows, ids = [], [], set()
    for i, r in enumerate(raw, 2):
        r = {(k or "").strip(): (v or "").strip() for k, v in r.items()}
        for old, new in ALIASES.items():                  # accept the older column names too
            if r.get(old) and not r.get(new): r[new] = r[old]
        tag = f"line {i} ({r.get('file') or 'no file'})"
        f = _resolve(r.get("file", "")) if r.get("file") else None
        if not f: problems.append(f"{tag}: file is empty")
        elif not f.exists(): problems.append(f"{tag}: not found: {f}")
        elif f.suffix.lower() not in AUDIO_OK:
            problems.append(f"{tag}: {f.suffix} files are not supported (the render engine cannot reliably decode M4A/AAC). "
                            f"Convert it in Terminal: afconvert -f WAVE -d LEI16 \"{f.name}\" \"{f.stem}.wav\"  (run inside eval/songs)")
        if not r.get("rights_basis"): problems.append(f"{tag}: rights_basis is empty")
        for k in ("bpm", "first_downbeat_s"):
            v = r.get(k, "")
            if not v: problems.append(f"{tag}: {k} is empty (write the value, or unknown)")
            elif v.lower() != "unknown":
                try:
                    if float(v) < 0 or (k == "bpm" and not 40 <= float(v) <= 250): raise ValueError
                except ValueError: problems.append(f"{tag}: {k} '{v}' is not a sensible number")
        k = r.get("key", "")
        if not k: problems.append(f"{tag}: key is empty (write e.g. A minor, or unknown)")
        else:
            try: metrics.parse_key(k)
            except ValueError as e: problems.append(f"{tag}: {e}")
        for c in r.get("chords", "").split():
            try: metrics.parse_chord(c)
            except ValueError as e: problems.append(f"{tag}: {e}")
        style = r.get("style") or "pawsa"
        if style not in STYLES: problems.append(f"{tag}: unknown style '{style}' (choose from {', '.join(sorted(STYLES))})")
        sid = re.sub(r"[^a-z0-9]+", "-", Path(r.get("file", f"song{i}")).stem.lower()).strip("-")[:40] or f"song{i}"
        base, n = sid, 2
        while sid in ids: sid, n = f"{base}-{n}", n + 1
        ids.add(sid)
        unk = lambda v: "" if v.lower() == "unknown" else v
        rows.append({"id": sid, "file": r.get("file", ""), "_path": str(f) if f else "", "title": r.get("title") or Path(r.get("file", "")).stem,
                     "artist": r.get("artist", ""), "rights_basis": r.get("rights_basis", ""),
                     "rights_confirmed_by": r.get("rights_confirmed_by") or "not stated", "style": style,
                     "truth_bpm": unk(r.get("bpm", "")), "truth_first_downbeat_s": unk(r.get("first_downbeat_s", "")),
                     "truth_key": unk(r.get("key", "")), "truth_chords": r.get("chords", "")})
    if problems:
        print(f"Problems in {path.name} (nothing was run):\n  " + "\n  ".join(problems))
        sys.exit(2)
    return rows
