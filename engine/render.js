/* Render worker: song (+ optional AI-separated vocal) + style -> finished rework WAV + JSON report.
   Usage: node render.js job.json
   job.json: { mix, vocal?, style, seed?, pitch?, intro?, outro?, trim?, out, report?, analysisOut?, analysisIn?, vocalOut? }
   - analysisOut: save the song analysis (tempo, grid, chords, key, vocal activity) as JSON
   - analysisIn:  reuse a saved analysis: skips decoding and analysing the song (used by "new beat"); needs `vocal`
   - vocalOut:    write the vocal actually used (22.05 kHz mono WAV), so a later run can reuse it
   - mix:   path to the original song (wav/mp3/m4a/flac)
   - vocal: path to an AI-separated vocal stem (wav). Omit to fall back to the built-in DSP extraction.
   Every number in the report comes from the analysis of this song; nothing is filled in by default. */
"use strict";
const fs = require("fs");
const { OfflineAudioContext, AudioBuffer } = require("node-web-audio-api");
const E = require("./rework-engine.js");
const SR = 22050, MAX_SEC = 360;

async function decode(path) {
  const bytes = fs.readFileSync(path);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new OfflineAudioContext(2, 1, 44100).decodeAudioData(ab);
}
async function resample(buf, channels) {
  const dur = Math.min(buf.duration, MAX_SEC);
  const off = new OfflineAudioContext(channels, Math.ceil(dur * SR), SR);
  const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start(0);
  return off.startRendering();
}
const timed = async (t, k, fn) => { const s = Date.now(); const r = await fn(); t[k] = Date.now() - s; return r; };

function writeWavMono(path, x, sr) {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(path, b);
}

async function run(job) {
  const t = {}, A = E.A;
  if (!E.STYLES[job.style]) throw new Error(`unknown style "${job.style}"; choose one of ${Object.keys(E.STYLES).join(", ")}`);
  if (job.analysisIn) return runCached(job, t);
  const mix = await timed(t, "decode_ms", () => decode(job.mix));
  // tempo and beat grid from the original mix
  const tempo = await timed(t, "tempo_ms", async () => E.analyse(mix));
  if (!tempo) throw new Error("song too short to analyse (needs a few seconds of audio)");
  A.srcBpm = tempo.bpm; A.offset = tempo.offset;
  // harmony (chroma) from the full mix; DSP vocal kept only as a fallback
  const m22 = await resample(mix, 2);
  const L = m22.getChannelData(0).slice(0), R = (m22.numberOfChannels > 1 ? m22.getChannelData(1) : m22.getChannelData(0)).slice(0);
  const sepMix = await timed(t, "mix_analysis_ms", async () => E.DSP.separate(L, R, SR, {}, () => {}));
  // vocal: AI stem when given, else DSP extraction
  let vocRaw, vact, vocalSource;
  if (job.vocal) {
    const v = await resample(await decode(job.vocal), 1);
    vocRaw = v.getChannelData(0).slice(0);
    const sepV = await timed(t, "vocal_analysis_ms", async () => E.DSP.separate(vocRaw, vocRaw, SR, { acappella: true }, () => {}));
    vact = sepV.vact.length === sepMix.vact.length ? sepV.vact : sepV.vact.slice(0, sepMix.vact.length);
    vocalSource = "ai-stem";
  } else { vocRaw = sepMix.vocal; vact = sepMix.vact; vocalSource = "dsp-fallback"; }
  A.sep = { ...sepMix, vact };
  // which beat starts the bar (tempo analysis gives the beat phase only)
  const db = E.Analysis.detectDownbeat(sepMix, tempo);
  A.offset = db.offset;
  // bars, chords, key, vocal activity, arrangement
  const dur = Math.min(mix.duration, MAX_SEC);
  A.nBars = Math.max(1, Math.floor((dur - A.offset) / E.barSong()));
  A.chords = E.Analysis.detectChords(A.sep, A.offset, E.barSong(), A.nBars);
  A.songKey = E.Analysis.detectKey(A.sep);
  A.va = E.Analysis.vocalPerBar(A.sep, A.offset, E.barSong(), A.nBars);
  const analysis = { version: 1, songSeconds: +mix.duration.toFixed(3), srcBpm: A.srcBpm, offset: A.offset, nBars: A.nBars, chords: A.chords,
    songKey: A.songKey, va: A.va, mono: sepMix.mono, vocalSource, downbeatConf: db.conf };
  if (job.analysisOut) fs.writeFileSync(job.analysisOut, JSON.stringify(analysis));
  if (job.vocalOut) writeWavMono(job.vocalOut, vocRaw, SR);
  return finish(job, t, analysis, vocRaw, false);
}

