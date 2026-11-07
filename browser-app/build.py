"""Assemble index.html from src/. Run: python3 build.py"""
import re, pathlib
S = pathlib.Path("src")
base = (S/"base-v4.html").read_text()
read = lambda n: (S/n).read_text()

# deck markup
a = base.index('<section class="panel" id="deck"'); b = base.index('</section>', a) + len('</section>')
page = base[:a] + read("deck.html").strip() + base[b:]

# script: keep crate data + styles from base, swap the engine
js0 = page.index("/* ---------------- State ---------------- */")
js1 = page.index("/* ---------------- Crate ---------------- */")
engine = "\n".join([read("engine.js"), read("voices.js"), read("generator.js"), read("sequencer.js"), read("analysis.js"), read("core.js"), read("app.js")])
page = page[:js0] + engine + "\n" + page[js1:]

# crate: reset the new state when a song is chosen
old = 'if(A.buf){A.buf=null;A.peaks=null;A.srcBpm=null;if(playing)stop();}\n  A.songKey=-1;$("#songKey").value=-1;'
assert old in page, "crate reset block not found"
page = page.replace(old, 'if(playing)stop();\n  Object.assign(A,{buf:null,peaks:null,srcBpm:null,sep:null,vocRaw:null,voc:null,vocS:null,arr:null,chords:null,songKey:null,va:null,overrides:{}});')

# worker source as inert script, read at runtime into a blob Worker
worker = read("dsp-worker.js")
assert "</script" not in worker
page = page.replace("<script>\n\"use strict\";", '<script type="text/plain" id="dspSrc">\n' + worker + '\n</script>\n<script>\n"use strict";', 1)

# extra CSS
css = """
.prog{display:flex;flex-direction:column;gap:4px}
.prog .bar{height:6px;border-radius:999px;background:#1d2a45;overflow:hidden}
.prog .bar i{display:block;height:100%;width:0;background:var(--accent);transition:width .2s}
.prog span{font-size:12.5px;color:var(--mute);font-family:var(--mono)}
#wave{height:84px} #arr{height:62px}
.spec{height:56px}
.linkbtn{background:none;border:0;padding:0;color:var(--cool);text-decoration:underline;cursor:pointer;font:inherit}
.btn:disabled,.chip:disabled{opacity:.45;cursor:not-allowed}
.pattern{display:flex;flex-direction:column;gap:3px;overflow-x:auto}
.prow{display:grid;grid-template-columns:52px repeat(16,minmax(10px,1fr));gap:3px;align-items:center}
.prow span{font-size:11px;font-family:var(--mono);color:var(--mute)}
.prow i{height:12px;border-radius:2px;background:#1d2a45}
.prow i.q{background:#24345a}
.prow i.on{background:var(--cool)}
.prow:first-child i.on{background:var(--accent)}
"""
page = page.replace("</style>", css + "</style>", 1)
page = page.replace("<footer>Everything runs in your browser. Drums, bass and chords are synthesised live; nothing is uploaded.</footer>",
 "<footer>Everything runs in your browser: vocal extraction, analysis and the new production. Nothing is uploaded.</footer>")
old_tag = "Pick a 60s–90s song, load your copy of the track, and the deck re-tempos it onto a four-on-the-floor house groove in the style of 2026 club sounds: peak-time tech, Afro house, swing minimal, speed garage and more."
assert old_tag in page
page = page.replace(old_tag, "Pick a 60s–90s song and load your copy. The deck pulls out the vocal, reads the chords and rebuilds the whole song as house in the style you choose, from PAWSA-style minimal to Afro house.")
pathlib.Path("index.html").write_text(page)
print("built index.html", len(page), "bytes")
