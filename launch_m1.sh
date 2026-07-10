#!/bin/sh
# polotno M1: FastAPI canvas server + PixiJS frontend
# open http://127.0.0.1:8901
cd "$(dirname "$0")"
PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
exec ../vqgan-env/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8901
