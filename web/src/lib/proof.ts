// Finds the enclave runs behind one round and checks each one: the generic
// attestation checks from attest.ts, plus whether the run's result is what the
// contract stored.
//
// OutLayer files a run under the account that signed the transaction, not under
// the contract, so runs are looked up by the accounts that could have signed:
// whoever opened the round (round key), whoever closed the round (tally), and the viewer (their
// own copies and audits).

import { attestationOf, jobsOf, verifyRun, type Attestation, type Check, type Job } from "./attest";
import { BUILDS, CONFIG } from "./config";
import type { AuditCopy, Purchase, Round } from "./types";

export type RunKind = "derive_pubkey" | "tally" | "deliver" | "audit";

export type Run = {
  jobId: number;
  kind: RunKind;
  caller: string;
  /** Seconds since the epoch, from the attestation. */
  at: number;
  checks: Check[];
};

export const KIND_LABEL: Record<RunKind, string> = {
  derive_pubkey: "Round key",
  tally: "Tally",
  deliver: "Sealed copy",
  audit: "Audit",
};

type Mine = { purchases: Purchase[]; audits: AuditCopy[] };

const expect = { contract: CONFIG.contract, project: BUILDS.enclaveProject, wasmSha256: BUILDS.enclaveWasmSha256 };

/** What a run on this round must be: the current build, or an earlier one for rounds it ran. */
export const expectFor = (roundId: string) =>
  Number(roundId) <= BUILDS.earlierEnclaveLastRound ? { ...expect, earlierWasm: BUILDS.earlierEnclaveWasmSha256 } : expect;

export async function runsForRound(round: Round, accounts: string[], mine: Mine): Promise<Run[]> {
  const jobs = new Map<number, Job>();
  const lists = await Promise.all([...new Set(accounts)].map((a) => jobsOf(a).catch(() => [] as Job[])));
  for (const j of lists.flat()) {
    if (j.project_id === BUILDS.enclaveProject && j.job_type === "execute") jobs.set(j.job_id, j);
  }
  const runs = await Promise.all([...jobs.values()].map((j) => checkJob(j, round, mine).catch(() => null)));
  return runs.filter((r): r is Run => r !== null).sort((a, b) => a.at - b.at);
}

async function checkJob(job: Job, round: Round, mine: Mine): Promise<Run | null> {
  const att: Attestation = await attestationOf(job.job_id);
  const v = await verifyRun(att, expectFor(round.id));
  const input = v.input;
  if (!input || String(input.round_id) !== round.id) return null;
  const kind = input.action as RunKind;
  if (!(kind in KIND_LABEL)) return null;
  const out = (v.output ?? null) as Record<string, unknown> | null;
  v.checks.push(resultCheck(kind, out, input, round, mine, att.caller_account_id ?? ""));
  return { jobId: job.job_id, kind, caller: att.caller_account_id ?? "", at: att.timestamp, checks: v.checks };
}

function resultCheck(
  kind: RunKind,
  out: Record<string, unknown> | null,
  input: Record<string, unknown>,
  round: Round,
  mine: Mine,
  caller: string,
): Check {
  const label = "Its result is what the contract stored";
  if (!out) return { id: "result", label, ok: null, detail: "the output isn't among the transaction's return values" };
  if (out.ok === false) return { id: "result", label, ok: null, detail: `the enclave declined: ${String(out.error ?? "no reason")}` };
  switch (kind) {
    case "derive_pubkey":
      return { id: "result", label, ok: out.pubkey === round.pubkey, detail: "the round key on chain" };
    case "tally": {
      const l = round.listing;
      if (!l) return { id: "result", label, ok: null, detail: "the round has no published result to compare" };
      const ok = out.commitment === l.commitment && out.set_hash === l.set_hash && out.count === l.count;
      return { id: "result", label, ok, detail: "count, set hash and commitment on chain" };
    }
    case "deliver": {
      const p = mine.purchases.find((x) => x.round_id === round.id && x.buyer === caller && x.buyer_pubkey === input.buyer_pubkey);
      if (!p) return { id: "result", label, ok: null, detail: "not one of your copies" };
      return { id: "result", label, ok: out.sealed === p.sealed, detail: `read #${p.id}, sealed to your key` };
    }
    case "audit": {
      const a = mine.audits.find((x) => x.round_id === round.id && x.auditor === caller && x.fund === input.account && x.auditor_pubkey === input.auditor_pubkey);
      if (!a) return { id: "result", label, ok: null, detail: "not one of your audits" };
      return { id: "result", label, ok: out.sealed === a.sealed, detail: `audit #${a.id} of ${String(input.account)}` };
    }
  }
}

/** What the panel shows with sample data: the same checks, all passing, marked as sample. */
export function sampleRuns(round: Round): Run[] {
  const checks = (kind: RunKind): Check[] => [
    { id: "quote", label: "Signed by Intel", ok: true, detail: "Intel root → platform CA → PCK → quoting enclave → quote" },
    { id: "binding", label: "The quote vouches for exactly this run", ok: true, detail: "task hash 9f2c41d07ab3e815…" },
    { id: "worker", label: "An approved OutLayer worker image", ok: true, detail: "5 measurements, checked on worker.outlayer.testnet" },
    { id: "code", label: "Nema's published enclave build ran", ok: true, detail: `${BUILDS.enclaveProject} · wasm ${BUILDS.enclaveWasmSha256.slice(0, 12)}…` },
    { id: "input", label: "Asked for by the Nema contract", ok: true, detail: `called by ${CONFIG.contract}` },
    {
      id: "result",
      label: "Its result is what the contract stored",
      ok: true,
      detail: kind === "tally" ? "count, set hash and commitment on chain" : "the round key on chain",
    },
  ];
  const opened = Math.floor(Number(BigInt(round.opened_at) / 1_000_000_000n));
  const out: Run[] = [];
  if (round.pubkey) out.push({ jobId: 16_400 + Number(round.id) * 2, kind: "derive_pubkey", caller: "nema-dev.testnet", at: opened + 20, checks: checks("derive_pubkey") });
  if (round.listing) {
    const closed = Math.floor(Number(BigInt(round.closes_at) / 1_000_000_000n));
    out.push({ jobId: 16_401 + Number(round.id) * 2, kind: "tally", caller: round.closed_by ?? round.submitted[0] ?? "", at: closed + 40, checks: checks("tally") });
  }
  return out;
}
