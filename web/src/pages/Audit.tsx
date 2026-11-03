import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Empty, Gauge, LoanTitle, Skeleton, StatusPill } from "../components/bits";
import { useToast } from "../components/Toaster";
import { TrackRecord } from "../components/TrackRecord";
import { useAccount } from "../lib/account";
import { useChain, useLoad } from "../lib/chain";
import { READ_EXTRA_YOCTO } from "../lib/config";
import { DEMO_AUDITED } from "../lib/demo";
import { date, handle, near } from "../lib/format";
import { ensureBuyerKey, getBuyerKey, openAudit } from "../lib/keys";
import { recordPoints } from "../lib/record";
import { useReads, type ReadState } from "../lib/reads";
import type { AuditCopy, AuditOpened, Round } from "../lib/types";
import { useWallet } from "../lib/wallet";
import "./Audit.css";

type Opened = { kind: "opened"; audit: AuditCopy; opened: AuditOpened } | { kind: "pending" | "locked" | "failed"; audit: AuditCopy };

export default function Audit() {
  const { rounds, demoMode } = useChain();
  const { accountId } = useAccount();
  const { signIn } = useWallet();
  const { data: clients } = useLoad((s) => (accountId ? s.clientsOf(accountId) : Promise.resolve([] as string[])), [accountId]);
  const { data: audits } = useLoad((s) => (accountId ? s.auditsOf(accountId) : Promise.resolve([] as AuditCopy[])), [accountId]);
  const { byRound } = useReads(accountId);

  // The newest audit of each (round, fund), opened with this device's key.
  const opened = useMemo(() => {
    const out: Record<string, Opened> = {};
    const key = accountId && !demoMode ? getBuyerKey(accountId) : null;
    for (const a of [...(audits ?? [])].sort((x, y) => Number(x.id) - Number(y.id))) {
      const k = `${a.round_id}/${a.fund}`;
      if (a.status === "Failed") out[k] = { kind: "failed", audit: a };
      else if (a.status === "Pending" || !a.sealed) out[k] = { kind: "pending", audit: a };
      else if (demoMode && DEMO_AUDITED[a.id]) out[k] = { kind: "opened", audit: a, opened: DEMO_AUDITED[a.id] };
      else if (!key || key.pk !== a.auditor_pubkey) out[k] = { kind: "locked", audit: a };
      else {
        try {
          out[k] = { kind: "opened", audit: a, opened: openAudit(key.sk, a.sealed) };
        } catch {
          out[k] = { kind: "locked", audit: a };
        }
      }
    }
    return out;
  }, [audits, accountId, demoMode]);

  return (
    <div className="wrap page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Audit</div>
          <h1>What your client sent, <em>and what came back</em></h1>
          <p className="muted" style={{ marginTop: 10, maxWidth: 620 }}>
            A fund can name one auditor. That auditor can have the enclave open the fund's own sealed marks, exactly as submitted, and reads
            the consensus for free to test them against. It sees no other fund's mark.
          </p>
        </div>
      </div>

      {!accountId ? (
        <Empty title="Sign in as an auditor" action={<button className="btn" onClick={signIn}>Connect wallet</button>}>
          Connect the wallet a fund named as its auditor.
        </Empty>
      ) : clients === undefined ? (
        <Skeleton h={200} />
      ) : clients.length === 0 ? (
        <Empty title="No fund has named you" action={<Link className="btn ghost" to="/docs#who-sees-what">Who sees what</Link>}>
          {handle(accountId)} isn't the auditor of any panel fund. A fund names its auditor when it applies, or later from its vault.
        </Empty>
      ) : (
        clients.map((fund) => (
          <section className="section audit-client" key={fund}>
            <div className="section-head">
              <div>
                <div className="eyebrow">Client</div>
                <h2>{handle(fund)}</h2>
                <p className="mono" style={{ marginTop: 6 }}>{fund}</p>
              </div>
            </div>
            {rounds.some((r) => r.submitted.includes(fund)) && (
              <div className="card audit-record">
                <TrackRecord
                  who={`${handle(fund)}'s marks`}
                  points={recordPoints(fund, rounds, (id) => {
                    const o = opened[`${id}/${fund}`];
                    return o?.kind === "opened" ? o.opened.mark / 100 : undefined;
                  }, byRound)}
                  empty={`Nothing to compare yet. Open what ${handle(fund)} sent in a published round and read its consensus, and the gap shows here.`}
                />
              </div>
            )}
            <ClientRounds fund={fund} rounds={rounds.filter((r) => r.submitted.includes(fund))} opened={opened} byRound={byRound} />
          </section>
        ))
      )}
    </div>
  );
}

