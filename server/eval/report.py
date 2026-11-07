"""Build the evaluation report from a run folder and its filled-in scorecard.

    python eval/report.py eval/runs/<run-id>

Writes results.csv and results.md into the run folder:
  - results by song (objective checks, timing, cost, listening ratings, first failed stage, exact failure)
  - failure breakdown by first failed pipeline stage
  - the quality gate: at least 16 of the first 20 consecutive rated songs must be playable to another person
  - timing and cost statistics
"""
from __future__ import annotations

import csv
import json
import statistics as stats
import sys
from pathlib import Path

STAGES = ["1-separation", "2-analysis", "3-beat", "4-arrangement", "5-mix", "6-master"]
GATE_N, GATE_PASS = 20, 16


def objective_first_flag(o: dict) -> str | None:
    """First pipeline stage an objective check flags (screening only; listening decides). Stages 3-5 have no
    automatic check."""
    if o.get("stem_silent") or o.get("stem_floor_flag"): return "1-separation"
    for k in ("tempo_ok", "downbeat_ok", "key_ok", "chords_ok"):
        if k in o and not o[k]: return "2-analysis"
    if ("loudness_ok" in o and not o["loudness_ok"]) or ("true_peak_ok" in o and not o["true_peak_ok"]) or o.get("clipped_samples", 0) > 0:
        return "6-master"
    return None


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(q * (len(xs) - 1))))] if xs else None


