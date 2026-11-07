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
| `app.py` | FastAPI job API: `POST /reworks`, `GET /reworks/{id}`, `GET /reworks/{id}/audio`, `POST /reworks/{id}/new-beat`, `GET /styles`. |
| `engine/render.js` | Render worker: analysis, unique beat, arrangement, offline render (Web Audio for Node). |
| `engine/build_engine.py` | Rebuilds `rework-engine.js` from `../house-rework/src` after engine changes. |
| `modal_app.py` | Deployment on Modal: separation on an L4 GPU, render on CPU. **Not yet deployed.** |
| `tests/` | Synthetic test song with a known vocal, chords and tempo; API tests. |

## Run it

```bash
pip install --index-url https://download.pytorch.org/whl/cpu torch torchaudio   # or the CUDA build on a GPU box
pip install -r requirements.txt
(cd engine && npm install)

# CLI
python pipeline.py song.mp3 --style pawsa --out rework.wav            # AI separation (downloads the model once)
python pipeline.py song.mp3 --style afro --no-ai --out quick.wav      # DSP fallback, no GPU, lower quality
python pipeline.py song.mp3 --style pawsa --vocal stems/vocals.wav    # reuse a stem: new beat in seconds

# API (internal testing only: see Rights check)
REWORK_ALLOW_UNVERIFIED_UPLOADS=1 uvicorn app:app --port 8000
curl -F file=@song.mp3 -F style=pawsa localhost:8000/reworks

# Tests (DSP fallback, about 1 minute)
python -m pytest -q tests/
```

Styles: `peak bounce minimal melodic afro speedg bibi pawsa cruz beltran rossi lukedean maxdean baker prospa stussy vocal deep piano`.

## Rights check

`POST /reworks` refuses every upload unless `REWORK_ALLOW_UNVERIFIED_UPLOADS=1` is set. That switch is for internal
testing with songs you hold rights to. Before any public use, replace `rights_check()` in `app.py` with audio
fingerprinting against cleared catalogue. See the plan document's licensing section.

## Measured so far

See `RESULTS.md` for the numbers from this machine (2 CPU cores, no GPU).

## Known limits

- The separation model's licence must be confirmed for commercial use before launch (the `audio-separator` library itself is MIT).
- Chord detection uses chroma templates (major/minor triads); a trained chord model is the planned upgrade.
- Sounds are synthesised; licensed one-shot samples are the planned upgrade for production quality.
- Tested only on synthetic audio so far. Real songs are the next test.
