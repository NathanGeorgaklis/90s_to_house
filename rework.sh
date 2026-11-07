#!/usr/bin/env bash
# One script for the Modal deployment and the evaluation. Run from this folder on your Mac.
#   ./rework.sh setup      install tools, sign in to Modal (opens the browser), create the API key
#   ./rework.sh deploy     deploy to Modal and save the API URL
#   ./rework.sh selftest   full rework + new beat on the bundled test clip; prints timing and cost
#   ./rework.sh approve    record rights approvals for every song in eval/songs.csv
#   ./rework.sh eval       run every song in eval/songs.csv through the deployed API
#   ./rework.sh report     build results for the latest run (after you fill in its scorecard)
set -euo pipefail
cd "$(dirname "$0")"
PY=.venv/bin/python
ENV=eval/.env

venv() {
  if [ ! -x "$PY" ]; then python3 -m venv .venv; fi
  "$PY" -m pip install -q --upgrade pip
  "$PY" -m pip install -q modal requests numpy scipy soundfile pyloudnorm
}

case "${1:-help}" in
  setup)
    venv
    .venv/bin/modal token info >/dev/null 2>&1 || .venv/bin/modal setup
    if .venv/bin/modal secret list 2>/dev/null | grep -q "rework-api"; then
      echo "Modal secret rework-api already exists."
      grep -q REWORK_API_KEY "$ENV" 2>/dev/null || echo "WARNING: $ENV has no REWORK_API_KEY. Delete the secret in the Modal dashboard and rerun setup to create a matching key."
    else
      KEY=$(openssl rand -hex 24)
      .venv/bin/modal secret create rework-api REWORK_API_KEY="$KEY" >/dev/null
      touch "$ENV"; grep -v '^REWORK_API_KEY=' "$ENV" > "$ENV.tmp" || true; mv "$ENV.tmp" "$ENV"
      echo "REWORK_API_KEY=$KEY" >> "$ENV"; chmod 600 "$ENV"
      echo "Created API key (saved in $ENV, not committed)."
    fi ;;
  deploy)
    out=$(.venv/bin/modal deploy modal_app.py 2>&1 | tee /dev/stderr)
    url=$(echo "$out" | grep -Eo 'https://[A-Za-z0-9.-]*web[A-Za-z0-9.-]*\.modal\.run' | head -1)
    if [ -z "$url" ]; then echo "Could not find the API URL in the deploy output above."; exit 1; fi
    touch "$ENV"; grep -v '^REWORK_API_URL=' "$ENV" > "$ENV.tmp" || true; mv "$ENV.tmp" "$ENV"
    echo "REWORK_API_URL=$url" >> "$ENV"; chmod 600 "$ENV"
    echo "API: $url"
    curl -fsS "$url/health" && echo ;;
  selftest) .venv/bin/modal run modal_app.py::selftest ;;
  approve)  .venv/bin/modal run modal_app.py::approve --manifest eval/songs.csv ;;
  eval)     shift; "$PY" eval/run_eval.py --manifest eval/songs.csv "$@" ;;
  report)   latest=$(ls -d eval/runs/*/ | sort | tail -1); "$PY" eval/report.py "$latest" ;;
  *) sed -n '2,9p' "$0" ;;
esac
