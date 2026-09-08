#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Optional, ignored developer override; CI uses the pinned repository toolchain.
if [[ -f target/local-toolchain.env ]]; then source target/local-toolchain.env; fi
command -v cargo >/dev/null || { echo "Install Rust using rustup before building." >&2; exit 1; }
command -v wasm-bindgen >/dev/null || { echo "Install wasm-bindgen-cli 0.2.100 before building." >&2; exit 1; }
[[ "$(wasm-bindgen --version)" == "wasm-bindgen 0.2.100" ]] || { echo "wasm-bindgen-cli 0.2.100 is required to match Cargo.lock." >&2; exit 1; }
cargo build --locked --release --target wasm32-unknown-unknown -p session-parser --lib
mkdir -p src/wasm
wasm-bindgen --target web --out-dir src/wasm --out-name session_parser target/wasm32-unknown-unknown/release/session_parser.wasm
