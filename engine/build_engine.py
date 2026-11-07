"""Bundle the shared production engine (from the browser app's sources) into a Node module.
Run: python3 engine/build_engine.py  ->  engine/rework-engine.js
The browser app and the server render the same way because they run the same code."""
import pathlib
APP = pathlib.Path(__file__).resolve().parents[2] / "house-rework"
SRC = APP / "src"
html = (APP / "index.html").read_text()
a = html.index("/* ---------------- Crate data ---------------- */")
b = html.index("/* ---------------- State ---------------- */")
styles = html[a:b]  # crate data, STYLES, PROG, QUAL, NOTES, mtof
parts = [
    '"use strict";',
    "const { OfflineAudioContext } = require('node-web-audio-api');",
    "const window = { OfflineAudioContext, AudioContext: OfflineAudioContext };",
    styles,
    (SRC / "engine.js").read_text(),
    (SRC / "voices.js").read_text(),
    (SRC / "generator.js").read_text().replace('if (typeof module !== "undefined") module.exports = Gen;', ""),
    (SRC / "sequencer.js").read_text(),
    (SRC / "analysis.js").read_text().replace('if (typeof module !== "undefined") module.exports = Analysis;', ""),
    (SRC / "dsp-worker.js").read_text().split('if (typeof self !== "undefined"')[0],
    (SRC / "core.js").read_text(),
    "module.exports = { A, STYLES, Gen, Analysis, DSP, analyse, renderOffline, wavBytes, stretchS, pitchQ, rate, barSong, barOut, shiftSemis,",
    "  setRendering: v => { rendering = v; } };",
]
out = pathlib.Path(__file__).with_name("rework-engine.js")
out.write_text("\n".join(parts))
print("wrote", out, out.stat().st_size, "bytes")
