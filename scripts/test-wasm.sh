#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -f target/local-toolchain.env ]]; then source target/local-toolchain.env; fi
cargo build --locked --release -p session-parser --bins
bash scripts/build-wasm.sh
node scripts/check-wasm.mjs
