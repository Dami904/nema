// Checks that eciesjs (what the browser will use) and the enclave's Rust ECIES
// read each other's ciphertexts, and that the browser computes the same set hash
// and commitment as the enclave.
//
// 1. cd aggregator && NEMA_WRITE_VECTORS=1 cargo test interop_write_rust_side
// 2. cd interop && node interop.mjs
// 3. cd aggregator && cargo test eciesjs_ciphertexts_tally

import { encrypt, decrypt } from "eciesjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const dir = new URL("../testdata/interop/", import.meta.url);
const rust = JSON.parse(readFileSync(new URL("rust.json", dir), "utf8"));

const sha256 = (...parts) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

// Same layout as the contract and the enclave.
export function setHash(subs) {
  const sorted = [...subs].sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
  const parts = sorted.flatMap((s) => [u32le(Buffer.byteLength(s.account)), Buffer.from(s.account), sha256(s.ciphertext_hex)]);
  return sha256(Buffer.concat(parts)).toString("hex");
}

export function commitment(contract, roundId, saltHex, count, mean, spread) {
  return sha256(
    "nema/commit/v1",
    u32le(Buffer.byteLength(contract)),
    contract,
    u64le(roundId),
    Buffer.from(saltHex, "hex"),
    `${count}|${mean}|${spread}`,
  ).toString("hex");
}

// Rust -> JS: open the sealed delivery and check it against the commitment.
const opened = JSON.parse(Buffer.from(decrypt(Buffer.from(rust.buyer_sk_hex, "hex"), Buffer.from(rust.sealed, "hex"))).toString());
const recomputed = commitment(rust.contract, rust.round_id, opened.salt, opened.count, opened.mean, opened.spread);
if (recomputed !== rust.commitment) throw new Error(`commitment mismatch: ${recomputed} vs ${rust.commitment}`);
console.log("opened the enclave's delivery:", { count: opened.count, mean: opened.mean, spread: opened.spread }, "commitment ok");

// JS -> Rust: encrypt five marks to the round key, as funds will in the browser.
const marks = [["a.testnet", 9175], ["b.testnet", 9500], ["c.testnet", 9300], ["d.testnet", 9650], ["e.testnet", 9425]];
const submissions = marks.map(([account, mark]) => ({
  account,
  ciphertext_hex: Buffer.from(encrypt(Buffer.from(rust.round_pubkey, "hex"), Buffer.from(JSON.stringify({ account, mark })))).toString("hex"),
}));
writeFileSync(new URL("js.json", dir), JSON.stringify({ submissions, set_hash: setHash(submissions) }, null, 2));
console.log(`wrote ${submissions.length} eciesjs ciphertexts, set hash ${setHash(submissions)}`);
