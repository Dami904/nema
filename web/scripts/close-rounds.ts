// A keeper: closes every round whose deadline has passed (and retries failed
// closes), and settles any round, read or audit the enclave has left unanswered
// for 30 minutes, so nothing waits on someone opening the page. Safe to run
// repeatedly, by hand or on a schedule.
//
//   pnpm live:close-rounds --signer fund1.nema-dev.testnet
//   pnpm live:close-rounds --dry-run     # lists what it would do, signs nothing
//
// Each close attaches 0.01 NEAR for the enclave; a round with too few marks gets
// it back. Settling costs only gas, and a settled read refunds its buyer.

import { ENCLAVE_FEE_YOCTO, STALE_AFTER_MS } from "../src/lib/config";
import type { AuditCopy, Purchase } from "../src/lib/types";
import { allRounds, arg, call, view } from "./cli";

const dryRun = process.argv.includes("--dry-run");
const signer = arg("signer", "");
if (!signer && !dryRun) {
  console.error("Pass --signer <account> (its key must be in the OS keychain for NEAR CLI).");
  process.exit(2);
}

const now = BigInt(Date.now()) * 1_000_000n;
const staleNs = BigInt(STALE_AFTER_MS) * 1_000_000n;
let acted = 0;

function attempt(what: string, run: () => void) {
  if (dryRun) {
    console.log(`  would have ${what}`);
    acted++;
    return;
  }
  try {
    run();
    console.log(`  ${what}`);
    acted++;
  } catch (e) {
    console.error(`  ${what} failed: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}

/** Waiting on the enclave for over 30 minutes, so `reconcile_*` will accept it. */
async function stale(kind: "round" | "read" | "audit", id: string): Promise<boolean> {
  const since = await view<string | null>("get_pending_since", { kind, id });
  // A call from before the contract recorded this has no time and counts as old.
  return since === null || BigInt(since) + staleNs <= now;
}

/** Walks ids 1, 2, … until the view returns nothing. */
async function each<T>(method: string, arg: string, check: (item: T) => Promise<void>) {
  for (let id = 1; ; id++) {
    const item = await view<T | null>(method, { [arg]: String(id) });
    if (!item) return;
    await check(item);
  }
}

for (const r of await allRounds()) {
  const pastDeadline = BigInt(r.closes_at) <= now;
  if ((pastDeadline && (r.status === "Open" || r.status === "AwaitingKey")) || r.status === "CloseFailed")
    attempt(`closed round ${r.id}${r.status === "CloseFailed" ? " (retry)" : ""}`, () =>
      call(signer, "close_round", { round_id: Number(r.id) }, ENCLAVE_FEE_YOCTO, 300),
    );
  else if (r.status === "Closing" && (await stale("round", r.id)))
    attempt(`settled round ${r.id}'s unanswered tally`, () => call(signer, "reconcile_round", { round_id: Number(r.id) }));
}

await each<Purchase>("get_purchase", "purchase_id", async (p) => {
  if (p.status === "Pending" && (await stale("read", p.id)))
    attempt(`settled read ${p.id} (refunds ${p.buyer})`, () => call(signer, "reconcile_read", { purchase_id: Number(p.id) }, 0n, 60));
});

await each<AuditCopy>("get_audit", "audit_id", async (a) => {
  if (a.status === "Pending" && (await stale("audit", a.id)))
    attempt(`settled audit ${a.id}`, () => call(signer, "reconcile_audit", { audit_id: Number(a.id) }));
});

if (acted === 0) console.log("Nothing to close or settle.");
