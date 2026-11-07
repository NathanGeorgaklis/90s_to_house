#!/usr/bin/env bash
# One script for the Modal deployment and the evaluation. Run from this folder: bash rework.sh <command>
#   setup      tools + Modal sign-in (opens the browser) + API key
#   deploy     deploy to Modal; saves the API URL
#   selftest   one real GPU rework + New beat through the deployed API; prints timing and cost
#   approve    record rights approvals for the songs in eval/songs.csv
#   eval       run every song in eval/songs.csv through the deployed API
#   report     build results for the latest run (after the scorecard is filled in)
set -euo pipefail
cd "$(dirname "$0")"
PY=.venv/bin/python
ENV=eval/.env
MODAL_VERSION=1.6.3                       # the client version this project was checked against

die() { echo; echo "STOPPED: $*"; exit 1; }

find_python() {                           # Modal needs Python 3.10+; macOS's built-in python3 is 3.9
  for c in python3.13 python3.12 python3.11 python3.10 python3 /usr/local/bin/python3 /opt/homebrew/bin/python3; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
      command -v "$c"; return 0
    fi
  done
  return 1
}

need_venv() { [ -x "$PY" ] || die "tools are not installed yet. Run: bash rework.sh setup"; }
need_env()  { [ -f "$ENV" ] && grep -q '^REWORK_API_KEY=.' "$ENV" || die "no API key in $ENV. Run: bash rework.sh setup"; }
need_url()  { grep -q '^REWORK_API_URL=https' "$ENV" 2>/dev/null || die "no API URL in $ENV. Run: bash rework.sh deploy"; }

case "${1:-help}" in
  setup)
    P=$(find_python) || die "Python 3.10 or newer is needed (this Mac's python3 is older). Install it from https://www.python.org/downloads/macos/ , then rerun: bash rework.sh setup"
    echo "Using $P ($("$P" --version))"
    [ -x "$PY" ] || "$P" -m venv .venv
    "$PY" -m pip install -q --upgrade pip
    "$PY" -m pip install -q "modal==$MODAL_VERSION" requests==2.34.2 numpy scipy soundfile pyloudnorm
    echo "Tools installed."
    if ! .venv/bin/modal token info >/dev/null 2>&1; then
      echo "Signing in to Modal: a browser window will open. Sign in or create an account, then come back here."
      .venv/bin/modal setup || true
    fi
    .venv/bin/modal token info >/dev/null 2>&1 || die "Modal sign-in did not complete. Rerun: bash rework.sh setup"
    echo "Signed in to Modal."
    mkdir -p eval/songs
    if .venv/bin/modal secret list 2>/dev/null | grep -q "rework-api"; then
      grep -q '^REWORK_API_KEY=.' "$ENV" 2>/dev/null \
        || die "Modal already has a secret named rework-api but this folder has no matching key. Delete 'rework-api' under Secrets in the Modal dashboard, then rerun: bash rework.sh setup"
      echo "API key already set up."
    else
      KEY=$(openssl rand -hex 24)
      .venv/bin/modal secret create rework-api REWORK_API_KEY="$KEY" >/dev/null
      touch "$ENV"; grep -v '^REWORK_API_KEY=' "$ENV" > "$ENV.tmp" || true; mv "$ENV.tmp" "$ENV"
      echo "REWORK_API_KEY=$KEY" >> "$ENV"; chmod 600 "$ENV"
      echo "API key created (saved in $ENV)."
    fi
    echo; echo "SETUP OK" ;;
  deploy)
    need_venv; need_env
    echo "Deploying. The first deploy builds three images (PyTorch with CUDA is large): expect 5-15 minutes."
    out=$(.venv/bin/modal deploy modal_app.py 2>&1 | tee /dev/stderr) || die "modal deploy failed (see the messages above)."
    url=$(echo "$out" | grep -Eo 'https://[A-Za-z0-9.-]*web[A-Za-z0-9.-]*\.modal\.run' | head -1 || true)
    [ -n "$url" ] || die "deploy finished but no API URL was found in its output above."
    grep -v '^REWORK_API_URL=' "$ENV" > "$ENV.tmp" || true; mv "$ENV.tmp" "$ENV"
    echo "REWORK_API_URL=$url" >> "$ENV"; chmod 600 "$ENV"
    echo "API: $url"
    echo "Checking the API answers (the first request can take up to a minute)..."
    curl -fsS --max-time 120 "$url/health" >/dev/null || die "the API did not answer at $url/health."
    echo; echo "DEPLOY OK" ;;
  selftest) need_venv; need_env; need_url; "$PY" selftest.py ;;
  approve)  need_venv; "$PY" eval/approve.py --manifest eval/songs.csv ;;
  eval)     need_venv; need_env; need_url; shift; "$PY" eval/run_eval.py --manifest eval/songs.csv "$@" ;;
  report)   need_venv
            latest=$(ls -d eval/runs/*/ 2>/dev/null | sort | tail -1 || true)
            [ -n "$latest" ] || die "no evaluation runs yet. Run: bash rework.sh eval"
            "$PY" eval/report.py "$latest" ;;
  *) sed -n '2,8p' "$0" ;;
esac
