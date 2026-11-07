"""Package-readiness checks for problems found in the pre-run audit (7 Nov 2026)."""
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_gpu_image_has_a_c_compiler():
    """diffq (pulled in by audio-separator 0.48.0) has no cp312 wheel and builds a Cython C extension;
    debian_slim has no compiler, so the GPU image build fails without build-essential."""
    src = (ROOT / "modal_app.py").read_text()
    gpu = src[src.index("gpu_image = "):src.index("# CPU image")]
    assert "audio-separator==" in gpu
    assert '"build-essential"' in re.search(r"\.apt_install\(([^)]*)\)", gpu).group(1)


def test_deploy_url_is_captured_from_wide_output():
    """rework.sh widens Modal's output (rich wraps at 80 columns when piped) and extracts the web URL."""
    sh = (ROOT / "rework.sh").read_text()
    assert "COLUMNS=250 .venv/bin/modal deploy" in sh
    pattern = re.search(r"grep -Eo '([^']+)'", sh).group(1)
    host = "a" * 50 + "--ai-house-rework-web.modal.run"           # a long workspace name: label near DNS limit
    line = f"│   └── 🔨 Created web function web => https://{host} 🔑"
    out = subprocess.run(["grep", "-Eo", pattern], input=line, capture_output=True, text=True).stdout.strip()
    assert out == f"https://{host}"


def test_rework_sh_syntax_and_selftest_assets():
    assert subprocess.run(["bash", "-n", str(ROOT / "rework.sh")]).returncode == 0
    for f in ("selftest.py", "eval/approve.py", "eval/songs.csv", "eval/songs/.gitkeep", "tests/real_voice_mix.wav",
              "engine/rework-engine.js", "engine/render.js", "engine/package.json"):
        assert (ROOT / f).exists(), f
