# Prototype results — 7 November 2026

Machine: 2 CPU cores, no GPU. All numbers below were measured on this machine unless marked otherwise.

## Vocal separation: AI model vs the browser method

Test mix: a real human voice (LibriVox public-domain reading, *The Ashiel Mystery*, ch. XVI, read by Garth Comira),
centred over a real drum-and-bass loop (Admiral Bob, *Choice*, CC BY). 14 seconds; the first 2 seconds are backing
only. The backing is mono, so it sits in the centre with the voice, as in many older recordings. Because the true
voice is known, each estimate can be scored against it (`tests/eval_separation.py`, backing-only window 1.9 s).

| Vocal estimate | Correlation with true voice | SDR | Backing leaking into silent part |
| --- | --- | --- | --- |
| Raw mix (no separation) | 0.953 | 10.0 dB | −13.7 dB |
| Browser DSP (centre channel + drum removal) | 0.742 | 0.9 dB | −19.1 dB |
| **AI: BS-RoFormer (`model_bs_roformer_ep_317_sdr_12.9755.ckpt`)** | **0.996** | **20.8 dB** | **−52.0 dB** |

The AI model removes the backing almost completely where the browser method fails, because the browser method
relies on stereo position and this backing is centred.

On the fully synthetic test song (centred synth tone as the "vocal", hard-panned keys) the browser method scores
0.996 correlation, and the AI model returns near-silence: it is trained to find human voices and does not treat a
synthetic tone as one. Synthetic audio therefore cannot test the AI stage; real recordings are required.

## End-to-end run (AI pipeline)

`python pipeline.py real_mix.wav --style pawsa --seed 7` produced a 42.5 s stereo 44.1 kHz WAV (beat code 00007):
intro 8 bars, drop 5 bars, outro 8 bars, at 126 BPM from a detected 90.2 BPM song.

| Stage | Time on 2 CPU cores |
| --- | --- |
| AI vocal separation (14 s of audio) | 314 s |
| Tempo, mix analysis, vocal analysis, stretch | 0.4 s |
| Render (42.5 s of output) | 8.4 s |

Separation on CPU is far too slow for a product (about 22× slower than real time here). Published benchmarks put
BS-RoFormer at 1.5–3× faster than real time on a GPU; that has **not** been measured yet. The next step is the same
run on a Modal L4 GPU to get real per-song cost and time.

## Tests

- `tests/test_api.py`: 4 passed (rights check refuses uploads by default, bad input, full rework, new beat on the same vocal, corrupt file reports failure).
- Browser engine (`../house-rework/tests`): DSP separation, chord detection (24/24 on the synthetic song), generator (3,800 beats, 0 invalid, 200/200 distinct per style), full-engine integration.

## Not yet tested

- Any real commercial song (none available here with rights).
- GPU speed and cost; the Modal deployment (`modal_app.py`).
- Tempo and chord accuracy on real songs (the voice test above is speech, not singing, over a loop).

Test audio credits: LibriVox recording (public domain); "Choice" by Admiral Bob (CC BY), via the librosa example data.

## Harness dry run — 7 November 2026 (local CPU, DSP separation; not part of the evaluation)

Three test songs with known answers (two synthetic songs at 100 and 118 BPM with known downbeats and chords, and the
voice-over-loop clip) were run through the full harness against the local server.

| Finding | Stage | Evidence | Action |
| --- | --- | --- | --- |
| Bars started on the wrong beat | 2 analysis | Downbeat off by exactly one beat (598 ms, 505 ms) while beat phase was right within 3 ms; 3/8 synthetic cases correct | **Fixed**: downbeat detection; 8/8 within 60 ms (worst 9 ms); chord accuracy 0.75 → 1.0 |
| Masters quiet; one true peak over the limit | 6 master | −15 to −18 LUFS integrated; true peak −0.17 dBTP on one song | **Not fixed yet** (failure-first: wait for listening results on earlier stages) |
| Status reads returned HTTP 500 during writes | service | Concurrent read saw a half-written status file | Fixed: atomic writes; regression test fails on old code |
| Booleans stored as the string "False" | harness | numpy booleans serialised as text | Fixed; regression test |
| Chord accuracy compared unaligned bars | harness | Lists starting at different bars | Fixed: bars aligned by time; regression test |