function ClientRounds({ fund, rounds, opened, byRound }: { fund: string; rounds: Round[]; opened: Record<string, Opened>; byRound: Record<string, ReadState> }) {
  if (rounds.length === 0) return <Empty title="Nothing submitted yet">When {handle(fund)} marks a round, it shows up here to audit.</Empty>;
  return (
    <div className="audit-grid">
      {rounds.map((r) => (
        <AuditCard key={r.id} fund={fund} round={r} state={opened[`${r.id}/${fund}`]} read={byRound[r.id]} />
      ))}
    </div>
  );
}

function AuditCard({ fund, round, state, read }: { fund: string; round: Round; state?: Opened; read?: ReadState }) {
  const { demoMode } = useChain();
  const { accountId, act } = useAccount();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const counted = round.listing?.contributors.includes(fund);
  // Until the deadline the fund can still replace its mark, so the contract waits.
  const takingMarks = round.status === "AwaitingKey" || round.status === "Open";
  const dropped = round.listing?.rejected.find((x) => x.account === fund);
  const submitted = state?.kind === "opened" ? state.opened.mark / 100 : undefined;
  const mean = read?.kind === "opened" ? Number(read.opened.mean) : undefined;
  const spread = read?.kind === "opened" ? Number(read.opened.spread) : undefined;
  const z = submitted !== undefined && mean !== undefined && spread ? (submitted - mean) / spread : undefined;

  const request = async () => {
    if (!accountId) return;
    if (demoMode) return act({ method: "request_audit", args: {}, label: `Opening ${handle(fund)}'s mark` });
    let pk: string;
    try {
      pk = ensureBuyerKey(accountId).pk;
    } catch (e) {
      return toast("bad", "Can't keep a key in this browser", e instanceof Error ? e.message : String(e));
    }
    setBusy(true);
    await act({
      method: "request_audit",
      args: { round_id: Number(round.id), fund, auditor_pubkey: pk },
      deposit: READ_EXTRA_YOCTO,
      tgas: 300,
      label: `Opening ${handle(fund)}'s mark`,
    });
    setBusy(false);
  };

  return (
    <article className="card fadein">
      <div className="audit-head">
        <div>
          <Link to={`/rounds/${round.id}`} className="plain"><LoanTitle round={round} /></Link>
          <p className="hint">Round {round.id.padStart(2, "0")} · closes {date(round.closes_at)}</p>
        </div>
        <StatusPill status={round.status} />
      </div>
      <dl className="audit-figs">
        <div><dt>Submitted</dt><dd>{submitted !== undefined ? submitted.toFixed(2) : "sealed"}</dd></div>
        <div><dt>Consensus</dt><dd>{mean !== undefined ? mean.toFixed(2) : "—"}</dd></div>
        <div>
          <dt>Gap</dt>
          <dd className={z === undefined ? "" : Math.abs(z) <= 1 ? "in" : "out"}>{z !== undefined ? `${z >= 0 ? "+" : ""}${z.toFixed(2)}σ` : "—"}</dd>
        </div>
      </dl>
      {mean !== undefined && spread !== undefined && <Gauge mean={mean} spread={spread} own={submitted} />}
      {state?.kind === "opened" && (
        <p className="hint" style={{ marginTop: 12 }}>
          Opened by the enclave from the ciphertext on chain, sent {date(state.audit.submitted_at)}. {counted ? "It counted in the tally." : dropped ? `Dropped: ${dropped.reason}.` : ""}
        </p>
      )}
      {state?.kind === "pending" && <p className="note">The enclave is opening this mark for you…</p>}
      {state?.kind === "locked" && <p className="note">Sealed to a key this device doesn't hold. Restore your key backup from the Vault.</p>}
      {state?.kind === "failed" && <p className="note bad">The enclave couldn't open it: {state.audit.error ?? "unknown error"}.</p>}
      <div className="audit-actions">
        {takingMarks && !state && <p className="hint">Can be opened once the round stops taking marks.</p>}
        {!takingMarks && (!state || state.kind === "failed") && (
          <button className="btn small" onClick={request} disabled={busy} aria-disabled={busy}>
            {busy ? "Waiting for your wallet…" : `Open what ${handle(fund)} sent · ${near(READ_EXTRA_YOCTO)}`}
          </button>
        )}
        {round.status === "Published" && counted && !read && (
          <Link className="btn ghost small" to={`/rounds/${round.id}?view=lender`}>Read the consensus</Link>
        )}
      </div>
    </article>
  );
}
