// A lender's view of what it has read: each loan's latest consensus, how it moved,
// what it lets them lend, and files to keep. Everything is worked out and stored
// in this browser; nothing here is sent anywhere.

import { useEffect, useState } from "react";
import { BUILDS, CONFIG } from "./config";
import { parseLoan, type Loan } from "./loan";
import type { ReadState } from "./reads";
import type { Opened, Purchase, Round } from "./types";

/** One loan, whatever round it was priced in. */
export const loanKey = (raw: string) => {
  const l = parseLoan(raw);
  return `${l.borrower}\u0000${l.facility ?? ""}`;
};

export type Terms = { face: string; own: string; rate: string };

export type Base = { price: number; usesConsensus: boolean; base: number; claimed: number };

/** Borrowing base: face × advance rate at the lower of the fund's own price and
 * the consensus less one spread. Prices are in points of par. */
export function borrowingBase(t: Terms, mean: number, spread: number): Base {
  const face = Number(t.face) || 0;
  const own = Number(t.own) || 0;
  const rate = Math.min(100, Math.max(0, Number(t.rate) || 0)) / 100;
  const floor = mean - spread;
  const usesConsensus = floor < own;
  const price = usesConsensus ? floor : own;
  return { price, usesConsensus, base: (face * price * rate) / 100, claimed: (face * own * rate) / 100 };
}

const termsKey = (account: string | null, loan: string) => `nema:terms:${account ?? "-"}:${loanKey(loan)}`;

function readTerms(account: string | null, loan: string): Terms | null {
  try {
    const raw = localStorage.getItem(termsKey(account, loan));
    return raw ? (JSON.parse(raw) as Terms) : null;
  } catch {
    return null;
  }
}

/** What a lender entered for a loan, or a starting point: $20m face, the fund
 * marking a point above the consensus, a 65% advance rate. */
export const termsFor = (account: string | null, loan: string, mean: number): Terms =>
  readTerms(account, loan) ?? { face: "20000000", own: (mean + 1).toFixed(2), rate: "65" };

/** The face, price and advance rate a lender entered for a loan, kept on this
 * device so the round page and the portfolio agree. */
export function useTerms(account: string | null, loan: string, mean: number): [Terms, (t: Terms) => void] {
  const fallback = () => termsFor(account, loan, mean);
  const [terms, setTerms] = useState<Terms>(fallback);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setTerms(fallback()), [account, loan]);
  const save = (t: Terms) => {
    setTerms(t);
    try {
      localStorage.setItem(termsKey(account, loan), JSON.stringify(t));
    } catch {
      /* private window: keep it in memory only */
    }
  };
  return [terms, save];
}

export type Holding = {
  key: string;
  loan: Loan;
  latest: { round: Round; opened: Opened; purchase: Purchase };
  previous: { round: Round; opened: Opened } | null;
  /** Latest mean less the previous one, in points; null with only one round. */
  change: number | null;
  rounds: number;
};

/** The loans this account has opened a result for, latest round first per loan. */
export function holdings(rounds: Round[], byRound: Record<string, ReadState>): Holding[] {
  const groups = new Map<string, { round: Round; opened: Opened; purchase: Purchase }[]>();
  for (const r of rounds) {
    const st = byRound[r.id];
    if (st?.kind !== "opened") continue;
    const k = loanKey(r.loan);
    groups.set(k, [...(groups.get(k) ?? []), { round: r, opened: st.opened, purchase: st.purchase }]);
  }
  return [...groups.entries()]
    .map(([key, list]) => {
      list.sort((a, b) => Number(b.round.id) - Number(a.round.id));
      const [latest, previous] = list;
      return {
        key,
        loan: parseLoan(latest.round.loan),
        latest,
        previous: previous ?? null,
        change: previous ? Number(latest.opened.mean) - Number(previous.opened.mean) : null,
        rounds: list.length,
      };
    })
    .sort((a, b) => a.loan.borrower.localeCompare(b.loan.borrower));
}

// ---- files ----

const cell = (v: string | number | null | undefined) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const toCsv = (rows: (string | number | null | undefined)[][]) => rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";

export function download(name: string, text: string, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const roundLink = (id: string) => `${location.origin}/rounds/${id}`;
const fixed = (n: number, d = 2) => n.toFixed(d);

/** One opened round, with everything needed to check it later without this app. */
export function roundCsv(round: Round, opened: Opened, purchase: Purchase, terms: Terms): string {
  const loan = parseLoan(round.loan);
  const b = borrowingBase(terms, Number(opened.mean), Number(opened.spread));
  return toCsv([
    ["field", "value"],
    ["borrower", loan.borrower],
    ["facility", loan.facility],
    ["maturity", loan.maturity],
    ["round", round.id],
    ["consensus_mean", opened.mean],
    ["spread", opened.spread],
    ["funds_counted", opened.count],
    ["network", CONFIG.network],
    ["contract", CONFIG.contract],
    ["set_hash", round.listing?.set_hash],
    ["commitment", round.listing?.commitment],
    ["salt", opened.salt],
    ["commitment_formula", 'sha256("nema/commit/v1" || u32le(len(contract)) || contract || u64le(round_id) || salt || "count|mean|spread")'],
    ["read_id", purchase.id],
    ["read_basis", purchase.basis],
    ["reader", purchase.buyer],
    ["enclave_project", BUILDS.enclaveProject],
    ["enclave_wasm_sha256", BUILDS.enclaveWasmSha256],
    ["contract_wasm_sha256", BUILDS.contractWasmSha256],
    ["enclave_proofs", `${roundLink(round.id)}?view=verify`],
    ["face_held_usd", terms.face],
    ["fund_price", terms.own],
    ["advance_rate_pct", terms.rate],
    ["price_used", fixed(b.price)],
    ["price_basis", b.usesConsensus ? "consensus less one spread" : "fund's own price"],
    ["borrowing_base_usd", fixed(b.base)],
    ["exported_at", new Date().toISOString()],
  ]);
}

/** Every loan in the portfolio, one row each. */
export function portfolioCsv(list: Holding[], termsOf: (h: Holding) => Terms): string {
  return toCsv([
    [
      "borrower", "facility", "maturity", "round", "consensus_mean", "spread", "funds_counted", "change_since_previous",
      "face_held_usd", "fund_price", "advance_rate_pct", "price_used", "borrowing_base_usd", "commitment", "round_link",
    ],
    ...list.map((h) => {
      const t = termsOf(h);
      const b = borrowingBase(t, Number(h.latest.opened.mean), Number(h.latest.opened.spread));
      return [
        h.loan.borrower, h.loan.facility, h.loan.maturity, h.latest.round.id, h.latest.opened.mean, h.latest.opened.spread,
        h.latest.opened.count, h.change === null ? "" : fixed(h.change), t.face, t.own, t.rate, fixed(b.price), fixed(b.base),
        h.latest.round.listing?.commitment, roundLink(h.latest.round.id),
      ];
    }),
  ]);
}

export const fileSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
