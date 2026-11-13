// Sample data for demo mode, so every state can be seen while no live round exists.
// Hashes are computed with the real functions, so the Verify view checks out.

import { CONFIG } from "./config";
import { commitment, setHash, toHex } from "./hashes";
import { encodeLoan } from "./loan";
import { splitRead } from "./split";
import type { Application, AuditCopy, AuditOpened, Config, Opened, Purchase, Rejected, Round, Submission, RegisteredLoan, Proposal, Takeover } from "./types";

const MIN = 60_000;
const ns = (ms: number) => (BigInt(Math.round(ms)) * 1_000_000n).toString();
const suffix = `.${CONFIG.accountsBase}`;
const fund = (n: number) => `fund${n}${suffix}`;
// The same four funds as the live panel.
const FUNDS = [1, 2, 3, 4].map(fund);
export const DEMO_LENDER = `lender${suffix}`;
export const DEMO_COUNCIL = [1, 2, 3].map((n) => `council${n}${suffix}`);
/** Audits fund1, which named it. */
export const DEMO_AUDITOR = `auditor${suffix}`;

function fakeCipher(seed: string): string {
  let h = 2166136261;
  let out = "04";
  for (let i = 0; i < 180; i++) {
    h = Math.imul(h ^ (seed.charCodeAt(i % seed.length) + i), 16777619) >>> 0;
    out += (h & 0xff).toString(16).padStart(2, "0");
  }
  return out;
}

export const DEMO_SALT = toHex(new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff));
export const DEMO_OPENED: Record<string, Opened> = {
  "2": { count: 4, mean: "94.125", spread: "1.75", salt: DEMO_SALT, method: "rounded" },
  "1": { count: 4, mean: "93.500", spread: "2.00", salt: DEMO_SALT, method: "rounded" },
  "7": { count: 4, mean: "97.750", spread: "1.00", salt: DEMO_SALT, method: "rounded" },
  "8": { count: 4, mean: "96.125", spread: "1.50", salt: DEMO_SALT, method: "rounded" },
};
/** Marks the demo fund kept on its device, in hundredths. */
export const DEMO_OWN_MARKS: Record<string, number> = { "2": 9525, "1": 9300, "7": 9750, "8": 9450 };
/** What the enclave opened for the demo auditor, by audit id. */
export const DEMO_AUDITED: Record<string, AuditOpened> = {
  "1": { kind: "audit", account: fund(1), round_id: 1, mark: 9300 },
  "2": { kind: "audit", account: fund(1), round_id: 2, mark: 9525 },
  "3": { kind: "audit", account: fund(1), round_id: 7, mark: 9750 },
  "4": { kind: "audit", account: fund(1), round_id: 8, mark: 9450 },
};

type Store = {
  loans: RegisteredLoan[];
  proposals: Proposal[];
  takeover: Takeover | null;
  config: Config;
  members: string[];
  rounds: Round[];
  submissions: Record<string, Submission[]>;
  purchases: Purchase[];
  earnings: Record<string, string>;
  applications: Application[];
  auditors: Record<string, string>;
  audits: AuditCopy[];
};

let store: Promise<Store> | null = null;

export function demoStore(): Promise<Store> {
  store ??= build();
  return store;
}

/** How long the sample enclave takes to seal a copy, so the wait is visible. */
const SAMPLE_SEAL_MS = 2500;

/**
 * Plays a call against the sample data in this tab, so the flow can be seen
 * without a wallet. Nothing is sent anywhere, and a reload starts over.
 * Resolves true when the call was simulated, false when the sample contract
 * would refuse it, and null for calls sample mode doesn't play.
 */
