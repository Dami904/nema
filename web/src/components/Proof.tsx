// The enclave's proof for each run behind a round, checked in the browser.

import { useEffect, useState } from "react";
import { useAccount } from "../lib/account";
import { NET, type Check } from "../lib/attest";
import { useChain, useLoad } from "../lib/chain";
import { date, handle } from "../lib/format";
import { KIND_LABEL, runsForRound, sampleRuns, type Run } from "../lib/proof";
import { useReads } from "../lib/reads";
import type { AuditCopy, Round } from "../lib/types";
import { Skeleton } from "./bits";
import "./Proof.css";

export function EnclaveProof({ round }: { round: Round }) {
  const { config, demoMode } = useChain();
  const { accountId } = useAccount();
  const { purchases } = useReads(accountId);
  const { data: audits } = useLoad((s) => (accountId ? s.auditsOf(accountId) : Promise.resolve([] as AuditCopy[])), [accountId]);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const ready = !!config && purchases !== undefined && audits !== undefined;
  // Only things that can add or change a run; the chain poll alone shouldn't re-check.
  const key = [round.id, round.status, round.closed_by, accountId, purchases?.length, audits?.length, attempt].join("|");

  useEffect(() => {
    if (demoMode) {
      setRuns(sampleRuns(round));
      return;
    }
    if (!ready) return;
    let alive = true;
    setRuns(null);
    setError(null);
    const accounts = [round.opened_by, round.closed_by, accountId].filter((a): a is string => !!a);
    runsForRound(round, accounts, { purchases: purchases ?? [], audits: audits ?? [] })
      .then((r) => alive && setRuns(r))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoMode, ready, key]);

  return (
    <div className="card proof fadein">
      <div className="proof-head">
        <div className="label">The enclave's proof</div>
        {demoMode && <span className="pill tone-quiet">Sample</span>}
      </div>
      <p className="muted" style={{ margin: "10px 0 6px", fontSize: 14 }}>
        Every enclave run comes with an Intel TDX quote. Your browser checks Intel's signatures, what the quote vouches for, the worker
        image, the code that ran and the request that started it, against the chain, not against anyone's word.
      </p>
      {error ? (
        <p className="note bad">
          Couldn't check the runs: {error}{" "}
          <button className="linkish" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
        </p>
      ) : runs === null ? (
        <Skeleton h={160} />
      ) : runs.length === 0 ? (
        <p className="hint" style={{ marginTop: 12 }}>
          {round.status === "AwaitingKey" ? "The round key's run will appear here once OutLayer finishes it." : "No enclave runs for this round were found yet."}
        </p>
      ) : (
        <ol className="runs">
          {runs.map((r) => (
            <RunCard key={r.jobId} run={r} demo={demoMode} />
          ))}
        </ol>
      )}
      <p className="hint proof-foot">
        Not checked here: Intel's TCB status and revocation lists for the machine. OutLayer's dashboard checks those from archived
        collateral; each run links to it.
      </p>
    </div>
  );
}

/** One run as a single line; its checks open on click, and a failed run opens by itself. */
function RunCard({ run, demo }: { run: Run; demo: boolean }) {
  const failed = run.checks.some((c) => c.ok === false);
  const passed = run.checks.filter((c) => c.ok).length;
  const title = run.kind === "deliver" ? `${KIND_LABEL.deliver} for ${handle(run.caller)}` : run.kind === "audit" ? `${KIND_LABEL.audit} by ${handle(run.caller)}` : KIND_LABEL[run.kind];
  return (
    <li>
      <details className={`run${failed ? " bad" : ""}`} open={failed}>
        <summary>
          <span>
            <strong>{title}</strong>
            <span className="hint"> · {date(String(BigInt(run.at) * 1_000_000_000n))}</span>
          </span>
          <span className={`pill ${failed ? "tone-bad" : "tone-open"}`}>
            {failed ? "✗" : "✓"} {passed} of {run.checks.length} checks
          </span>
        </summary>
        <div className="run-job">
          {demo ? (
            <span className="mono">job {run.jobId}</span>
          ) : (
            <a className="mono" href={`${NET.dashboard}${run.jobId}?network=${NET.network}`} target="_blank" rel="noreferrer">
              OutLayer job {run.jobId} ↗
            </a>
          )}
        </div>
        <ul className="checks">
          {run.checks.map((c) => (
            <CheckRow key={c.id} c={c} />
          ))}
        </ul>
      </details>
    </li>
  );
}

function CheckRow({ c }: { c: Check }) {
  return (
    <li className={c.ok === null ? "unknown" : c.ok ? "ok" : "no"}>
      <span className="mark" aria-hidden>{c.ok === null ? "–" : c.ok ? "✓" : "✗"}</span>
      <span>
        {c.label}
        <span className="sr-only">{c.ok === null ? ": not checked" : c.ok ? ": passed" : ": failed"}</span>
        <small>{c.detail}</small>
      </span>
    </li>
  );
}
