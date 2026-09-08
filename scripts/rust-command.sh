#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Optional machine-local environment; never committed or included in a build.
if [[ -f target/local-toolchain.env ]]; then source target/local-toolchain.env; fi
exec cargo "$@"