export async function simulate(method: string, args: Record<string, unknown>, account: string, changed: () => void): Promise<boolean | null> {
  const s = await demoStore();
  const round = s.rounds.find((r) => r.id === String(args.round_id));
  if (!round) return null;

  if (method === "buy_read" || method === "claim_read") {
    if (round.status !== "Published" || !round.listing) return false;
    const held = s.purchases.some((p) => p.round_id === round.id && p.buyer === account && p.status !== "Refunded");
    if (held) return true;
    const contributors = round.listing.contributors;
    const free = contributors.includes(account) ? "Contributed" : contributors.some((c) => s.auditors[c] === account) ? "Audit" : null;
    if (method === "claim_read" && !free) return false;
    const price = method === "buy_read" ? BigInt(s.config.read_price) : 0n;
    const purchase: Purchase = {
      id: String(Math.max(0, ...s.purchases.map((p) => Number(p.id))) + 1),
      round_id: round.id,
      buyer: account,
      buyer_pubkey: "03" + "55".repeat(32),
      price: price.toString(),
      basis: method === "buy_read" ? "Purchased" : free!,
      status: "Pending",
      sealed: null,
      error: null,
    };
    s.purchases.push(purchase);
    changed();
    setTimeout(() => {
      purchase.status = "Delivered";
      purchase.sealed = "04" + "7c".repeat(150);
      // Paid out as the contract does: the council's share, then the funds whose marks counted.
      if (price > 0n) {
        const { perSeat, perFund, remainder } = splitRead(price, contributors.length, s.config.council.length, s.config.council_share_bps);
        const credit = (a: string, v: bigint) => (s.earnings[a] = (BigInt(s.earnings[a] ?? "0") + v).toString());
        if (perSeat > 0n) for (const seat of s.config.council) credit(seat, perSeat);
        for (const c of contributors) credit(c, perFund);
        if (remainder > 0n) credit(s.config.council[0], remainder);
      }
      changed();
    }, SAMPLE_SEAL_MS);
    return true;
  }

  if (method === "submit") {
    if (round.status !== "Open" || !s.members.includes(account)) return false;
    const list = (s.submissions[round.id] ??= []).filter((x) => x.account !== account);
    list.push({ account, ciphertext_hex: fakeCipher(round.id + account + Date.now()), submitted_at: ns(Date.now()) });
    s.submissions[round.id] = list;
    round.submitted = list.map((x) => x.account);
    round.set_hash = await setHash(list);
    if (typeof args.mark === "number") DEMO_OWN_MARKS[round.id] = args.mark;
    changed();
    return true;
  }

  return null;
}

