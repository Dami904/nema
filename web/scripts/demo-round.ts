// The other side of a recorded round, one step at a time, so a person can do
// their part in the app in between. Every transaction is real and signed with
// NEAR CLI from the OS keychain (a council seat, fund1-4 and the lender accounts).
//
//   pnpm live:demo-round approve --account someone.testnet   the council admits an applicant
//   pnpm live:demo-round open --minutes 20                   registers the loan if needed, opens a round
//   pnpm live:demo-round marks --round 7                     fund1-4 seal and submit marks
//   pnpm live:demo-round read --round 7                      the lender buys a read
//
// Costs: open 0.01 NEAR (the enclave fee), marks 0.03 NEAR per fund, a read the
// read price plus 0.03 NEAR. OutLayer returns most of each enclave fee.

import { PrivateKey } from "eciesjs";
import { ENCLAVE_FEE_YOCTO, READ_EXTRA_YOCTO, SUBMIT_DEPOSIT_YOCTO } from "../src/lib/config";
import { encodeLoan } from "../src/lib/loan";
import { sealMark } from "../src/lib/keys";
import type { Config, Purchase, Round } from "../src/lib/types";
import { allRounds, approveAndAdmit, arg, BASE, call, FUNDS, LENDER, registerLoan, until, view } from "./cli";

/** Anyone on the panel or the council may open a round; this one signs as the first council seat. */
const opener = arg("opener", BASE);
const funds = FUNDS;
const lender = arg("lender", LENDER);
/** Marks in hundredths, the same ones the smoke test uses. */
const MARKS = [9410, 9525, 9180, 9655];
const step = process.argv[2];

async function openRound(id: string): Promise<Round> {
  const r = await view<Round | null>("get_round", { round_id: id });
  if (!r) throw new Error(`no round ${id}`);
  return r;
}

if (step === "approve") {
  const account = arg("account", "");
  if (!account) throw new Error("--account is required");
  await approveAndAdmit(account);
  console.log(`${account} is on the panel`);
} else if (step === "open") {
  const minutes = Number(arg("minutes", "20"));
  const before = new Set((await allRounds()).map((r) => r.id));
  const closesAt = BigInt(Date.now() + minutes * 60_000) * 1_000_000n;
  const loan = encodeLoan({
    borrower: arg("borrower", "Harbor Freight Logistics"),
    facility: arg("facility", "Senior term loan B"),
    maturity: arg("maturity", "2030-06-30"),
  });
  const loanId = await registerLoan(loan);
  call(opener, "open_round", { loan_id: loanId, closes_at: closesAt.toString() }, ENCLAVE_FEE_YOCTO, 300);
  const created = await until("the new round", async () => (await allRounds()).find((r) => !before.has(r.id) && r.loan === loan), (r) => !!r, 60_000);
  const open = await until("the round key", () => openRound(created!.id), (r) => r.status !== "AwaitingKey", 180_000);
  if (open.status !== "Open") throw new Error(`round ${open.id} ${open.status}: ${open.last_error ?? ""}`);
  console.log(`round ${open.id} is open and closes at ${new Date(Number(closesAt / 1_000_000n)).toLocaleTimeString()}`);
} else if (step === "marks") {
  const id = arg("round", "");
  const round = await openRound(id);
  if (round.status !== "Open" || !round.pubkey) throw new Error(`round ${id} is ${round.status}, not Open`);
  for (const [i, f] of funds.entries()) {
    call(f, "submit", { round_id: Number(id), ciphertext_hex: sealMark(round.pubkey, f, MARKS[i]) }, SUBMIT_DEPOSIT_YOCTO);
    console.log(`${f} sealed and submitted`);
  }
} else if (step === "read") {
  const id = arg("round", "");
  const config = await view<Config>("get_config");
  const pk = new PrivateKey().publicKey.toHex(true);
  call(lender, "buy_read", { round_id: Number(id), buyer_pubkey: pk }, BigInt(config.read_price) + READ_EXTRA_YOCTO, 300);
  const p = await until("the read", async () => (await view<Purchase[]>("get_purchases_of", { buyer: lender })).find((x) => x.buyer_pubkey === pk), (x) => !!x && x.status !== "Pending");
  console.log(`${lender}'s read: ${p!.status}${p!.error ? ` (${p!.error})` : ""}`);
} else {
  console.log("usage: pnpm live:demo-round approve|open|marks|read [--account a] [--minutes n] [--round id]");
  process.exit(1);
}
