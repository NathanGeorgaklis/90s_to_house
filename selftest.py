"""Modal self-test: one real GPU rework through the DEPLOYED API, measured.

    bash rework.sh selftest

Uses the bundled 14-second clip (public-domain LibriVox voice over Admiral Bob "Choice", CC BY). It checks:
  API key enforced · rights check refuses an unapproved file · GPU separation on a CUDA device · analysis ·
  unique beat · arrangement and render · master written · audio downloads and is valid · New beat reuses the
  cached vocal and analysis · timing and cost recorded.
It runs two full reworks: a COLD one (first GPU container; on the very first run this includes downloading the
model) and a WARM one on a second copy of the clip (different file, same audio), which is the steady-state figure.
The mastering stage is measured and reported, not judged: it is a known open issue (quiet masters).
Writes eval/selftest/<timestamp>/ (summary.json, the reworks). Exit code 0 = PASSED, 1 = FAILED.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sys
import time
import wave
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
CLIP = ROOT / "tests" / "real_voice_mix.wav"
APP_NAME = "ai-house-rework"
checks: list[tuple[bool, str]] = []


def check(ok: bool, what: str) -> bool:
    checks.append((bool(ok), what))
    print(f"  {'PASS' if ok else 'FAIL'}  {what}", flush=True)
    return bool(ok)


def load_env():
    p = ROOT / "eval" / ".env"
    if p.exists():
        for line in p.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip())


def padded(data: bytes, seconds: float) -> bytes:
    """Same audio with silence appended: a different file (different SHA-256) for the warm run / unapproved test."""
    with wave.open(io.BytesIO(data)) as w:
        params, frames = w.getparams(), w.readframes(w.getnframes())
    pad = b"\0" * int(params.framerate * seconds) * params.nchannels * params.sampwidth
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setparams(params); w.writeframes(frames + pad)
    return out.getvalue()


def wav_info(b: bytes) -> dict:
    import numpy as np, soundfile as sf
    x, sr = sf.read(io.BytesIO(b))
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    info = {"seconds": round(len(x) / sr, 2), "sr": sr, "peak": round(peak, 3), "finite": bool(np.all(np.isfinite(x)))}
    try:
        sys.path.insert(0, str(ROOT / "eval")); import metrics
        tmp = ROOT / "eval" / "selftest" / ".tmp.wav"; tmp.write_bytes(b)
        info.update({k: v for k, v in metrics._plain(metrics.master_indicators(str(tmp))).items() if k in ("lufs_integrated", "true_peak_dbtp", "clipped_samples")})
        tmp.unlink()
    except Exception as e:
        info["loudness_error"] = str(e)
    return info


class Api:
    def __init__(self, url, key):
        self.url, self.h = url.rstrip("/"), {"Authorization": f"Bearer {key}"}

    def get(self, path, auth=True, **kw):
        return requests.get(self.url + path, headers=self.h if auth else {}, timeout=kw.pop("timeout", 120), **kw)

    def submit(self, data: bytes, name: str, seed: int):
        return requests.post(self.url + "/reworks", headers=self.h, files={"file": (name, data)},
                             data={"style": "pawsa", "seed": str(seed)}, timeout=600)

    def wait(self, jid, timeout_s=2400):
        t, last = time.time(), None
        while time.time() - t < timeout_s:
            r = self.get(f"/reworks/{jid}")
            if r.status_code == 200:
                s = r.json()
                if s.get("stage") != last:
                    print(f"        {int(time.time() - t):>4} s  {s.get('stage')}", flush=True); last = s.get("stage")
                if s["state"] in ("done", "failed"):
                    return s
            time.sleep(3)
        return {"state": "failed", "error": f"no result after {timeout_s} s"}


def full_rework(api: Api, data: bytes, name: str, seed: int, label: str, out: Path) -> dict:
    print(f"\n{label}: full rework of {name}", flush=True)
    t0 = time.time()
    r = api.submit(data, name, seed)
    if not check(r.status_code == 202, f"{label}: approved file accepted (HTTP {r.status_code})"):
        return {"state": "failed", "error": r.text[:300]}
    s = api.wait(r.json()["id"]); s["client_wall_s"] = round(time.time() - t0, 1)
    if not check(s["state"] == "done", f"{label}: job finished" + ("" if s["state"] == "done" else f" — FAILED at '{s.get('failed_stage')}': {s.get('error')}")):
        return s
    m, rep = s.get("metrics") or {}, s.get("report") or {}
    dev = str(m.get("gpu_device") or "")
    check(dev and dev.lower() != "cpu", f"{label}: separation ran on a GPU ({dev or 'device not reported'})")
    check((m.get("separation_s") or 0) > 0 and not m.get("separation_cached"), f"{label}: vocal separation completed ({m.get('separation_s')} s)")
    song = rep.get("song") or {}
    check((song.get("bpm") or 0) > 0 and song.get("key") and song.get("bars", 0) > 0,
          f"{label}: song analysis completed (tempo {song.get('bpm')} BPM, key {(song.get('key') or {}).get('name')}, downbeat confidence {song.get('downbeat_conf')})")
    check(bool(rep.get("beat_code")), f"{label}: unique beat generated (beat {rep.get('beat_code')}, {rep.get('style')})")
    rw = rep.get("rework") or {}
    check(rw.get("bars", 0) > 0 and rw.get("sections"), f"{label}: arrangement built ({', '.join(rw.get('sections') or [])})")
    a = api.get(f"/reworks/{s['id']}/audio", timeout=600)
    ok = a.status_code == 200 and a.content[:4] == b"RIFF"
    check(ok, f"{label}: finished audio downloaded (HTTP {a.status_code}, {len(a.content) // 1024} KB)")
    if ok:
        (out / f"{label.lower().replace(' ', '-')}.wav").write_bytes(a.content)
        info = wav_info(a.content); s["audio"] = info
        check(info["finite"] and info["peak"] > 0.01 and abs(info["seconds"] - (rw.get("seconds") or 0)) < 1.5,
              f"{label}: render and master completed (valid audio, {info['seconds']} s, peak {info['peak']})")
        print(f"        master measured: {info.get('lufs_integrated')} LUFS, true peak {info.get('true_peak_dbtp')} dBTP "
              f"(known open issue: quiet masters; not judged here)")
    check(all(k in m for k in ("total_wall_s", "gpu_billed_s", "cpu_billed_s", "rtf_total")), f"{label}: timing metrics recorded")
    check(all(k in m for k in ("cost_gpu_usd", "cost_cpu_usd", "cost_orchestration_usd", "cost_total_usd")), f"{label}: cost metrics recorded")
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--local-store", help=argparse.SUPPRESS)   # test hook: write approvals to a local store instead of Modal
    ap.add_argument("--api"); ap.add_argument("--key")
    a = ap.parse_args()
    load_env()
    url, key = a.api or os.environ.get("REWORK_API_URL"), a.key or os.environ.get("REWORK_API_KEY")
    if not url or not key:
        sys.exit("STOPPED: no API URL or key in eval/.env. Run: bash rework.sh setup, then bash rework.sh deploy")
    out = ROOT / "eval" / "selftest" / time.strftime("%Y%m%d-%H%M%S"); out.mkdir(parents=True, exist_ok=True)
    api = Api(url, key)
    clip_a = CLIP.read_bytes(); clip_b = padded(clip_a, 1.0); clip_c = padded(clip_a, 2.0)
    print(f"Self-test against {url}\nClip: {CLIP.name}, 14.0 s (public-domain voice over a CC BY loop)\n\nChecks")

    check(api.get("/health", auth=False).status_code == 200, "API reachable")
    check(api.get("/styles", auth=False).status_code == 401, "API refuses requests without the key")
    entries = {hashlib.sha256(d).hexdigest(): {"title": t, "file": t, "rights_basis": "public-domain voice (LibriVox) over CC BY loop (Admiral Bob, Choice)",
                                                "confirmed_by": "bundled self-test asset", "approved_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
               for d, t in ((clip_a, "selftest clip"), (clip_b, "selftest clip + 1 s silence"))}
    try:
        if a.local_store:
            sys.path.insert(0, str(ROOT)); import service
            st = service.Store(Path(a.local_store)); cur = st.approved(); cur.update(entries); st.set_approved(cur)
        else:
            import modal
            modal.Function.from_name(APP_NAME, "write_approvals").remote(entries)
        check(True, "self-test clips approved through the admin path")
    except Exception as e:
        check(False, f"self-test clips approved through the admin path ({type(e).__name__}: {e})")
    r = api.submit(clip_c, "unapproved.wav", 1)
    check(r.status_code == 403, f"rights check refuses an unapproved file (HTTP {r.status_code})")

    cold = full_rework(api, clip_a, "selftest.wav", 7, "Cold run", out)
    nb = {}
    if cold.get("state") == "done":
        print("\nNew beat on the cold run's song", flush=True)
        r = requests.post(f"{api.url}/reworks/{cold['id']}/new-beat", headers=api.h, data={"seed": "8"}, timeout=120)
        if check(r.status_code == 202, f"New beat accepted (HTTP {r.status_code})"):
            nb = api.wait(r.json()["id"])
            nm, nr = nb.get("metrics") or {}, nb.get("report") or {}
            check(nb.get("state") == "done", "New beat finished" + ("" if nb.get("state") == "done" else f" — {nb.get('error')}"))
            check(nm.get("separation_cached") is True and nm.get("gpu_billed_s") == 0.0, "New beat did not rerun separation (no GPU time)")
            check(nr.get("analysis_cached") is True and nr.get("song") == (cold.get("report") or {}).get("song"), "New beat did not rerun analysis (same analysis reused)")
            check(nr.get("beat_code") and nr.get("beat_code") != (cold.get("report") or {}).get("beat_code"), f"New beat is a different beat ({nr.get('beat_code')})")
            if nb.get("state") == "done":
                a2 = api.get(f"/reworks/{nb['id']}/audio", timeout=600)
                check(a2.status_code == 200 and a2.content[:4] == b"RIFF", "New beat audio downloaded")
    warm = full_rework(api, clip_b, "selftest-copy.wav", 9, "Warm run", out)

    passed = all(ok for ok, _ in checks)
    cm, wm, nm = cold.get("metrics") or {}, warm.get("metrics") or {}, nb.get("metrics") or {}
    ref = wm if warm.get("state") == "done" else cm
    def f(v, d=1): return "n/a" if v is None else (f"{v:.{d}f}" if isinstance(v, (int, float)) else str(v))
    lines = [
        "", "=" * 64, f"SELF-TEST {'PASSED' if passed else 'FAILED'}  ({sum(ok for ok, _ in checks)}/{len(checks)} checks)", "=" * 64,
        f"Source audio duration            {f(ref.get('song_seconds'))} s",
        f"GPU device                       {ref.get('gpu_device') or 'n/a'}",
        "",
        "                                 warm run (steady state)   cold run (first container)",
        f"Total processing time            {f(wm.get('total_wall_s')):>10} s            {f(cm.get('total_wall_s')):>10} s",
        f"GPU separation time (billed)     {f(wm.get('gpu_billed_s')):>10} s            {f(cm.get('gpu_billed_s')):>10} s",
        f"  of which separation itself     {f(wm.get('separation_s')):>10} s            {f(cm.get('separation_s')):>10} s",
        f"  of which model load            {f(wm.get('model_load_s')):>10} s            {f(cm.get('model_load_s')):>10} s",
        f"CPU / render time (billed)       {f(wm.get('cpu_billed_s')):>10} s            {f(cm.get('cpu_billed_s')):>10} s",
        f"Real-time factor (total/song)    {f(wm.get('rtf_total'), 2):>10}              {f(cm.get('rtf_total'), 2):>10}",
        f"Estimated GPU cost               US${f(wm.get('cost_gpu_usd'), 5):>8}            US${f(cm.get('cost_gpu_usd'), 5):>8}",
        f"Estimated CPU + orchestration    US${f((wm.get('cost_cpu_usd') or 0) + (wm.get('cost_orchestration_usd') or 0), 5):>8}            "
        f"US${f((cm.get('cost_cpu_usd') or 0) + (cm.get('cost_orchestration_usd') or 0), 5):>8}",
        f"Estimated total per rework       US${f(wm.get('cost_total_usd'), 5):>8}            US${f(cm.get('cost_total_usd'), 5):>8}",
        "",
        f"New beat render time             {f(nm.get('total_wall_s'))} s   (cost US${f(nm.get('cost_total_usd'), 5)})",
        f"New beat reused separation       {'yes' if nm.get('separation_cached') is True and nm.get('gpu_billed_s') == 0.0 else 'NO'}",
        f"New beat reused analysis         {'yes' if (nb.get('report') or {}).get('analysis_cached') is True else 'NO'}",
        f"Master (measured, not judged)    {f((warm.get('audio') or cold.get('audio') or {}).get('lufs_integrated'))} LUFS, "
        f"true peak {f((warm.get('audio') or cold.get('audio') or {}).get('true_peak_dbtp'), 2)} dBTP",
        "",
        "Costs are estimates: metered container seconds x Modal list prices. Compare with Modal's usage page.",
    ]
    if not passed:
        lines += ["", "Failed checks:"] + [f"  - {w}" for ok, w in checks if not ok]
    print("\n".join(lines))
    summary = {"passed": passed, "checks": [{"ok": ok, "check": w} for ok, w in checks], "cold": cold, "warm": warm, "new_beat": nb, "api": url.split("//")[-1]}
    (out / "summary.json").write_text(json.dumps(summary, indent=2, default=str))
    (out / "summary.txt").write_text("\n".join(lines) + "\n")
    print(f"\nSaved: {out}/summary.txt and summary.json")
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
