#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# Prerequisites: uv, micromamba and patch. Downloads public package sources.
micromamba --version
uv venv --python 3.13 .env
uv pip install --python .env/bin/python -r requirements-build.txt requests
.env/bin/python prepare_pytensor_wheel.py
.env/bin/python prepare_marketing_wheel.py
mkdir -p content
PATH="$PWD/.env/bin:$PATH" jupyter lite build --contents content --output-dir _output --XeusAddon.empack_config=empack_config.yaml
.env/bin/python assemble.py
node ../configure-runtime.mjs runtime pymc-marketing-wasm --export-memory
