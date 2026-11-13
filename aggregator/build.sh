#!/usr/bin/env bash
# Builds the enclave module the way it is deployed: in a pinned Linux container,
# so the same source gives the same wasm hash on any machine with Docker. The
# paths baked into the wasm (panic locations) are the container's, not the
# builder's. Prints the sha256 that the secret lock and web/src/lib/config.ts pin.
#
#   aggregator/build.sh            # writes target/enclave/nema-aggregator.wasm
set -euo pipefail

IMAGE="rust:1.96.0-slim-bookworm@sha256:4732ca96fd086cb9be682050c3f0176288eebaac2b80aa2bcefccfaf198e1950"

cd "$(dirname "$0")/.."
# Docker on Windows wants C:/..., which Git Bash's pwd does not give.
root="$(pwd -W 2>/dev/null || pwd)"
mkdir -p target/enclave

MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$root:/nema" -w /nema \
  -e CARGO_TARGET_DIR=/build \
  "$IMAGE" \
  sh -c 'cargo build --locked -p nema-aggregator --release --target wasm32-wasip2 \
    && cp /build/wasm32-wasip2/release/nema-aggregator.wasm /nema/target/enclave/nema-aggregator.wasm'

sha256sum target/enclave/nema-aggregator.wasm
