# AI House Rework — server prototype

Pick a song and a style; the server returns a finished house rework built around the song's vocal, with a beat
generated uniquely for that rework.

```
song ──► AI vocal separation (BS-RoFormer, GPU) ──► tempo · key · chords · vocal activity ──► unique beat
     ──► arrangement (intro / groove / build / drop / break / outro) ──► render ──► WAV + report
```

Stage 1 is a trained model (PyTorch, via `audio-separator`). Stages 2–6 run in `engine/rework-engine.js`, which is
**bundled from the browser app's own source files**, so the browser app and the server produce the same rework for
the same song, style and seed.

## Layout

| Path | What it is |
| --- | --- |
| `pipeline.py` | The pipeline and a CLI: separation, then render. Fails closed: if AI separation is requested and unavailable, it stops with the reason; it never falls back silently. |
| `service.py` | Job API, rights gate, per-song cache (vocal + analysis), timing and cost metrics. Shared by local and Modal. |
| `app.py` | Local server on `service.py`: `POST /reworks`, `GET /reworks/{id}`, `/audio`, `/stem`, `/analysis`, `POST /reworks/{id}/new-beat`. |
| `engine/render.js` | Render worker: analysis, unique beat, arrangement, offline render (Web Audio for Node). |
| `engine/build_engine.py` | Rebuilds `rework-engine.js` from `../house-rework/src` after engine changes. |
| `modal_app.py` | Deployment on Modal: separation on an L4 GPU, render on CPU, the same API. **Not yet deployed.** |
| `rework.sh` | Setup, deploy, selftest, approve, eval, report: one command each, from a Mac. |
| `eval/` | Evaluation harness: manifest template, runner, measurements, report, listening protocol, negative results. |
| `tests/` | Synthetic test song with a known vocal, chords and tempo; API tests. |

## Deploy on Modal and run the evaluation (from your Mac)

```bash
bash rework.sh setup      # installs tools in .venv, signs in to Modal in the browser, creates the API key (eval/.env)
bash rework.sh deploy     # builds and deploys; saves the API URL to eval/.env
bash rework.sh selftest   # full rework + new beat on the bundled test clip; prints GPU/CPU time and cost
```

Then the evaluation:

1. Only after the self-test passes: put 20–30 songs (WAV, AIFF, FLAC or MP3) you own or have permission to use in `eval/songs/`.
2. Fill in `eval/songs.csv` (examples in `eval/songs.template.csv`), one row per song, **in the order they will be judged**.
   Fill in the rights basis and who confirmed it, and the ground truth (BPM, first downbeat time in seconds, key;
   chords per bar if you have them) **before** running anything. Write `unknown` where you don't know.
3. `bash rework.sh approve` records rights approvals (file SHA-256 + rights basis). Unapproved files are refused.
4. `bash rework.sh eval` runs every song and freezes the ground truth (`eval/truth.lock`).
5. Listen and fill in `eval/runs/<run>/scorecard.csv` following `eval/LISTENING.md`.
6. `bash rework.sh report` writes `results.md` with per-song results, failures by stage, the 16/20 gate, timing and cost.

For a retest after a fix: `bash rework.sh eval --only my-song,other-song --run-id retest-1` (ids are the file names without extension).

## Run it locally

```bash
pip install --index-url https://download.pytorch.org/whl/cpu torch torchaudio   # or the CUDA build on a GPU box
pip install -r requirements.txt
(cd engine && npm install)
python pipeline.py song.mp3 --style pawsa --out rework.wav            # AI separation (downloads the model once)
python pipeline.py song.mp3 --style afro --no-ai --out quick.wav      # DSP fallback, no GPU, lower quality
REWORK_USE_AI=0 REWORK_ALLOW_UNVERIFIED_UPLOADS=1 uvicorn app:app     # local API (internal testing only)
python -m pytest -q tests/                                            # 17 tests, about 3 minutes
```

## Rights check

`POST /reworks` accepts a file only if its exact audio (SHA-256) is in `rights/approved.json` with a recorded rights
basis and confirmer (`bash rework.sh approve`). On a local machine, `REWORK_ALLOW_UNVERIFIED_UPLOADS=1` also allows
uploads for internal testing; that switch is ignored on Modal. Before any public use, approvals must come from audio
fingerprinting against cleared catalogue. See the plan document's licensing section.

## Measured so far

See `RESULTS.md` for the numbers from this machine (2 CPU cores, no GPU).

## Known limits

- The separation model's licence must be confirmed for commercial use before launch (the `audio-separator` library itself is MIT).
- Chord detection uses chroma templates (major/minor triads); a trained chord model is the planned upgrade.
- Sounds are synthesised; licensed one-shot samples are the planned upgrade for production quality.
- Tested only on synthetic audio so far. Real songs are the next test.
