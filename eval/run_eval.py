"""Run the evaluation: every song in the manifest through the deployed API, in order.

    python eval/run_eval.py --manifest eval/songs.csv            # uses eval/.env for the API URL and key
    python eval/run_eval.py --manifest eval/songs.csv --limit 3  # a short trial

Before any inference it:
  1. validates the manifest (files exist, rights basis recorded, ground truth written), and stops if anything is missing;
  2. freezes the ground truth (eval/truth.lock). Changing truth later requires --new-truth-version "<reason>",
     which archives the old version in eval/truth_history/.

Per song it records the job status, timing and cost metrics, the analysis, the objective measurements, and
downloads the rework and the vocal stem. It then runs one "new beat" on the first song to confirm separation and
analysis are reused. Results go to eval/runs/<run-id>/; the listening scorecard is eval/runs/<run-id>/scorecard.csv.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import manifest  # noqa: E402
import metrics  # noqa: E402

EVAL = Path(__file__).resolve().parent
TRUTH_FIELDS = ["truth_bpm", "truth_first_downbeat_s", "truth_key", "truth_chords"]
HUMAN_COLUMNS = ["sep_quality_1to5", "bleed_1to5", "tempo_grid_ok_YN", "vocal_beat_alignment_1to5", "arrangement_1to5",
                 "mix_1to5", "master_1to5", "overall_1to5", "would_play_to_someone_YN", "first_failed_stage",
                 "exact_failure", "rater", "rated_at"]


def load_env(path: Path) -> None:
    if path.exists():
        for line in path.read_text().splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def freeze_truth(rows: list[dict], new_version_reason: str | None) -> dict:
    payload = [{"id": r["id"], "sha256": sha256_file(Path(r["_path"])), **{k: (r.get(k) or "").strip() for k in TRUTH_FIELDS}} for r in rows]
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    lock = EVAL / "truth.lock"
    if lock.exists():
        cur = json.loads(lock.read_text())
        if cur["sha256"] == digest:
            return cur
        if not new_version_reason:
            print("Ground truth or audio files changed since truth.lock was written. Truth must not change after "
                  "seeing results.\nIf the change is a genuine correction, rerun with --new-truth-version \"<reason>\"; "
                  "the old version is archived.")
            sys.exit(3)
        hist = EVAL / "truth_history"; hist.mkdir(exist_ok=True)
        (hist / f"truth.v{cur['version']}.lock").write_text(json.dumps(cur, indent=2))
        version = cur["version"] + 1
    else:
        version = 1
    new = {"version": version, "sha256": digest, "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
           "reason": new_version_reason or "initial truth", "rows": payload}
    lock.write_text(json.dumps(new, indent=2))
    return new


class Api:
    def __init__(self, url: str, key: str):
        self.url, self.h = url.rstrip("/"), {"Authorization": f"Bearer {key}"} if key else {}

    def submit(self, path: Path, style: str, seed: int | None):
        with open(path, "rb") as f:
            data = {"style": style}
            if seed is not None: data["seed"] = str(seed)
            return requests.post(f"{self.url}/reworks", headers=self.h, files={"file": (path.name, f)}, data=data, timeout=600)

    def status(self, jid: str) -> dict:
        r = requests.get(f"{self.url}/reworks/{jid}", headers=self.h, timeout=60); r.raise_for_status(); return r.json()

    def wait(self, jid: str, timeout_s: int = 1800) -> dict:
        t, last = time.time(), None
        while time.time() - t < timeout_s:
            s = self.status(jid)
            if s.get("stage") != last:
                print(f"    {s.get('stage')}", flush=True); last = s.get("stage")
            if s["state"] in ("done", "failed"):
                return s
            time.sleep(3)
        return {"state": "failed", "failed_stage": "timeout", "error": f"no result after {timeout_s} s"}

    def download(self, jid: str, what: str, dest: Path) -> Path | None:
        r = requests.get(f"{self.url}/reworks/{jid}/{what}", headers=self.h, timeout=600)
        if r.status_code != 200: return None
        dest.write_bytes(r.content); return dest

    def analysis(self, jid: str) -> dict:
        r = requests.get(f"{self.url}/reworks/{jid}/analysis", headers=self.h, timeout=60); r.raise_for_status(); return r.json()

    def new_beat(self, jid: str, seed: int):
        return requests.post(f"{self.url}/reworks/{jid}/new-beat", headers=self.h, data={"seed": str(seed)}, timeout=60)


def git_commit() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=EVAL.parent, capture_output=True, text=True).stdout.strip()
    except Exception:
        return "unknown"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default=str(EVAL / "songs.csv"))
    ap.add_argument("--api"); ap.add_argument("--key")
    ap.add_argument("--limit", type=int); ap.add_argument("--run-id")
    ap.add_argument("--new-truth-version", metavar="REASON")
    ap.add_argument("--only", help="comma-separated song ids to rerun (retests after a fix)")
    a = ap.parse_args()
    load_env(EVAL / ".env")
    url, key = a.api or os.environ.get("REWORK_API_URL"), a.key or os.environ.get("REWORK_API_KEY", "")
    if not url:
        sys.exit("No API URL: deploy first (bash rework.sh deploy) or pass --api")
    rows = manifest.load(Path(a.manifest))
    truth = freeze_truth(rows, a.new_truth_version)
    if a.only:
        keep = set(a.only.split(",")); rows = [r for r in rows if r["id"] in keep]
    if a.limit: rows = rows[: a.limit]
    run_id = a.run_id or time.strftime("%Y%m%d-%H%M%S")
    out = EVAL / "runs" / run_id; out.mkdir(parents=True, exist_ok=True)
    api = Api(url, key)
    run = {"run_id": run_id, "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "api": url.split("//")[-1].split("/")[0],
           "truth_version": truth["version"], "truth_sha256": truth["sha256"], "code_commit": git_commit(),
           "songs": [r["id"] for r in rows], "metric_thresholds": metrics.THRESHOLDS}
    (out / "run.json").write_text(json.dumps(run, indent=2))
    print(f"Run {run_id}: {len(rows)} songs, truth v{truth['version']}, code {run['code_commit']}")
    first_done = None
    for i, r in enumerate(rows, 1):
        sd = out / r["id"]; sd.mkdir(exist_ok=True)
        style = r["style"]
        seed = int(hashlib.sha256(r["id"].encode()).hexdigest()[:8], 16)   # fixed per song: reruns are comparable
        print(f"[{i}/{len(rows)}] {r['id']} — {r.get('title')} ({style})", flush=True)
        t0 = time.time()
        rec = {"id": r["id"], "title": r.get("title"), "artist": r.get("artist"), "style": style, "seed": seed}
        resp = api.submit(Path(r["_path"]), style, seed)
        if resp.status_code != 202:
            rec.update(state="failed", failed_stage="submit", error=f"HTTP {resp.status_code}: {resp.text[:300]}")
        else:
            jid = resp.json()["id"]; rec["job_id"] = jid
            st = api.wait(jid)
            rec["client_wall_s"] = round(time.time() - t0, 1)
            rec.update({k: st.get(k) for k in ("state", "failed_stage", "error", "metrics", "report")})
            if st["state"] == "done":
                audio = api.download(jid, "audio", sd / "rework.wav")
                stem = api.download(jid, "stem", sd / "vocal_stem.wav")
                an = api.analysis(jid)
                (sd / "analysis.json").write_text(json.dumps(an))
                try:
                    rec["objective"] = metrics.measure(r, st, an, {"audio": str(audio) if audio else None, "stem": str(stem) if stem else None})
                except Exception as e:
                    rec["objective_error"] = f"{type(e).__name__}: {e}"
                first_done = first_done or jid
        (sd / "result.json").write_text(json.dumps(rec, indent=2, default=str))
        m = rec.get("metrics") or {}
        print(f"    {rec['state']}  total {m.get('total_wall_s')} s  gpu {m.get('gpu_billed_s')} s  cpu {m.get('cpu_billed_s')} s  "
              f"cost US${m.get('cost_total_usd')}  {rec.get('error') or ''}", flush=True)
    if first_done:   # Step 1 check: new beat reuses vocal + analysis
        print("New-beat check on the first finished song", flush=True)
        resp = api.new_beat(first_done, 424242)
        nb = {"http": resp.status_code}
        if resp.status_code == 202:
            st = api.wait(resp.json()["id"])
            m = st.get("metrics") or {}
            nb.update(state=st["state"], metrics=m, separation_skipped=m.get("separation_cached") is True and m.get("gpu_billed_s") == 0.0,
                      analysis_reused=(st.get("report") or {}).get("analysis_cached") is True)
        run["new_beat_check"] = nb
        print(f"    {nb}", flush=True)
    run["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    (out / "run.json").write_text(json.dumps(run, indent=2, default=str))
    card = out / "scorecard.csv"
    if not card.exists():
        with open(card, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["id", "title", "artist", "rework_file", "vocal_stem_file", "listen_for_bleed_at_s"] + HUMAN_COLUMNS)
            for r in rows:
                res = json.loads((out / r["id"] / "result.json").read_text())
                at = ((res.get("objective") or {}).get("stem_listen_at_s")) or ""
                w.writerow([r["id"], r.get("title"), r.get("artist"), f"{r['id']}/rework.wav", f"{r['id']}/vocal_stem.wav", " ".join(map(str, at))] + [""] * len(HUMAN_COLUMNS))
    print(f"\nDone. Listen and fill in {card} (see eval/LISTENING.md), then: bash rework.sh report")


if __name__ == "__main__":
    main()
