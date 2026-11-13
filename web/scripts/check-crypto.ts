// Checks the browser's hashes against the vectors the contract and enclave tests use.
// Run with: pnpm test
import { readFileSync } from "node:fs";
import { PrivateKey, decrypt } from "eciesjs";
import { base58ToHex, commitment, fromHex, setHash } from "../src/lib/hashes.ts";
import { openSealed, sealMark } from "../src/lib/keys.ts";
import { roundedConsensus } from "../src/lib/consensus.ts";
import { splitRead } from "../src/lib/split.ts";

const expected = readFileSync(new URL("../../testdata/set_hash_vector.txt", import.meta.url), "utf8").trim();
const got = await setHash([
  { account: "bob.testnet", ciphertext_hex: "cd".repeat(40) },
  { account: "alice.testnet", ciphertext_hex: "ab".repeat(40) },
]);
if (got !== expected) throw new Error(`set hash mismatch: ${got} vs ${expected}`);
console.log("set hash matches the shared vector");

const interop = JSON.parse(readFileSync(new URL("../../testdata/interop/js.json", import.meta.url), "utf8"));
const again = await setHash(interop.submissions);
if (again !== interop.set_hash) throw new Error(`interop set hash mismatch: ${again} vs ${interop.set_hash}`);
console.log(`set hash matches the interop file (${interop.submissions.length} eciesjs ciphertexts)`);

// "11111111111111111111111111111111" is 32 zero bytes in base58.
if (base58ToHex("11111111111111111111111111111111") !== "0".repeat(64)) throw new Error("base58 zero");
if (base58ToHex("2") !== "0".repeat(63) + "1") throw new Error("base58 one");
console.log("base58 decoding ok");

// A delivery sealed by the enclave's Rust code opens with the browser code and matches its commitment.
const rust = JSON.parse(readFileSync(new URL("../../testdata/interop/rust.json", import.meta.url), "utf8"));
const opened = openSealed(rust.buyer_sk_hex, rust.sealed);
const c = await commitment(rust.contract, BigInt(rust.round_id), opened.salt, opened.count, opened.mean, opened.spread);
if (c !== rust.commitment) throw new Error(`commitment mismatch: ${c} vs ${rust.commitment}`);
console.log(`opened the Rust-sealed delivery (mean ${opened.mean}, spread ${opened.spread}) and it matches its commitment`);

// A sealed mark carries the submitter's account and the mark in hundredths.
const roundKey = new PrivateKey();
const sealed = sealMark(roundKey.publicKey.toHex(true), "fund1.testnet", 9425);
const inner = JSON.parse(new TextDecoder().decode(decrypt(roundKey.secret, fromHex(sealed))));
if (inner.account !== "fund1.testnet" || inner.mark !== 9425) throw new Error(`sealed mark shape: ${JSON.stringify(inner)}`);
if (sealed.length < 64 || sealed.length > 2048) throw new Error(`sealed mark length ${sealed.length} outside the contract's 64..2048`);
console.log(`sealed mark opens to ${JSON.stringify(inner)} (${sealed.length} hex chars, within the contract's limit)`);

// A read fee splits the way the contract pays it. The same vector is in the contract
// test `a_read_split_matches_the_sites_vector`.
const split = splitRead(10n ** 23n + 7n, 4, 3, 500);
const want = { perSeat: 1666666666666666666666n, perFund: 23750000000000000000002n, remainder: 1n };
if (split.perSeat !== want.perSeat || split.perFund !== want.perFund || split.remainder !== want.remainder)
  throw new Error(`read split: ${split.perSeat} ${split.perFund} ${split.remainder}`);
if (split.perSeat * 3n + split.perFund * 4n + split.remainder !== 10n ** 23n + 7n) throw new Error("read split loses or makes yocto");
console.log("a read fee splits as the contract pays it (council share, funds, remainder)");

// The rounded consensus matches the enclave's own test vectors (aggregator/src/stats.rs).
const vectors: [number[], string, string][] = [
  [[9175, 9500, 9300, 9650, 9425], "94.125", "1.75"],
  [[9000, 9100, 9200, 9500], "92.000", "1.75"],
  [[9400, 9400, 9400, 9425], "94.125", "0.00"],
  [[9000, 9000, 9025, 9025], "90.125", "0.25"],
];
for (const [marks, mean, spread] of vectors) {
  const c = roundedConsensus(marks);
  if (c.mean !== mean || c.spread !== spread) throw new Error(`rounded consensus of ${marks}: ${c.mean} ± ${c.spread}, want ${mean} ± ${spread}`);
}
console.log("the rounded, trimmed consensus matches the enclave's vectors");