/** New beat from a saved analysis + saved vocal: no decoding, separation or analysis of the song. */
async function runCached(job, t) {
  const A = E.A;
  if (!job.vocal) throw new Error("analysisIn needs the saved vocal (job.vocal)");
  const an = JSON.parse(fs.readFileSync(job.analysisIn, "utf8"));
  if (an.version !== 1) throw new Error(`unsupported analysis version ${an.version}`);
  Object.assign(A, { srcBpm: an.srcBpm, offset: an.offset, nBars: an.nBars, chords: an.chords, songKey: an.songKey, va: an.va });
  const v = await resample(await decode(job.vocal), 1);
  return finish(job, t, an, v.getChannelData(0).slice(0), true);
}

async function finish(job, t, an, vocRaw, cached) {
  const A = E.A;
  A.intro = job.intro ?? 8; A.outro = job.outro ?? 8; A.trim = job.trim ?? true; A.form = "full"; A.harmony = job.harmony || "song";
  A.arr = E.Analysis.arrange({ va: A.va, chords: A.chords, nBars: A.nBars, intro: A.intro, outro: A.outro, trimGaps: A.trim, overrides: job.overrides || {} });
  // a beat unique to this rework
  A.style = job.style; A.seed = (job.seed ?? (Math.random() * 4294967296)) >>> 0;
  A.groove = E.Gen.generate(E.STYLES[A.style], A.seed); A.target = A.groove.bpm;
  A.mix.pump = E.STYLES[A.style].pump; A.pitch = job.pitch ?? "natural";
  // fit the vocal to the new tempo (pitch kept unless pitch === "tempo")
  const y = await timed(t, "stretch_ms", async () => E.DSP.stretch(vocRaw, E.stretchS()));
  const vb = new AudioBuffer({ length: y.length, numberOfChannels: 1, sampleRate: SR }); vb.copyToChannel(y, 0);
  A.voc = vb; A.vocS = E.stretchS();
  const out = await timed(t, "render_ms", () => E.renderOffline());
  fs.writeFileSync(job.out, E.wavBytes(out));
  const report = {
    style: E.STYLES[A.style].name, style_id: A.style, beat_code: A.groove.code, seed: A.seed, vocal_source: an.vocalSource, analysis_cached: cached,
    song: { seconds: +an.songSeconds.toFixed(1), bpm: A.srcBpm, first_downbeat_s: +A.offset.toFixed(3), downbeat_conf: an.downbeatConf ?? null, key: A.songKey, mono: an.mono, bars: A.nBars,
      chords_confident: A.chords.filter(c => c.ok).length },
    rework: { bpm: A.target, seconds: +out.duration.toFixed(1), bars: A.arr.bars.length, sections: A.arr.blocks.map(b => `${b.type}:${b.len}`),
      vocal_pitch: A.pitch, bass: A.groove.bass.type, swing: A.groove.swing },
    timings_ms: t,
  };
  if (job.report) fs.writeFileSync(job.report, JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) {
  const job = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  run(job).then(r => { console.log(JSON.stringify(r)); process.exit(0); })
    .catch(e => { console.error(JSON.stringify({ error: String(e && e.message || e) })); process.exit(1); });
}
module.exports = { run };