async function build(): Promise<Store> {
  const now = Date.now();
  const subs = (id: string, accounts: string[], at: number): Submission[] =>
    accounts.map((a, i) => ({ account: a, ciphertext_hex: fakeCipher(id + a), submitted_at: ns(at + i * 7 * MIN) }));

  const submissions: Record<string, Submission[]> = {
    "1": subs("1", FUNDS.slice(0, 4), now - 9 * 24 * 60 * MIN),
    "2": subs("2", FUNDS.slice(0, 4), now - 3 * 24 * 60 * MIN),
    "3": subs("3", FUNDS.slice(0, 3), now - 5 * 60 * MIN),
    "4": subs("4", FUNDS, now - 30 * MIN),
    "5": subs("5", FUNDS.slice(0, 2), now - 6 * 24 * 60 * MIN),
    "6": [],
    "7": subs("7", FUNDS.slice(0, 4), now - 7 * 24 * 60 * MIN),
    "8": subs("8", FUNDS.slice(0, 4), now - 2 * 24 * 60 * MIN),
  };

  const published = async (id: string, loan: string, closedAgoMin: number, rejected: Rejected[] = []): Promise<Round> => {
    const s = submissions[id];
    const sh = await setHash(s);
    const o = DEMO_OPENED[id];
    return {
      id,
      loan_id: String(registry.indexOf(loan) + 1),
      loan,
      opened_by: fund(1),
      status: "Published",
      opened_at: ns(now - (closedAgoMin + 3 * 24 * 60) * MIN),
      closes_at: ns(now - closedAgoMin * MIN),
      pubkey: "02" + "ab".repeat(32),
      submitted: s.map((x) => x.account),
      set_hash: sh,
      listing: {
        count: o.count,
        rejected,
        set_hash: sh,
        commitment: await commitment(CONFIG.contract, BigInt(id), o.salt, o.count, o.mean, o.spread),
        contributors: s.map((x) => x.account),
      },
      last_error: null,
    };
  };

  const osprey = encodeLoan({ borrower: "Osprey Marine", facility: "Delayed draw term loan", maturity: "2030-03-31" });
  const harbor = encodeLoan({ borrower: "Harbor Retail", facility: "Term loan B", maturity: "2029-06-30" });
  const wren = encodeLoan({ borrower: "Wren Health", facility: "Revolver", maturity: "2028-12-15" });
  const fenwick = encodeLoan({ borrower: "Fenwick Foods", facility: "Second lien", maturity: "2031-01-31" });
  const kestrel = encodeLoan({ borrower: "Kestrel Software", facility: "First lien term loan", maturity: "2031-05-31" });
  const calder = (asOf: string) => encodeLoan({ borrower: "Calder Logistics", facility: "Unitranche", maturity: asOf });
  const registry = [osprey, harbor, wren, kestrel, calder("2030-09-30"), fenwick];
  const loans: RegisteredLoan[] = registry.map((label, i) => ({ id: String(i + 1), label }));
  const rounds: Round[] = [
    {
      id: "6",
      loan_id: String(registry.indexOf(osprey) + 1),
      loan: osprey,
      opened_by: fund(2),
      status: "AwaitingKey",
      opened_at: ns(now - 1 * MIN),
      closes_at: ns(now + 3 * 24 * 60 * MIN),
      pubkey: null,
      submitted: [],
      set_hash: null,
      listing: null,
      last_error: null,
    },
    {
      id: "3",
      loan_id: String(registry.indexOf(harbor) + 1),
      loan: harbor,
      opened_by: fund(2),
      status: "Open",
      opened_at: ns(now - 8 * 60 * MIN),
      closes_at: ns(now + (2 * 24 * 60 + 4 * 60) * MIN),
      pubkey: "02" + "cd".repeat(32),
      submitted: submissions["3"].map((x) => x.account),
      set_hash: null,
      listing: null,
      last_error: null,
    },
    {
      id: "4",
      loan_id: String(registry.indexOf(wren) + 1),
      loan: wren,
      opened_by: fund(2),
      status: "Closing",
      opened_at: ns(now - 2 * 24 * 60 * MIN),
      closes_at: ns(now - 2 * MIN),
      pubkey: "02" + "ef".repeat(32),
      submitted: submissions["4"].map((x) => x.account),
      set_hash: await setHash(submissions["4"]),
      listing: null,
      last_error: null,
    },
    await published("8", kestrel, 12 * 60),
    await published("2", calder("2030-09-30"), 2 * 24 * 60),
    {
      id: "5",
      loan_id: String(registry.indexOf(fenwick) + 1),
      loan: fenwick,
      opened_by: fund(2),
      status: "Failed",
      opened_at: ns(now - 9 * 24 * 60 * MIN),
      closes_at: ns(now - 6 * 24 * 60 * MIN),
      pubkey: "02" + "12".repeat(32),
      submitted: submissions["5"].map((x) => x.account),
      set_hash: await setHash(submissions["5"]),
      listing: null,
      last_error: "2 valid marks, below the floor of 4",
    },
    await published("7", kestrel, 6 * 24 * 60),
    await published("1", calder("2030-09-30"), 8 * 24 * 60),
  ];

  const price = (10n ** 23n).toString();
  const lenderKey = "03" + "77".repeat(32);
  const purchases: Purchase[] = [
    { id: "1", round_id: "1", buyer: DEMO_LENDER, buyer_pubkey: lenderKey, price, basis: "Purchased", status: "Delivered", sealed: "04" + "9a".repeat(150), error: null },
    { id: "2", round_id: "2", buyer: DEMO_LENDER, buyer_pubkey: lenderKey, price, basis: "Purchased", status: "Delivered", sealed: "04" + "5c".repeat(150), error: null },
    { id: "3", round_id: "2", buyer: fund(1), buyer_pubkey: "03" + "88".repeat(32), price: "0", basis: "Contributed", status: "Delivered", sealed: "04" + "3e".repeat(150), error: null },
    { id: "4", round_id: "2", buyer: DEMO_LENDER, buyer_pubkey: lenderKey, price, basis: "Purchased", status: "Refunded", sealed: null, error: "the enclave timed out; your payment was returned" },
    { id: "5", round_id: "1", buyer: fund(1), buyer_pubkey: "03" + "88".repeat(32), price: "0", basis: "Contributed", status: "Delivered", sealed: "04" + "3f".repeat(150), error: null },
    { id: "6", round_id: "2", buyer: DEMO_AUDITOR, buyer_pubkey: "03" + "99".repeat(32), price: "0", basis: "Audit", status: "Delivered", sealed: "04" + "4e".repeat(150), error: null },
    { id: "8", round_id: "7", buyer: DEMO_LENDER, buyer_pubkey: lenderKey, price, basis: "Purchased", status: "Delivered", sealed: "04" + "6a".repeat(150), error: null },
    { id: "9", round_id: "8", buyer: DEMO_LENDER, buyer_pubkey: lenderKey, price, basis: "Purchased", status: "Delivered", sealed: "04" + "6b".repeat(150), error: null },
    { id: "10", round_id: "7", buyer: fund(1), buyer_pubkey: "03" + "88".repeat(32), price: "0", basis: "Contributed", status: "Delivered", sealed: "04" + "3a".repeat(150), error: null },
    { id: "11", round_id: "8", buyer: fund(1), buyer_pubkey: "03" + "88".repeat(32), price: "0", basis: "Contributed", status: "Delivered", sealed: "04" + "3b".repeat(150), error: null },
    { id: "12", round_id: "7", buyer: DEMO_AUDITOR, buyer_pubkey: "03" + "99".repeat(32), price: "0", basis: "Audit", status: "Delivered", sealed: "04" + "4a".repeat(150), error: null },
    { id: "13", round_id: "8", buyer: DEMO_AUDITOR, buyer_pubkey: "03" + "99".repeat(32), price: "0", basis: "Audit", status: "Delivered", sealed: "04" + "4b".repeat(150), error: null },
    { id: "7", round_id: "1", buyer: DEMO_AUDITOR, buyer_pubkey: "03" + "99".repeat(32), price: "0", basis: "Audit", status: "Delivered", sealed: "04" + "4f".repeat(150), error: null },
  ];
  const audit = (id: string, round_id: string, status: AuditCopy["status"]): AuditCopy => ({
    id,
    round_id,
    fund: fund(1),
    auditor: DEMO_AUDITOR,
    auditor_pubkey: "03" + "99".repeat(32),
    submitted_at: submissions[round_id][0].submitted_at,
    status,
    sealed: status === "Delivered" ? "04" + "6d".repeat(150) : null,
    error: null,
  });

  const share = (10n ** 23n / 4n).toString();
  return {
    loans,
    takeover: null,
    proposals: [
      { id: "1", kind: { SetReadPrice: (15n * 10n ** 22n).toString() }, proposer: DEMO_COUNCIL[1], votes: [DEMO_COUNCIL[1]], created_at: ns(now - 3 * 60 * MIN) },
    ],
    config: {
      council: DEMO_COUNCIL,
      threshold: 2,
      admit_delay_secs: 3600,
      council_share_bps: 500,
      council_dormant_after_secs: 90 * 24 * 3600,
      last_council_action: ns(now - 3 * 24 * 60 * MIN),
      outlayer: "outlayer.testnet",
      project_id: "nema-dev.testnet/nema-aggregator",
      min_contributors: 4,
      read_price: price,
      application_bond: (5n * 10n ** 22n).toString(),
      readers_only: false,
      readers: [],
    },
    members: FUNDS,
    rounds,
    submissions,
    purchases,
    earnings: Object.fromEntries(FUNDS.map((f) => [f, (BigInt(share) * 2n).toString()])),
    applications: [
      { account: `applicant${suffix}`, auditor: `ledgerline-audit${suffix}`, note: "Lower mid-market sponsor loans, 38 positions", applied_at: ns(now - 5 * 60 * MIN), bond: (5n * 10n ** 22n).toString(), approvals: [DEMO_COUNCIL[1]], ready_at: null },
    ],
    auditors: { [fund(1)]: DEMO_AUDITOR },
    audits: [audit("1", "1", "Delivered"), audit("2", "2", "Delivered"), audit("3", "7", "Delivered"), audit("4", "8", "Delivered")],
  };
}
