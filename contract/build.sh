#!/usr/bin/env bash
# Build the NEAR contract into res/nema_contract.wasm.
#
# Built with the default (stable) Rust. With Rust 1.96 and near-sys 0.2.14 this
# produced sha256 2f7e8f57...37c1, which testnet ran
# (tx FAD4hwmoA38RwidrrbxnXpBWJZXKZHivsGfDkTzyBTpf). near-sys 0.2.14 needs Rust 1.93+.
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
