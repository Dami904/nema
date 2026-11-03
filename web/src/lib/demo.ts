// Sample data for demo mode, so every state can be seen while no live round exists.
// Hashes are computed with the real functions, so the Verify view checks out.

import { CONFIG } from "./config";
import { commitment, setHash, toHex } from "./hashes";
import { encodeLoan } from "./loan";
import type { Application, AuditCopy, AuditOpened, Config, Opened, Purchase, Rejected, Round, Submission } from "./types";

const MIN = 60_000;
const ns = (ms: number) => (BigInt(Math.round(ms)) * 1_000_000n).toString();
const suffix = `.${CONFIG.contract}`;
const fund = (n: number) => `fund${n}${suffix}`;
// The same four funds as the live panel.
const FUNDS = [1, 2, 3, 4].map(fund);
export const DEMO_LENDER = `lender${suffix}`;
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
  "2": { count: 4, mean: "94.10", spread: "1.6324", salt: DEMO_SALT },
  "1": { count: 4, mean: "93.45", spread: "2.0410", salt: DEMO_SALT },
  "7": { count: 4, mean: "97.80", spread: "0.9120", salt: DEMO_SALT },
  "8": { count: 4, mean: "96.15", spread: "1.4875", salt: DEMO_SALT },
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
      loan,
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

  const kestrel = encodeLoan({ borrower: "Kestrel Software", facility: "First lien term loan", maturity: "2031-05-31" });
  const calder = (asOf: string) => encodeLoan({ borrower: "Calder Logistics", facility: "Unitranche", maturity: asOf });
  const rounds: Round[] = [
    {
      id: "6",
      loan: encodeLoan({ borrower: "Osprey Marine", facility: "Delayed draw term loan", maturity: "2030-03-31" }),
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
      loan: encodeLoan({ borrower: "Harbor Retail", facility: "Term loan B", maturity: "2029-06-30" }),
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
      loan: encodeLoan({ borrower: "Wren Health", facility: "Revolver", maturity: "2028-12-15" }),
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
      loan: encodeLoan({ borrower: "Fenwick Foods", facility: "Second lien", maturity: "2031-01-31" }),
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
    config: {
      owner: CONFIG.contract,
      outlayer: "outlayer.testnet",
      project_id: "nema-dev.testnet/nema-aggregator",
      min_contributors: 4,
      read_price: price,
      application_bond: (5n * 10n ** 22n).toString(),
    },
    members: FUNDS,
    rounds,
    submissions,
    purchases,
    earnings: Object.fromEntries(FUNDS.map((f) => [f, (BigInt(share) * 2n).toString()])),
    applications: [
      { account: `applicant${suffix}`, auditor: `ledgerline-audit${suffix}`, note: "Lower mid-market sponsor loans, 38 positions", applied_at: ns(now - 5 * 60 * MIN), bond: (5n * 10n ** 22n).toString() },
    ],
    auditors: { [fund(1)]: DEMO_AUDITOR },
    audits: [audit("1", "1", "Delivered"), audit("2", "2", "Delivered"), audit("3", "7", "Delivered"), audit("4", "8", "Delivered")],
  };
}
