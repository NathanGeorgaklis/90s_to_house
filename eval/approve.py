"""Record rights approvals for every song in eval/songs.csv in the DEPLOYED app.

    bash rework.sh approve

Each approval stores the file's SHA-256, its rights basis and who confirmed it. The API refuses any upload whose
exact audio file is not approved. The manifest is checked in full first; nothing is approved if anything is missing.
"""
from __future__ import annotations

import argparse
import hashlib
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import manifest  # noqa: E402

APP_NAME = "ai-house-rework"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default=str(Path(__file__).resolve().parent / "songs.csv"))
    a = ap.parse_args()
    rows = manifest.load(Path(a.manifest))
    entries = {}
    for r in rows:
        sha = hashlib.sha256(Path(r["_path"]).read_bytes()).hexdigest()
        entries[sha] = {"title": r["title"], "artist": r["artist"], "file": r["file"], "rights_basis": r["rights_basis"],
                        "confirmed_by": r["rights_confirmed_by"], "approved_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    import modal
    try:
        fn = modal.Function.from_name(APP_NAME, "write_approvals")
        total = fn.remote(entries)
    except Exception as e:
        sys.exit(f"STOPPED: could not reach the deployed app ({type(e).__name__}: {e}). Run: bash rework.sh deploy")
    print(f"APPROVED {len(entries)} songs (approvals on file: {total})")


if __name__ == "__main__":
    main()
