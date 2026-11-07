/* DSP worker: vocal extraction (centre-channel + harmonic/percussive masking), chroma, vocal activity, WSOLA stretch.
   Runs in a Web Worker in the page; also loadable in Node for tests (module.exports at bottom). */
"use strict";
const DSP = (() => {
  const N = 2048, HOP = 1024, K = N / 2 + 1;

  // ---- FFT (radix-2, in place, complex) ----
  const rev = new Uint32Array(N), cosT = new Float32Array(N / 2), sinT = new Float32Array(N / 2);
  (function init() {
    const bits = Math.log2(N);
    for (let i = 0; i < N; i++) { let r = 0, x = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
    for (let i = 0; i < N / 2; i++) { cosT[i] = Math.cos(2 * Math.PI * i / N); sinT[i] = -Math.sin(2 * Math.PI * i / N); }
  })();
  function fft(re, im, inverse) {
    for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    const sg = inverse ? -1 : 1;
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let i = 0; i < N; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cosT[k], wi = sg * sinT[k], a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inverse) for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
  }
  // sqrt-Hann window: analysis x synthesis at 50% overlap sums to 1
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));

  // sliding median over a sequence (odd window), using a sorted window buffer
  function slidingMedian(src, dst, len, w) {
    const h = w >> 1, buf = new Float32Array(w); let n = 0;
    const ins = v => { let i = n++; while (i > 0 && buf[i - 1] > v) { buf[i] = buf[i - 1]; i--; } buf[i] = v; };
    const del = v => { let i = 0; while (i < n && buf[i] !== v) i++; for (; i < n - 1; i++) buf[i] = buf[i + 1]; n--; };
    for (let i = 0; i < Math.min(h, len); i++) ins(src[i]);
    for (let i = 0; i < len; i++) {
      if (i - h - 1 >= 0) del(src[i - h - 1]);
      if (i + h < len) ins(src[i + h]);
      dst[i] = buf[n >> 1];
    }
  }

  /**
   * separate(L, R, sr, opts) -> { vocal, chroma, vact, frames, hop, sr, mono }
   * vocal: mono Float32Array estimate of the lead vocal.
   * chroma: frames*12 harmonic chroma; vact: per-frame vocal-band energy.
   * opts.acappella: true skips masking (input is already an a cappella).
   */
  function separate(L, R, sr, opts, progress) {
    opts = opts || {}; progress = progress || (() => {});
    const len = L.length, F = Math.ceil(len / HOP) + 2, hz = sr / N;
    const kMax = Math.min(K, Math.ceil(10500 / hz));
    // Memory: only two F*kMax float arrays are kept (mid magnitude, harmonic median). The complex spectra are
    // recomputed in the final pass, so peak use stays near 2*F*kMax*4 bytes (~40 MB for 4 minutes).
    const mag = new Float32Array(F * kMax);
    const re = new Float32Array(N), im = new Float32Array(N);
    const mRe = new Float32Array(kMax), mIm = new Float32Array(kMax), cen = new Float32Array(kMax);
    // one frame: STFT of L+iR, split into L_k and R_k, write mid spectrum + centre similarity (1 = identical in both channels)
    function frame(f, stats) {
      const st = f * HOP - N / 2;
      for (let n = 0; n < N; n++) { const i = st + n; const l = i >= 0 && i < len ? L[i] : 0, r = i >= 0 && i < len ? R[i] : 0; re[n] = l * win[n]; im[n] = r * win[n]; }
      fft(re, im, false);
      for (let k = 0; k < kMax; k++) {
        const nk = (N - k) % N;
        const lr = 0.5 * (re[k] + re[nk]), li = 0.5 * (im[k] - im[nk]);
        const rr = 0.5 * (im[k] + im[nk]), ri = -0.5 * (re[k] - re[nk]);
        mRe[k] = 0.5 * (lr + rr); mIm[k] = 0.5 * (li + ri);
        const pl = lr * lr + li * li, pr = rr * rr + ri * ri, x = lr * rr + li * ri;
        if (stats) { stats.LL += pl; stats.RR += pr; stats.LR += x; }
        cen[k] = 2 * x / (pl + pr + 1e-12);
      }
    }
    const stats = { LL: 0, RR: 0, LR: 0 };
    for (let f = 0; f < F; f++) {
      frame(f, stats);
      for (let k = 0; k < kMax; k++) mag[f * kMax + k] = Math.sqrt(mRe[k] * mRe[k] + mIm[k] * mIm[k]);
      if (f % 200 === 0) progress(0.05 + 0.25 * f / F, "Analysing the mix");
    }
    const sLL = stats.LL, sRR = stats.RR, sLR = stats.LR;
    const mono = (2 * sLR / (sLL + sRR + 1e-12)) > 0.97;
    // harmonic (time-median) per bin
    const Hm = new Float32Array(F * kMax), col = new Float32Array(F), colOut = new Float32Array(F);
    for (let k = 0; k < kMax; k++) {
      for (let f = 0; f < F; f++) col[f] = mag[f * kMax + k];
      slidingMedian(col, colOut, F, 17);
      for (let f = 0; f < F; f++) Hm[f * kMax + k] = colOut[f];
      if (k % 100 === 0) progress(0.3 + 0.3 * k / kMax, "Separating drums from the vocal");
    }
    // per-frame: percussive (freq-median), masks, chroma, activity, inverse STFT
    const chroma = new Float32Array(F * 12), vact = new Float32Array(F);
    const out = new Float32Array(len), row = new Float32Array(kMax), rowP = new Float32Array(kMax);
    const pcOfBin = new Int8Array(kMax).fill(-1);
    for (let k = 1; k < kMax; k++) { const fr = k * hz; if (fr >= 55 && fr <= 2000) pcOfBin[k] = ((Math.round(12 * Math.log2(fr / 440)) + 69) % 12 + 12) % 12; }
    const band = new Float32Array(kMax);
    for (let k = 0; k < kMax; k++) { const fr = k * hz; band[k] = fr < 90 ? 0 : fr < 180 ? (fr - 90) / 90 : fr < 7000 ? 1 : Math.max(0.35, 1 - (fr - 7000) / 5000); }
    for (let f = 0; f < F; f++) {
      const b = f * kMax;
      frame(f, null);
      for (let k = 0; k < kMax; k++) row[k] = mag[b + k];
      slidingMedian(row, rowP, kMax, 17);
      let va = 0;
      for (let k = 0; k < kMax; k++) {
        const h = Hm[b + k], p = rowP[k], hm = (h * h) / (h * h + p * p + 1e-12);
        const pc = pcOfBin[k]; if (pc >= 0) chroma[f * 12 + pc] += Math.sqrt(mag[b + k] * hm);
        let m;
        if (opts.acappella) m = band[k] > 0 ? 1 : 0;
        else {
          const c = cen[k], cm = mono ? 1 : (c <= 0.55 ? 0 : c >= 0.92 ? 1 : (c - 0.55) / 0.37);
          m = cm * hm * band[k];
        }
        re[k] = mRe[k] * m; im[k] = mIm[k] * m;
        const fr = k * hz; if (fr > 200 && fr < 4000) va += (re[k] * re[k] + im[k] * im[k]);
      }
      vact[f] = Math.sqrt(va);
      for (let k = kMax; k < K; k++) { re[k] = 0; im[k] = 0; }
      for (let k = 1; k < N / 2; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
      im[0] = 0; im[N / 2] = 0;
      fft(re, im, true);
      const st = f * HOP - N / 2;
      for (let n = 0; n < N; n++) { const i = st + n; if (i >= 0 && i < len) out[i] += re[n] * win[n]; }
      if (f % 200 === 0) progress(0.6 + 0.38 * f / F, "Rebuilding the vocal");
    }
    progress(1, "Done");
    return { vocal: out, chroma, vact, frames: F, hop: HOP, sr, mono };
  }

  /**
   * WSOLA time-stretch. s = output duration / input duration. Keeps pitch.
   */
  function stretch(x, s, progress) {
    progress = progress || (() => {});
    if (Math.abs(s - 1) < 1e-4) return x.slice(0);
    const W = 1024, Hs = W / 2, tol = 256, outLen = Math.floor(x.length * s);
    // periodic Hann at 50% overlap sums to exactly 1, so no normalisation buffer is needed
    const out = new Float32Array(outLen + W);
    const w = new Float32Array(W); for (let i = 0; i < W; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / W);
    let prev = 0;
    const xl = x.length, get = i => (i >= 0 && i < xl ? x[i] : 0);
    const frames = Math.ceil(outLen / Hs);
    for (let k = 0; k * Hs < outLen; k++) {
      const nom = Math.round(k * Hs / s);
      let best = 0;
      if (k > 0) {
        const tpl = prev + Hs; // natural continuation of the previous segment
        let bestC = -Infinity;
        for (let d = -tol; d <= tol; d += 8) { let c = 0; const p = nom + d; for (let i = 0; i < W / 2; i += 8) c += get(tpl + i) * get(p + i); if (c > bestC) { bestC = c; best = d; } }
        const coarse = best; bestC = -Infinity;
        for (let d = coarse - 7; d <= coarse + 7; d++) { let c = 0; const p = nom + d; for (let i = 0; i < W / 2; i += 2) c += get(tpl + i) * get(p + i); if (c > bestC) { bestC = c; best = d; } }
      }
      const pos = nom + best, o = k * Hs;
      for (let i = 0; i < W; i++) out[o + i] += get(pos + i) * w[i];
      prev = pos;
      if (k % 2000 === 0) progress(k / frames, "Fitting the vocal to the new tempo");
    }
    // first half-window only received one overlap: restore its level
    for (let i = 0; i < Hs && i < outLen; i++) { const wi = w[i]; if (wi > 1e-3) out[i] /= wi; }
    progress(1, "Fitting the vocal to the new tempo");
    return out.subarray(0, outLen);
  }
  return { separate, stretch, N, HOP };
})();

if (typeof self !== "undefined" && typeof self.postMessage === "function" && typeof module === "undefined") {
  self.onmessage = e => {
    const m = e.data;
    try {
      if (m.cmd === "separate") {
        const r = DSP.separate(m.L, m.R, m.sr, { acappella: m.acappella }, (p, label) => self.postMessage({ cmd: "progress", p, label }));
        self.postMessage({ cmd: "separated", id: m.id, ...r }, [r.vocal.buffer, r.chroma.buffer, r.vact.buffer]);
      } else if (m.cmd === "stretch") {
        const y = DSP.stretch(m.x, m.s, (p, label) => self.postMessage({ cmd: "progress", p, label }));
        self.postMessage({ cmd: "stretched", id: m.id, y, len: y.length }, [y.buffer]);
      }
    } catch (err) { self.postMessage({ cmd: "error", id: m.id, message: String(err && err.message || err) }); }
  };
}
if (typeof module !== "undefined") module.exports = DSP;
