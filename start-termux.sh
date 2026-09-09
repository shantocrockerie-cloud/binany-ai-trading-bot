#!/data/data/com.termux/files/usr/bin/bash
set -e
cd "$(dirname "$0")"
[ -d .venv ] || python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
[ -f .env ] || cp .env.example .env
exec uvicorn app.main:app --host 0.0.0.0 --port 8082
