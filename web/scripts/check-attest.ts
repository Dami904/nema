// Runs the browser's attestation checks against one real OutLayer run, then
// against tampered copies of it, which must fail. Network: OutLayer's public API
// and NEAR RPC (read only).
//
//   npm run check-attest -- --job 1256360 --network mainnet
//   npm run check-attest -- --job 16947 --network testnet --contract nema-dev.testnet

import { attestationOf, netFor, verifyRun, type Attestation } from "../src/lib/attest";
import { arg } from "./cli";

const net = netFor(arg("network", "mainnet"));
const job = Number(arg("job", "1256360"));

let failed = 0;
function check(claim: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${claim}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
}

const att = await attestationOf(job, net);
console.log(`OutLayer job ${job} on ${net.network}: ${att.project_id} called by ${att.caller_account_id}\n`);

// For any run, expect whatever it claims for project and code; the point is that
// the quote, chain, binding and worker checks pass on real data. Pass --contract
// for a Nema run so the requesting contract is checked too.
const expect = { contract: arg("contract", ""), project: att.project_id ?? "", wasmSha256: att.wasm_hash ?? "" };
const real = await verifyRun(att, expect, net);
for (const c of real.checks) console.log(`       ${c.ok === null ? "?" : c.ok ? "✓" : "✗"} ${c.label}: ${c.detail}`);
console.log(`       output ${real.output === null ? "not among the transaction's return values" : `found: ${JSON.stringify(real.output).slice(0, 120)}`}`);
const ok = (v: { checks: { id: string; ok: boolean | null }[] }, id: string) => v.checks.find((c) => c.id === id)?.ok;
check("Intel's chain verifies on a real quote", ok(real, "quote") === true);
check("the quote vouches for the published fields", ok(real, "binding") === true);
check("the worker image is approved on chain", ok(real, "worker") === true);
check("the input in the transaction hashes to the attested input", !!real.request && real.checks.find((c) => c.id === "input")!.detail.includes(att.input_hash!.slice(0, 12)));

const tampered: Attestation = { ...att, output_hash: "00".repeat(32) };
check("a changed output no longer matches the quote", ok(await verifyRun(tampered, expect, net), "binding") === false);

const bytes = Uint8Array.from(atob(att.tdx_quote), (c) => c.charCodeAt(0));
bytes[600] ^= 1; // inside the signed TD report
const forged: Attestation = { ...att, tdx_quote: btoa(String.fromCharCode(...bytes)) };
check("a changed quote no longer carries Intel's signature", ok(await verifyRun(forged, expect, net), "quote") === false);

check("a different build is caught", ok(await verifyRun(att, { ...expect, wasmSha256: "ab".repeat(32) }, net), "code") === false);

console.log(`\n${failed === 0 ? "All checks passed" : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
