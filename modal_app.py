"""Deploy the rework pipeline on Modal: AI separation on an L4 GPU, everything else on CPU.

    modal deploy modal_app.py          # creates the web endpoint
    modal run modal_app.py --song song.mp3 --style pawsa --out rework.wav

NOT YET DEPLOYED OR TESTED ON MODAL. Written against Modal's documented Python API; expect small fixes on first deploy.
The pipeline code it calls (pipeline.py, engine/) is tested locally (see tests/).
"""
import modal

app = modal.App("ai-house-rework")
models = modal.Volume.from_name("rework-models", create_if_missing=True)

base = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("nodejs", "npm", "ffmpeg")
    .pip_install("torch", "torchaudio", "audio-separator", "audioread", "soundfile", "fastapi[standard]", "python-multipart")
    .add_local_dir("engine", "/root/app/engine", copy=True, ignore=["node_modules"])
    .run_commands("cd /root/app/engine && npm install")
    .add_local_file("pipeline.py", "/root/app/pipeline.py")
)


@app.function(image=base, gpu="L4", volumes={"/models": models}, timeout=900)
def separate(song: bytes, filename: str = "song") -> bytes:
    """Stage 1 on GPU: return the vocal stem as WAV bytes. The model is cached on the volume after the first run."""
    import os, sys, tempfile
    from pathlib import Path
    os.environ["REWORK_MODEL_DIR"] = "/models"
    sys.path.insert(0, "/root/app")
    import pipeline
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / filename
        p.write_bytes(song)
        vocal = pipeline.separate_vocal(p, Path(tmp))
        data = vocal.read_bytes()
    models.commit()
    return data


@app.function(image=base, cpu=2.0, memory=4096, timeout=900)
def render(song: bytes, vocal: bytes, style: str, seed: int | None = None, pitch: str = "natural") -> tuple[bytes, dict]:
    """Stages 2-6 on CPU: analysis, unique beat, arrangement, render. Returns (WAV bytes, report)."""
    import sys, tempfile
    from pathlib import Path
    sys.path.insert(0, "/root/app")
    import pipeline
    with tempfile.TemporaryDirectory() as tmp:
        t = Path(tmp)
        (t / "song").write_bytes(song)
        (t / "vocal.wav").write_bytes(vocal)
        rep = pipeline.render(t / "song", t / "vocal.wav", style, t / "out.wav", seed=seed, pitch=pitch)
        return (t / "out.wav").read_bytes(), rep


@app.function(image=base, timeout=1800)
@modal.fastapi_endpoint(method="POST")
def rework(payload: dict) -> dict:
    """POST {"song_b64": ..., "style": "pawsa", "seed": null} -> {"wav_b64": ..., "report": {...}}.
    Prototype endpoint without accounts or a rights check: keep it private (do not publish the URL)."""
    import base64
    song = base64.b64decode(payload["song_b64"])
    vocal = separate.remote(song)
    wav, rep = render.remote(song, vocal, payload.get("style", "pawsa"), payload.get("seed"), payload.get("pitch", "natural"))
    return {"wav_b64": base64.b64encode(wav).decode(), "report": rep}


@app.local_entrypoint()
def main(song: str, style: str = "pawsa", out: str = "rework.wav", seed: int | None = None):
    from pathlib import Path
    data = Path(song).read_bytes()
    vocal = separate.remote(data, Path(song).name)
    wav, rep = render.remote(data, vocal, style, seed)
    Path(out).write_bytes(wav)
    print(rep)