def main(run_dir: str):
    run = Path(run_dir)
    meta = json.loads((run / "run.json").read_text())
    card = {r["id"]: r for r in csv.DictReader(open(run / "scorecard.csv", newline=""))} if (run / "scorecard.csv").exists() else {}
    rows = []
    for sid in meta["songs"]:
        res = json.loads((run / sid / "result.json").read_text())
        o, m, h = res.get("objective") or {}, res.get("metrics") or {}, card.get(sid, {})
        play = (h.get("would_play_to_someone_YN") or "").strip().upper()[:1]
        if res.get("state") != "done":
            first = f"pipeline error: {res.get('failed_stage')}"
        else:
            first = (h.get("first_failed_stage") or "").strip() or ("none" if play == "Y" else ("unrated" if not play else "not given"))
        rows.append({
            "id": sid, "title": res.get("title"), "style": res.get("style"), "state": res.get("state"),
            "song_s": m.get("song_seconds"), "tempo_ok": o.get("tempo_ok"), "tempo_err_pct": o.get("tempo_err_pct"),
            "downbeat_err_ms": o.get("downbeat_err_ms"), "key": o.get("key_relation"), "chord_acc": o.get("chord_bar_accuracy"),
            "stem_floor_db": o.get("stem_floor_db"), "lufs": o.get("lufs_integrated"), "true_peak_dbtp": o.get("true_peak_dbtp"),
            "total_s": m.get("total_wall_s"), "gpu_s": m.get("gpu_billed_s"), "cpu_s": m.get("cpu_billed_s"),
            "rtf": m.get("rtf_total"), "cost_usd": m.get("cost_total_usd"), "gpu_cold": m.get("gpu_cold_start"),
            "objective_first_flag": objective_first_flag(o) if res.get("state") == "done" else None,
            **{k: h.get(k, "") for k in ("sep_quality_1to5", "bleed_1to5", "vocal_beat_alignment_1to5", "arrangement_1to5",
                                         "mix_1to5", "master_1to5", "overall_1to5")},
            "playable": play or "", "first_failed_stage": first,
            "exact_failure": res.get("error") if res.get("state") != "done" else h.get("exact_failure", ""),
        })
    with open(run / "results.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)

    # quality gate: first GATE_N consecutive songs that have a listening verdict or failed in the pipeline
    judged = [r for r in rows if r["playable"] in ("Y", "N") or r["state"] != "done"]
    window = judged[:GATE_N]
    passed = sum(1 for r in window if r["playable"] == "Y")
    gate = ("PASS" if passed >= GATE_PASS else "FAIL") if len(window) == GATE_N else f"INCOMPLETE ({len(window)} of {GATE_N} judged)"

    fails = {}
    for r in rows:
        if r["first_failed_stage"] not in ("none", ""):
            fails[r["first_failed_stage"]] = fails.get(r["first_failed_stage"], 0) + 1
    done = [r for r in rows if r["state"] == "done"]
    def col(k, cond=lambda r: True): return [r[k] for r in done if r[k] is not None and cond(r)]
    timing = {}
    for k, label in (("total_s", "Total processing, s"), ("gpu_s", "GPU billed, s"), ("cpu_s", "CPU billed, s"),
                     ("rtf", "Real-time factor (processing / song length)"), ("cost_usd", "Compute cost per rework, US$")):
        xs = col(k)
        if xs: timing[label] = (round(stats.median(xs), 4), round(stats.mean(xs), 4), round(pct(xs, 0.9), 4), len(xs))
    warm = col("gpu_s", lambda r: r["gpu_cold"] is False); cold = col("gpu_s", lambda r: r["gpu_cold"] is True)
    nb = meta.get("new_beat_check") or {}

    L = [f"# Evaluation results — run {meta['run_id']}", "",
         f"Code {meta.get('code_commit')} · truth v{meta.get('truth_version')} · {len(rows)} songs · started {meta.get('started_at')}", "",
         f"## Quality gate: **{gate}**", "",
         f"{passed} of {len(window)} judged songs (in manifest order) were rated playable to another person; the target is {GATE_PASS} of {GATE_N}.", "",
         "## Failure breakdown by first failed stage", "", "| First failed stage | Songs |", "| --- | --- |"]
    for s in STAGES + sorted(k for k in fails if k not in STAGES):
        if fails.get(s): L.append(f"| {s} | {fails[s]} |")
    L += ["", "## Timing and cost", "", "| Measure | Median | Mean | 90th percentile | Songs |", "| --- | --- | --- | --- | --- |"]
    for label, (md, mn, p9, n) in timing.items():
        L.append(f"| {label} | {md} | {mn} | {p9} | {n} |")
    if warm or cold:
        L += ["", f"GPU billed seconds: warm container median {round(stats.median(warm), 1) if warm else '—'} s ({len(warm)} songs), "
                  f"cold start median {round(stats.median(cold), 1) if cold else '—'} s ({len(cold)} songs)."]
    if nb:
        L += ["", f"New-beat check: state {nb.get('state')}, separation skipped: {nb.get('separation_skipped')}, analysis reused: "
                  f"{nb.get('analysis_reused')}, cost US${(nb.get('metrics') or {}).get('cost_total_usd')}, "
                  f"time {(nb.get('metrics') or {}).get('total_wall_s')} s."]
    L += ["", "Costs are estimates from metered container seconds × Modal list prices; reconcile with the Modal usage dashboard for the run window.",
          "", "## Results by song", "",
          "| Song | Tempo | Downbeat ms | Key | Stem floor dB | LUFS | Total s | Cost US$ | Overall | Playable | First failed stage | Exact failure |",
          "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for r in rows:
        tempo = "—" if r["tempo_ok"] is None else ("ok" if r["tempo_ok"] else f"off {r['tempo_err_pct']}%")
        L.append(f"| {r['id']} {r['title'] or ''} | {tempo} | {r['downbeat_err_ms'] if r['downbeat_err_ms'] is not None else '—'} | {r['key'] or '—'} | "
                 f"{r['stem_floor_db'] if r['stem_floor_db'] is not None else '—'} | {r['lufs'] if r['lufs'] is not None else '—'} | {r['total_s'] or '—'} | "
                 f"{r['cost_usd'] or '—'} | {r['overall_1to5'] or '—'} | {r['playable'] or '—'} | {r['first_failed_stage']} | {(r['exact_failure'] or '').replace('|', '/')} |")
    flagged = [r for r in rows if r["objective_first_flag"]]
    if flagged:
        L += ["", "## Objective screening flags (uncalibrated; listening decides)", "", "| Song | First stage flagged |", "| --- | --- |"]
        L += [f"| {r['id']} | {r['objective_first_flag']} |" for r in flagged]
    (run / "results.md").write_text("\n".join(L) + "\n")
    print("\n".join(L[:8]))
    print(f"\nWrote {run / 'results.md'} and {run / 'results.csv'}")


if __name__ == "__main__":
    main(sys.argv[1])
