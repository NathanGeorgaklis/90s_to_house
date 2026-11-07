"""Compare vocal estimates against the known true vocal of the synthetic test excerpt.
Metrics: correlation with the true vocal (1.0 = perfect), SDR in dB, and leakage: level in the first bar
(no singing there, only drums and keys) relative to the sung bars. Lower leakage = less backing bleeding through."""
import json, subprocess, sys
import numpy as np, soundfile as sf

def load(p):
    x, sr = sf.read(p); x = x.mean(axis=1) if x.ndim > 1 else x; return x, sr

def metrics(est, ref, sr, silent_s=float(sys.argv[4]) if len(sys.argv) > 4 else 2.4):
    n = min(len(est), len(ref)); est, ref = est[:n], ref[:n]
    g = np.dot(est, ref) / (np.dot(ref, ref) + 1e-12)            # best gain, so level differences don't count
    err = est - g * ref
    sdr = 10 * np.log10(np.sum((g * ref) ** 2) / (np.sum(err ** 2) + 1e-12))
    corr = np.dot(est, ref) / np.sqrt(np.dot(est, est) * np.dot(ref, ref) + 1e-12)
    s = int(silent_s * sr); sil = np.mean(est[:s] ** 2); sung = np.mean(est[s:] ** 2)
    return {"corr": round(float(corr), 3), "sdr_db": round(float(sdr), 1), "leakage_db": round(float(10 * np.log10(sil / (sung + 1e-12) + 1e-12)), 1)}

ref, sr = load(sys.argv[2]); mix, _ = load(sys.argv[1])
out = {"raw_mix": metrics(mix, ref, sr)}
ai, _ = load(sys.argv[3]); out["ai_bs_roformer"] = metrics(ai, ref, sr)
# browser DSP extraction on the same excerpt, for comparison
js = """const DSP=require('%s');const fs=require('fs');const sf=JSON.parse(fs.readFileSync(0,'utf8'));
const L=Float32Array.from(sf.L),R=Float32Array.from(sf.R);const r=DSP.separate(L,R,sf.sr,{},()=>{});process.stdout.write(JSON.stringify(Array.from(r.vocal)));""" % "/home/claude/house-rework/src/dsp-worker.js"
st, _ = sf.read(sys.argv[1])
p = subprocess.run(["node", "-e", js], input=json.dumps({"L": st[:, 0].tolist(), "R": st[:, 1].tolist(), "sr": sr}), capture_output=True, text=True)
out["browser_dsp"] = metrics(np.array(json.loads(p.stdout)), ref, sr)
print(json.dumps(out, indent=2))
