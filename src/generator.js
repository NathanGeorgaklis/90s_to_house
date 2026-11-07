/* ---------------- Beat generator ----------------
   Rolls a new beat from a style's template: same instrument palette and feel, new patterns and sound design.
   Deterministic for a given (style, seed), so a beat code always reproduces the same beat. Rule-based, not a trained model. */
const Gen = (() => {
  function rng(seed) { let a = (seed >>> 0) || 1; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // step weights (16ths). Offbeat-heavy for basslines that dodge the kick; syncopated for percussion.
  const W_OFF = [.12, .45, 1, .7, .12, .45, 1, .7, .12, .45, 1, .7, .12, .45, 1, .8];
  const W_SUB = [.55, .2, 1, .6, .2, .35, .9, .65, .4, .2, 1, .6, .2, .45, .9, .6];
  const W_PERC = [0, .45, .5, 1, .1, .6, .9, 1, 0, .45, .6, 1, .1, .7, .9, 1];
  const W_CH = [.6, .2, .5, 1, .2, .3, 1, .6, .25, .3, .7, 1, .4, .3, .8, .5];
  const W_ARP = [1, .3, .6, 1, .3, .6, 1, .3, 1, .3, .6, 1, .3, .6, 1, .3];
  const BASS_ALT = { sub: ["sub", "rubber"], rubber: ["rubber", "sub"], acid: ["acid", "rubber"], reese: ["reese", "sub"], saw: ["saw", "rubber"] };
  const TONE_ALT = { stab: ["stab", "piano", "rhodes"], piano: ["piano", "stab"], rhodes: ["rhodes", "stab"], pad: ["pad"] };

  function generate(T, seed) {
    const r = rng(seed), range = (a, b) => a + (b - a) * r(), int = (a, b) => Math.floor(range(a, b + 1)), chance = p => r() < p, pick = arr => arr[Math.floor(r() * arr.length)];
    /** n distinct steps sampled by weight, excluding some. */
    const steps = (n, w, exclude = []) => {
      const out = [], ex = new Set(exclude);
      for (let k = 0; k < n; k++) {
        let tot = 0; for (let s = 0; s < 16; s++) if (!ex.has(s) && !out.includes(s)) tot += w[s];
        if (tot <= 0) break; let x = r() * tot;
        for (let s = 0; s < 16; s++) { if (ex.has(s) || out.includes(s)) continue; x -= w[s]; if (x <= 0) { out.push(s); break; } }
      }
      return out.sort((a, b) => a - b);
    };
    const g = JSON.parse(JSON.stringify(T));
    g.seed = seed >>> 0; g.code = g.seed.toString(16).toUpperCase().padStart(8, "0").slice(-5);
    g.bpm = Math.round(T.bpm + range(-2, 2));
    g.swing = +clamp(T.swing + range(-0.035, 0.045), 0, 0.26).toFixed(3);
    // hats
    if (T.hat.length) { const d = clamp(T.hat.length / 16 + range(-0.2, 0.2), 0.25, 1); g.hat = []; for (let s = 0; s < 16; s++) if (r() < d * (s % 2 ? 1 : 0.7)) g.hat.push(s); }
    else g.hat = chance(0.25) ? steps(int(2, 4), W_PERC) : [];
    g.hat2 = chance(0.4) ? steps(int(1, 3), W_PERC) : (T.hat2 || []).slice();
    g.open = T.open.length ? (chance(0.75) ? [2, 6, 10, 14] : pick([[2, 10], [6, 14], [2, 6, 10, 14, 15], [2, 6, 10, 13, 14]])) : (chance(0.3) ? [6, 14] : []);
    // clap: keep the backbeat, sometimes add a ghost
    g.clap = T.clap.slice(); if (chance(0.3)) g.clap.push(pick([7, 14, 15])); g.clap = [...new Set(g.clap)].sort((a, b) => a - b);
    // shaker
    if (T.shaker.length) g.shaker = chance(0.5) ? [...Array(16).keys()] : steps(int(6, 12), W_PERC.map(x => x + 0.3));
    // percussion: same palette as the style, new placement
    const types = [...new Set(T.perc.map(p => p[1]))];
    if (types.length) { const n = clamp(T.perc.length + int(-1, 2), 1, 10); g.perc = steps(n, W_PERC).map(s => [s, pick(types)]); }
    else g.perc = chance(0.35) ? [[pick([3, 7, 11, 15]), "rim"]] : [];
    const palette = types.length ? types : ["rim", "cHi"];
    g.dropPerc = steps(int(1, 3), W_PERC, g.perc.map(p => p[0])).map(s => [s, pick(palette)]);
    // bassline: 2-bar phrase, notes placed by weight, intervals from the style's own set plus chord tones
    const bt = chance(0.7) ? T.bass.type : pick(BASS_ALT[T.bass.type] || [T.bass.type]);
    const ivSet = [...new Set(T.bass.notes.map(n => n[1]).concat([0, 0, 0, 12, 7]))];
    const nB = clamp(T.bass.notes.length + int(-2, 2), 3, 14), maxLen = bt === "sub" || bt === "reese" ? 4 : 2;
    const usesDown = T.bass.notes.some(n => n[0] % 4 === 0);
    const mk = st => st.map((s, i) => { const nx = i + 1 < st.length ? st[i + 1] : 16; return [s, chance(0.5) ? 0 : pick(ivSet), clamp(nx - s, 1, maxLen), chance(0.35) ? 1 : 0, bt === "acid" && chance(0.35) ? 1 : 0]; });
    const bStepsA = steps(nB, usesDown || bt === "sub" ? W_SUB : W_OFF);
    g.bass = { type: bt, notes: mk(bStepsA) };
    const keep = bStepsA.filter(s => s < 12), tail = steps(clamp(int(1, 4), 1, 4), (usesDown ? W_SUB : W_OFF).map((w, s) => s >= 12 ? w : 0));
    g.bass.notesB = mk([...keep, ...tail]);
    // chords
    if (T.chords) {
      const tone = chance(0.6) ? T.chords.tone : pick(TONE_ALT[T.chords.tone] || [T.chords.tone]);
      let hits;
      if (tone === "pad") hits = chance(0.6) ? [[0, 16]] : [[0, 8], [8, 8]];
      else { const st = steps(clamp(T.chords.hits.length + int(-1, 1), 1, 5), W_CH); hits = st.map((s, i) => [s, tone === "stab" ? 1 : clamp((i + 1 < st.length ? st[i + 1] : 16) - s, 1, 3)]); }
      g.chords = { hits, tone, dub: !!T.chords.dub || (tone === "stab" && chance(0.3)) };
    } else g.chords = chance(0.12) ? { hits: [[pick([3, 6, 7, 11]), 1]], tone: "stab", dub: true } : null;
    g.inv = int(0, 2);
    // lead motif
    if (T.lead) { const st = steps(int(3, 5), [1, 0, .8, .7, 0, 0, .9, 0, .8, 0, .9, .6, 0, 0, .8, 0]); g.lead = { tone: T.lead.tone, every: pick([1, 2, 2, 4]), notes: st.map(s => [s, pick([0, 3, 5, 7, 10, 12, 15]), int(1, 3)]) }; }
    if (T.arp) g.arp = steps(int(4, 7), W_ARP);
    // vocal chops
    if (T.chops) { const n = clamp(T.chops.length + int(-1, 1), 1, 5); g.chops = steps(n, W_PERC).map(s => [s, int(0, 7), pick([1, 1, 2])]); g.chopDrive = !!T.chopDrive || chance(0.15); }
    else g.chops = chance(0.25) ? [[pick([7, 11, 15]), int(0, 7), 1]] : null;
    g.hookRank = int(0, 2);
    g.fill = T.fill ? chance(0.85) : chance(0.3);
    // sound design
    g.snd = { kf0: range(140, 175), kf1: range(42, 56), kdec: range(0.3, 0.45), clapF: range(1000, 1700), hatF: range(7000, 9500),
      bassCut: range(0.7, 1.4), bassQ: range(0.7, 1.3), verb: range(0.25, 0.45), dlyFb: range(0.22, 0.45), dlyBeats: pick([0.75, 0.75, 0.5, 0.375]) };
    return g;
  }
  return { generate, rng };
})();
if (typeof module !== "undefined") module.exports = Gen;
