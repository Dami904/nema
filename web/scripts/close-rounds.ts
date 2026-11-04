// Closes every round whose deadline has passed (and retries failed closes), so a
// round never waits on someone opening the page. Safe to run repeatedly.
//
//   pnpm live:close-rounds --signer fund1.nema-dev.testnet
//
// Each close attaches 0.01 NEAR for the enclave; a round with too few marks gets
// it back.

import { ENCLAVE_FEE_YOCTO } from "../src/lib/config";
import { allRounds, arg, call } from "./cli";

const signer = arg("signer", "");
if (!signer) {
  console.error("Pass --signer <account> (its key must be in the OS keychain for NEAR CLI).");
  process.exit(2);
}

const now = BigInt(Date.now()) * 1_000_000n;
const due = (await allRounds()).filter((r) => (r.status === "Open" && BigInt(r.closes_at) <= now) || r.status === "CloseFailed");
if (due.length === 0) console.log("No rounds to close.");
for (const r of due) {
  try {
    call(signer, "close_round", { round_id: Number(r.id) }, ENCLAVE_FEE_YOCTO, 300);
    console.log(`  closed round ${r.id}${r.status === "CloseFailed" ? " (retry)" : ""}`);
  } catch (e) {
    console.error(`  round ${r.id}: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}
