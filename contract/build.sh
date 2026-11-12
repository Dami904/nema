#!/usr/bin/env bash
# Build the NEAR contract into res/nema_contract.wasm.
#
# A quick local build for checking the contract compiles to wasm. It is NOT the
# deployed build: that one comes from `cargo near build reproducible-wasm`, in the
# container Cargo.toml names, and embeds the commit it was built from (NEP-330).
#
# Pass --opt to also shrink it with wasm-opt (needs Node). The optimized file
# has not been run on NEAR yet.
set -euo pipefail
cd "$(dirname "$0")"

RUSTFLAGS="-C target-cpu=mvp -C link-arg=-s" cargo build --target wasm32-unknown-unknown --release

mkdir -p res
if [[ "${1:-}" == "--opt" ]]; then
  npx --yes -p binaryen@123.0.0 wasm-opt \
    target/wasm32-unknown-unknown/release/nema_contract.wasm \
    --enable-sign-ext --enable-reference-types --enable-mutable-globals \
    -Oz --strip-debug --strip-producers \
    -o res/nema_contract.wasm
else
  cp target/wasm32-unknown-unknown/release/nema_contract.wasm res/nema_contract.wasm
fi

ls -l res/nema_contract.wasm
sha256sum res/nema_contract.wasm
