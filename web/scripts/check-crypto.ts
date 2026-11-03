// Checks the browser's hashes against the vectors the contract and enclave tests use.
// Run with: npm test
import { readFileSync } from "node:fs";
import { PrivateKey, decrypt } from "eciesjs";
import { base58ToHex, commitment, fromHex, setHash } from "../src/lib/hashes.ts";
import { openSealed, sealMark } from "../src/lib/keys.ts";

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
