/* Analysis: per-bar chords + key (from chroma), per-bar vocal activity, automatic arrangement.
   Pure functions; loaded inline in the page and by Node tests. */
"use strict";
const Analysis = (() => {
  const NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
  const KS_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KS_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  /** Sum chroma frames whose centre time falls in [t0, t1). */
  function chromaSpan(sep, t0, t1) {
    const c = new Float64Array(12), fps = sep.sr / sep.hop;
    const f0 = Math.max(0, Math.ceil(t0 * fps)), f1 = Math.min(sep.frames, Math.ceil(t1 * fps));
    for (let f = f0; f < f1; f++) for (let p = 0; p < 12; p++) c[p] += sep.chroma[f * 12 + p];
    return c;
  }
  function norm(c) { let s = 0; for (const v of c) s += v * v; s = Math.sqrt(s) || 1; return Array.from(c, v => v / s); }
  const TPL = [];
  for (let r = 0; r < 12; r++) for (const q of ["maj", "min"]) {
    const t = new Array(12).fill(0), third = q === "maj" ? 4 : 3;
    t[r] = 1; t[(r + third) % 12] = 0.9; t[(r + 7) % 12] = 0.8;
    TPL.push({ pc: r, q, t: norm(t) });
  }

  /**
   * Chord per song bar. Returns [{pc, q, name, conf, ok}].
   * conf = cosine margin between best and second-best triad template (0..1); ok = conf >= minConf and bar has harmonic energy.
   * Bars that are not ok inherit the previous ok chord (marked held:true); leading ones take the first ok chord.
   */
  function detectChords(sep, offset, barSec, nBars, minConf = 0.02) {
    const raw = [], energies = [];
    for (let b = 0; b < nBars; b++) { const c = chromaSpan(sep, offset + b * barSec, offset + (b + 1) * barSec); raw.push(c); energies.push(c.reduce((a, v) => a + v, 0)); }
    const sorted = energies.slice().sort((a, b) => a - b), med = sorted[Math.floor(sorted.length / 2)] || 0;
    const out = raw.map((c, b) => {
      const n = norm(c); let best = -1, second = -1, bi = 0;
      TPL.forEach((T, i) => { let s = 0; for (let p = 0; p < 12; p++) s += n[p] * T.t[p]; if (s > best) { second = best; best = s; bi = i; } else if (s > second) second = s; });
      const conf = best - second, energetic = energies[b] > 0.15 * med;
      return { pc: TPL[bi].pc, q: TPL[bi].q, conf: +conf.toFixed(3), ok: energetic && conf >= minConf, held: false };
    });
    // mode filter over 3 bars on confident chords to suppress single-bar flicker
    for (let b = 1; b < out.length - 1; b++) {
      const a = out[b - 1], c = out[b + 1], m = out[b];
      if (a.ok && c.ok && a.pc === c.pc && a.q === c.q && (m.pc !== a.pc || m.q !== a.q) && m.conf < 0.05) { out[b] = { ...a, conf: m.conf, held: true }; }
    }
    let prev = out.find(x => x.ok) || null;
    for (let b = 0; b < out.length; b++) { if (out[b].ok) prev = out[b]; else if (prev) out[b] = { ...prev, conf: out[b].conf, ok: false, held: true }; }
    out.forEach(x => x.name = NAMES[x.pc] + (x.q === "min" ? "m" : ""));
    return out;
  }

  /**
   * Downbeat: which of the four beat positions starts the bar. Tempo analysis only finds the beat phase.
   * Two cues, each z-scored across the four candidates:
   *   harmonic change - chords tend to change on bar lines (separates beat 1 from beat 3), weight 1
   *   low-end accent  - kick on 1 and 3 against the backbeat on 2 and 4 (separates {1,3} from {2,4}), weight 0.5
   * Returns {offset (s, in [0, bar)), conf (score margin best - second, 0 = undecided), scores}.
   */
  function detectDownbeat(sep, tempo) {
    const beat = 60 / tempo.bpm, bar = 4 * beat, dur = sep.frames * sep.hop / sep.sr;
    const base = ((tempo.offset % beat) + beat) % beat;
    const H = [], Lw = [];
    for (let k = 0; k < 4; k++) {
      const off = base + k * beat; let s = 0, n = 0;
      for (let t = off + bar; t + 2 * beat < dur; t += bar) {
        const a = norm(chromaSpan(sep, t - 2 * beat, t)), b = norm(chromaSpan(sep, t, t + 2 * beat));
        let d = 0; for (let p = 0; p < 12; p++) d += a[p] * b[p];
        if (a.some(v => v) && b.some(v => v)) { s += 1 - d; n++; }
      }
      H.push(n ? s / n : 0);
    }
    if (tempo.onset && tempo.fr) {
      const o = tempo.onset, end = tempo.start + o.length / tempo.fr;
      const at = t => { const i = Math.round((t - tempo.start) * tempo.fr); let m = 0; for (let j = i - 3; j <= i + 3; j++) if (j >= 0 && j < o.length && o[j] > m) m = o[j]; return m; };
      for (let k = 0; k < 4; k++) {
        let s = 0, n = 0;
        for (let t = base + k * beat; t + 4 * beat < end; t += bar) { if (t < tempo.start) continue; s += at(t) + at(t + 2 * beat) - at(t + beat) - at(t + 3 * beat); n++; }
        Lw.push(n ? s / n : 0);
      }
    } else for (let k = 0; k < 4; k++) Lw.push(0);
    const z = xs => { const m = xs.reduce((a, b) => a + b, 0) / xs.length, sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); return xs.map(x => sd > 1e-9 ? (x - m) / sd : 0); };
    const zH = z(H), zL = z(Lw), score = zH.map((h, k) => h + 0.5 * zL[k]);
    const order = score.map((s, k) => [s, k]).sort((a, b) => b[0] - a[0]);
    const k = order[0][1];
    return { offset: (base + k * beat) % bar, conf: +(order[0][0] - order[1][0]).toFixed(3), scores: score.map(s => +s.toFixed(3)) };
  }

  /** Krumhansl–Schmuckler key estimate. Returns {pc, mode, name, conf}. */
  function detectKey(sep) {
    const tot = new Float64Array(12);
    for (let f = 0; f < sep.frames; f++) for (let p = 0; p < 12; p++) tot[p] += sep.chroma[f * 12 + p];
    const corr = (x, y) => { const mx = x.reduce((a, v) => a + v, 0) / 12, my = y.reduce((a, v) => a + v, 0) / 12; let n = 0, dx = 0, dy = 0; for (let i = 0; i < 12; i++) { n += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; } return n / Math.sqrt(dx * dy || 1); };
    const res = [];
    for (let r = 0; r < 12; r++) for (const [mode, prof] of [["major", KS_MAJ], ["minor", KS_MIN]]) {
      const rot = Array.from({ length: 12 }, (_, i) => prof[(i - r + 12) % 12]); res.push({ pc: r, mode, r: corr(Array.from(tot), rot) });
    }
    res.sort((a, b) => b.r - a.r);
    return { pc: res[0].pc, mode: res[0].mode, name: NAMES[res[0].pc] + (res[0].mode === "minor" ? " minor" : " major"), conf: +(res[0].r - res[1].r).toFixed(3) };
  }

  /** Vocal activity per bar, scaled so the 90th percentile of the song = 1. */
  function vocalPerBar(sep, offset, barSec, nBars) {
    const fps = sep.sr / sep.hop, v = [];
    for (let b = 0; b < nBars; b++) {
      const f0 = Math.max(0, Math.ceil((offset + b * barSec) * fps)), f1 = Math.min(sep.frames, Math.ceil((offset + (b + 1) * barSec) * fps));
      let s = 0; for (let f = f0; f < f1; f++) s += sep.vact[f]; v.push(f1 > f0 ? s / (f1 - f0) : 0);
    }
    const sorted = v.slice().sort((a, b) => a - b), p90 = sorted[Math.floor(sorted.length * 0.9)] || 1;
    return v.map(x => Math.min(1.5, x / (p90 || 1)));
  }

  /**
   * Build an arrangement.
   * opts: {va, chords, nBars, intro, outro, trimGaps, overrides:{blockIndex:type}, activeThr}
   * Returns {bars:[{type, songBar, chord, build, block}], blocks:[{start,len,type,auto}], runs:[{outStart,songStart,len}], hookBar}
   */
  function arrange(opts) {
    const { va, chords, nBars } = opts, intro = opts.intro ?? 8, outro = opts.outro ?? 8, thr = opts.activeThr ?? 0.18, ov = opts.overrides || {};
    const active = va.map(x => x > thr);
    let first = active.indexOf(true), last = active.lastIndexOf(true);
    if (first < 0) { first = 0; last = nBars - 1; }
    const start = first - (first % 4);
    let end = Math.min(nBars, start + Math.ceil((last + 1 - start) / 4) * 4);
    // song bars, with long instrumental gaps shortened to 4 bars
    const song = []; let b = start;
    while (b < end) {
      if (!active[b] && opts.trimGaps !== false) {
        let e = b; while (e < end && !active[e]) e++;
        const run = e - b;
        if (run > 8) { for (let i = 0; i < 4; i++) song.push(b + i); b = e; continue; }
      }
      song.push(b); b++;
    }
    const bars = [];
    const chordAt = sb => chords[Math.max(0, Math.min(chords.length - 1, sb))];
    for (let i = 0; i < intro; i++) bars.push({ type: "intro", songBar: -1, chord: chordAt(song[i % Math.min(4, song.length)] ?? 0) });
    song.forEach(sb => bars.push({ type: "groove", songBar: sb, chord: chordAt(sb) }));
    const tail = song.slice(-4);
    for (let i = 0; i < outro; i++) bars.push({ type: "outro", songBar: -1, chord: chordAt(tail[i % Math.max(1, tail.length)] ?? 0) });
    // blocks of 8 over the song section
    const blocks = [];
    if (intro) blocks.push({ start: 0, len: intro, type: "intro", auto: true });
    for (let i = 0; i < song.length; i += 8) {
      const len = Math.min(8, song.length - i), seg = song.slice(i, i + len);
      const energy = seg.reduce((a, sb) => a + va[sb], 0) / len;
      blocks.push({ start: intro + i, len, type: energy < 0.15 ? "break" : "groove", energy, auto: true });
    }
    if (outro) blocks.push({ start: intro + song.length, len: outro, type: "outro", auto: true });
    const songBlocks = blocks.filter(x => x.type === "groove");
    const nDrop = Math.max(songBlocks.length ? 1 : 0, Math.round(songBlocks.length * 0.4));
    songBlocks.slice().sort((a, b) => b.energy - a.energy).slice(0, nDrop).forEach(x => x.type = "drop");
    blocks.forEach((x, i) => { if (ov[i]) { x.type = ov[i]; x.auto = false; } });
    blocks.forEach((x, i) => { for (let j = 0; j < x.len; j++) { const bb = bars[x.start + j]; bb.type = x.type; bb.block = i; bb.build = false; } });
    // builds: last 2 bars before a drop that follows a non-drop block
    blocks.forEach((x, i) => {
      if (x.type !== "drop" || i === 0) return; const p = blocks[i - 1]; if (p.type === "drop" || p.len < 4) return;
      for (let j = p.start + p.len - 2; j < p.start + p.len; j++) bars[j].build = true;
    });
    // contiguous runs of song audio
    const runs = [];
    bars.forEach((bb, i) => { if (bb.songBar < 0) return; const r = runs[runs.length - 1]; if (r && r.outStart + r.len === i && r.songStart + r.len === bb.songBar) r.len++; else runs.push({ outStart: i, songStart: bb.songBar, len: 1 }); });
    // hook: 1-bar slice with the strongest vocal, for chops
    let hookBar = song[0] ?? 0, hv = -1; song.forEach(sb => { if (va[sb] > hv) { hv = va[sb]; hookBar = sb; } });
    // up to 3 alternative hook bars (strongest vocal, at least 4 bars apart) so each generated beat can chop a different moment
    const hooks = [];
    song.slice().sort((a, b) => va[b] - va[a]).forEach(sb => { if (hooks.length < 3 && hooks.every(h => Math.abs(h - sb) >= 4)) hooks.push(sb); });
    return { bars, blocks, runs, hookBar, hooks };
  }
  return { NAMES, detectChords, detectKey, detectDownbeat, vocalPerBar, arrange };
})();
if (typeof module !== "undefined") module.exports = Analysis;
