// One full round on the live network, checked end to end: the contract code,
// sealing, the tally, free and paid reads, fee shares, an audit, and what stays
// private on chain. Every transaction is real and signed with NEAR CLI from the
// OS keychain.
//
//   pnpm live:smoke --owner nema-dev.testnet --funds fund1.nema-dev.testnet,fund2...,fund3...,fund4... \
//                    --lender lender.nema-dev.testnet --minutes 4
//
// Add --round <id> to pick up a round this script already opened and published
// (its marks are the ones below) and run only the reads, fees and audit.
//
// Costs about 0.06 NEAR in enclave fees, 0.06 NEAR in storage deposits kept by
// the contract, and one read price paid by the lender.

import { PrivateKey } from "eciesjs";
import { BUILDS, CONFIG, ENCLAVE_FEE_YOCTO, READ_EXTRA_YOCTO } from "../src/lib/config";
import { base58ToHex, commitment, setHash } from "../src/lib/hashes";
import { encodeLoan } from "../src/lib/loan";
import { viewAccount } from "../src/lib/near";
import { openAudit, openSealed, sealMark } from "../src/lib/keys";
import type { AuditCopy, Basis, Config, Purchase, Round, Submission } from "../src/lib/types";
import { allRounds, arg, call, sleep, until, view } from "./cli";

const owner = arg("owner", CONFIG.contract);
const funds = arg("funds", [1, 2, 3, 4].map((n) => `fund${n}.${CONFIG.contract}`).join(",")).split(",");
const lender = arg("lender", `lender.${CONFIG.contract}`);
const minutes = Number(arg("minutes", "4"));
const resume = arg("round", "");
/** Marks in hundredths; the enclave's exact result is recomputed below. */
const MARKS = [9410, 9525, 9180, 9655, 9300, 9440].slice(0, funds.length);

let failed = 0;
function check(claim: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${claim}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
}

/** The enclave's integer arithmetic: mean to 0.01, population spread to 0.0001. */
function expected(marks: number[]) {
  const n = BigInt(marks.length);
  const sum = marks.reduce((a, m) => a + BigInt(m), 0n);
  const sq = marks.reduce((a, m) => a + BigInt(m) * BigInt(m), 0n);
  const mean = (2n * sum + n) / (2n * n);
  let lo = 0n;
  let hi = 1n << 64n;
  const target = (n * sq - sum * sum) * 10_000n;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (mid * mid <= target) lo = mid;
    else hi = mid - 1n;
  }
  const fixed = (v: bigint, d: number) => `${v / 10n ** BigInt(d)}.${(v % 10n ** BigInt(d)).toString().padStart(d, "0")}`;
  return { mean: fixed(mean, 2), spread: fixed(lo / n, 4) };
}

console.log(`Nema smoke test on ${CONFIG.contract} (${CONFIG.network})\n`);

// ---- what's running ----
const account = await viewAccount(CONFIG.contract);
check("the contract on chain is the published build", base58ToHex(account.code_hash) === BUILDS.contractWasmSha256, base58ToHex(account.code_hash).slice(0, 12));
const config = await view<Config>("get_config");
const members = await view<string[]>("get_members");
check(`all ${funds.length} funds are on the panel`, funds.every((f) => members.includes(f)));
if (funds.length < config.min_contributors) throw new Error(`need at least ${config.min_contributors} funds`);

let id: string;
let subs: Submission[];
if (resume) {
  id = resume;
  subs = await view<Submission[]>("get_submissions", { round_id: id });
} else {
// ---- open ----
const before = new Set((await allRounds()).map((r) => r.id));
const closesAt = BigInt(Date.now() + minutes * 60_000) * 1_000_000n;
// A label no other round has, so the new round is found by name rather than by
// guessing its id (someone else may open a round at the same time).
const loan = encodeLoan({ borrower: "Smoke Test Co", facility: `Term loan ${Date.now().toString(36)}`, maturity: "2030-12-31" });
call(owner, "open_round", { loan, closes_at: closesAt.toString() }, ENCLAVE_FEE_YOCTO, 300);
const created = await until("the new round", async () => (await allRounds()).find((r) => !before.has(r.id) && r.loan === loan), (r) => !!r, 60_000);
id = created!.id;
const open = await until("the round key", () => view<Round | null>("get_round", { round_id: id }), (r) => !!r && r.status !== "AwaitingKey", 180_000);
check("the enclave made the round key", open!.status === "Open" && !!open!.pubkey, open!.last_error ?? "");
if (open!.status !== "Open") process.exit(1);

// ---- submit ----
for (const [i, f] of funds.entries()) call(f, "submit", { round_id: Number(id), ciphertext_hex: sealMark(open!.pubkey!, f, MARKS[i]) });
subs = await view<Submission[]>("get_submissions", { round_id: id });
check("every fund's sealed mark is stored", subs.length === funds.length);
const onChain = JSON.stringify(subs);
check("no mark is stored in the clear", MARKS.every((m) => !onChain.includes(String(m))) && !onChain.includes('"mark"'));

// ---- close ----
const wait = Number(closesAt / 1_000_000n) - Date.now() + 5_000;
if (wait > 0) {
  console.log(`  …   waiting ${Math.ceil(wait / 1000)}s for the deadline`);
  await sleep(wait);
}
call(funds[0], "close_round", { round_id: Number(id) }, ENCLAVE_FEE_YOCTO, 300);
}
const done = await until("the tally", () => view<Round>("get_round", { round_id: id }), (r) => r.status !== "Closing");
check("the round published", done.status === "Published", done.last_error ?? "");
if (done.status !== "Published" || !done.listing) process.exit(1);
check(`all ${funds.length} marks counted`, done.listing.count === funds.length && done.listing.rejected.length === 0);
check("the set hash recomputes in the browser code", (await setHash(subs)) === done.listing.set_hash);
check("the round view carries no mean or spread", !/mean|spread/.test(JSON.stringify(done)));
const want = expected(MARKS);

// ---- a fund reads for free ----
async function read(who: string, method: "claim_read" | "buy_read", deposit: bigint) {
  const sk = new PrivateKey();
  const pk = sk.publicKey.toHex(true);
  call(who, method, { round_id: Number(id), buyer_pubkey: pk }, deposit, 300);
  const p = await until(`${who}'s copy`, async () => (await view<Purchase[]>("get_purchases_of", { buyer: who })).find((x) => x.buyer_pubkey === pk), (x) => !!x && x.status !== "Pending");
  return { p: p!, sk: sk.toHex() };
}
const free = await read(funds[0], "claim_read", READ_EXTRA_YOCTO);
check("a contributing fund opened its copy for free", free.p.status === "Delivered" && free.p.basis === "Contributed" && free.p.price === "0", free.p.error ?? "");
if (free.p.sealed) {
  const o = openSealed(free.sk, free.p.sealed);
  check("its copy is the exact consensus", o.mean === want.mean && o.spread === want.spread, `${o.mean} ± ${o.spread}`);
  check("its copy matches the on-chain commitment", (await commitment(CONFIG.contract, BigInt(id), o.salt, o.count, o.mean, o.spread)) === done.listing.commitment);
}

let twice = false;
try {
  call(funds[0], "claim_read", { round_id: Number(id), buyer_pubkey: new PrivateKey().publicKey.toHex(true) }, READ_EXTRA_YOCTO, 300);
} catch {
  twice = true;
}
check("a fund gets one free copy per round", twice);

// ---- a lender pays, and the funds are paid ----
const earned = await Promise.all(funds.map((f) => view<string>("get_earnings", { account: f })));
const paid = await read(lender, "buy_read", BigInt(config.read_price) + READ_EXTRA_YOCTO);
check("the lender's paid read was delivered", paid.p.status === "Delivered" && paid.p.basis === "Purchased", paid.p.error ?? "");
if (paid.p.sealed) check("the lender's copy opens to the same result", openSealed(paid.sk, paid.p.sealed).mean === want.mean);
const share = BigInt(config.read_price) / BigInt(funds.length);
const after = await Promise.all(funds.map((f) => view<string>("get_earnings", { account: f })));
check("each fund was credited an equal share", after.every((a, i) => BigInt(a) - BigInt(earned[i]) === share), `${share} yocto each`);

// ---- an auditor opens one fund's own mark ----
const audited = funds[funds.length - 1];
call(audited, "set_auditor", { auditor: lender });
const late = await view<Basis | null>("get_free_basis", { round_id: id, account: lender });
check("an auditor named after the deadline gets no free read", late === null, String(late));
const ask = new PrivateKey();
call(lender, "request_audit", { round_id: Number(id), fund: audited, auditor_pubkey: ask.publicKey.toHex(true) }, READ_EXTRA_YOCTO, 300);
const audit = await until("the audit", async () => (await view<AuditCopy[]>("get_audits_of", { auditor: lender })).find((a) => a.round_id === id && a.fund === audited), (a) => !!a && a.status !== "Pending");
check("the enclave opened the fund's mark for its auditor", audit!.status === "Delivered", audit!.error ?? "");
if (audit!.sealed) check("the auditor sees exactly what the fund sent", openAudit(ask.toHex(), audit!.sealed).mark === MARKS[funds.length - 1]);
let refused = false;
try {
  call(funds[0], "request_audit", { round_id: Number(id), fund: audited, auditor_pubkey: ask.publicKey.toHex(true) }, READ_EXTRA_YOCTO, 300);
} catch {
  refused = true;
}
check("another fund cannot audit it", refused);
call(audited, "set_auditor", { auditor: null });

console.log(`\n${failed === 0 ? "All checks passed" : `${failed} check(s) failed`} · round ${id} · ${CONFIG.explorerAccount}${CONFIG.contract}`);
process.exit(failed === 0 ? 0 : 1);
