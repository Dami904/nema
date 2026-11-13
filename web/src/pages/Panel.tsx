import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount } from "../lib/account";
import { useChain, useLoad } from "../lib/chain";
import { ENCLAVE_FEE_YOCTO } from "../lib/config";
import { date, handle, near, nsToMs } from "../lib/format";
import { parseLoan, encodeLoan } from "../lib/loan";
import type { Application, Config, Proposal, ProposalKind, RegisteredLoan, Takeover } from "../lib/types";
import "./Panel.css";

/** The contract refuses loan labels longer than this. */
const MAX_LOAN = 120;
const MAX_NOTE = 140;
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const validAccount = (a: string) => ACCOUNT_RE.test(a) && a.length >= 2 && a.length <= 64;
const YOCTO = 10n ** 24n;

const loanName = (label: string) => {
  const l = parseLoan(label);
  return l.facility ? `${l.borrower} · ${l.facility}` : l.borrower;
};

/** One line saying what a proposal would do. */
function describe(kind: ProposalKind): string {
  if (kind === "Heartbeat") return "Confirm the council is still active (changes nothing)";
  if ("SetReadPrice" in kind) return `Set the read price to ${near(kind.SetReadPrice)}`;
  if ("RemoveMember" in kind) return `Remove ${handle(kind.RemoveMember)} from the panel`;
  if ("AddCouncil" in kind) return `Seat ${handle(kind.AddCouncil)} on the council`;
  if ("RemoveCouncil" in kind) return `Remove ${handle(kind.RemoveCouncil)} from the council`;
  if ("SetThreshold" in kind) return `Require ${kind.SetThreshold} council votes for a decision`;
  if ("RemoveLoan" in kind) return `Take loan ${kind.RemoveLoan} off the registry`;
  if ("AddReader" in kind) return `Approve ${handle(kind.AddReader)} as a reader`;
  if ("RemoveReader" in kind) return `Remove ${handle(kind.RemoveReader)} from the readers`;
  if ("SetReadersOnly" in kind) return kind.SetReadersOnly ? "Sell reads only to approved readers" : "Open reads to anyone again";
  return `Register the loan ${loanName(kind.RegisterLoan)}`;
}

export default function Panel() {
  const { members, config, rounds } = useChain();
  // Loans with a round still running; the contract won't remove these.
  const busyLoans = new Set(rounds.filter((r) => ["AwaitingKey", "Open", "Closing", "CloseFailed"].includes(r.status)).map((r) => r.loan_id));
  const { accountId, act } = useAccount();
  const council = config?.council ?? [];
  // A contract from before the council (v1) has none of the council's fields.
  const governed = !!config?.council && !!config.last_council_action;
  const isCouncil = !!accountId && council.includes(accountId);
  const isMember = !!accountId && members.includes(accountId);
  const floor = config?.min_contributors ?? 4;
  const { data: applications } = useLoad((s) => s.applications(), []);
  const { data: proposals } = useLoad((s) => s.proposals(), []);
  const { data: loans } = useLoad((s) => s.loans(), []);
  const { data: takeover } = useLoad((s) => s.takeover(), []);

  const propose = async (kind: ProposalKind, label: string) => {
    await act({ method: "propose", args: { kind }, label });
  };

  const remove = async (account: string) => {
    if (!confirm(`Propose removing ${account} from the panel? It takes ${config?.threshold ?? 2} council votes.`)) return;
    await propose({ RemoveMember: account }, `Proposing to remove ${handle(account)}`);
  };

  const canApply = !isCouncil && !!accountId && !isMember;
  const canOpen = isCouncil || isMember;

  return (
    <div className="wrap page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Panel</div>
          <h1>The <em>panel</em></h1>
          <p className="muted" style={{ marginTop: 10 }}>
            Council: {council.length ? council.map((c, i) => (<span key={c}>{i > 0 && ", "}<span className="mono">{c}</span></span>)) : "…"}
            {governed && <> · {config!.threshold} of {council.length} must agree</>}
          </p>
          {governed && config!.council_share_bps > 0 && (
            <p className="hint" style={{ marginTop: 4 }}>
              The council earns {config.council_share_bps / 100}% of each paid read, split equally, for keeping the panel running. The share is fixed when the contract is created; a vote can't raise it.
            </p>
          )}
        </div>
      </div>

      {!isCouncil && (
        <p className="note" style={{ marginBottom: 24 }}>
          {canOpen
            ? "You're a panel fund: you can open a round on a registered loan. The council admits funds, sets the read price and registers loans, by vote."
            : "You're viewing the panel read-only. The council admits funds by vote; panel funds open rounds."}
        </p>
      )}

      <div className={isCouncil || canOpen || canApply ? "grid2" : ""}>
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="label">Funds on the panel</div>
            <span className={`pill ${members.length >= floor ? "tone-open" : "tone-bad"}`}>{members.length} funds · {floor} needed</span>
          </div>
          {members.length === 0 ? (
            <p className="hint" style={{ marginTop: 16 }}>No funds yet. A round needs at least {floor} to publish.</p>
          ) : (
            <ul className="members">
              {members.map((m, i) => (
                <li key={m}>
                  <span className="av">{i + 1}</span>
                  <span>
                    {handle(m)}
                    <span className="mono" style={{ display: "block" }}>{m}</span>
                  </span>
                  {isCouncil && (
                    <button className="btn ghost small" onClick={() => remove(m)}>
                      Propose removal
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <Applications applications={applications ?? []} config={config ?? undefined} isCouncil={isCouncil} account={accountId} />
        </div>

        <div>
          {canOpen && <OpenRound loans={loans ?? []} members={members.length} floor={floor} />}
          {isCouncil && config && (
            <>
              <Decisions proposals={proposals ?? []} config={config} account={accountId!} />
              <Seats config={config} onPropose={propose} />
              <ReadPrice current={config.read_price} onPropose={propose} />
              <RegisterLoan onPropose={propose} />
            </>
          )}
          {canApply && <Apply account={accountId!} pending={applications?.find((a) => a.account === accountId)} bond={config?.application_bond} threshold={config?.threshold ?? 2} />}
        </div>
      </div>

      {config && governed && <CouncilWatch config={config} members={members} takeover={takeover ?? null} account={accountId} isCouncil={isCouncil} onPropose={propose} />}

      <Registry loans={loans ?? []} busy={busyLoans} isCouncil={isCouncil} onPropose={propose} />

      {config?.readers_only !== undefined && <Readers config={config} isCouncil={isCouncil} onPropose={propose} />}
    </div>
  );
}

/** Who may buy a read. Open to anyone unless the council limits it to readers it approved. */
function Readers({ config, isCouncil, onPropose }: { config: Config; isCouncil: boolean; onPropose: Propose }) {
  const [reader, setReader] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const readers = config.readers ?? [];
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const a = reader.trim().toLowerCase();
    if (!validAccount(a)) return setErr("Enter a NEAR account.");
    if (readers.includes(a)) return setErr("Already a reader.");
    if (readers.length >= 128) return setErr("The list holds 128 readers, the most it can.");
    setErr(null);
    await onPropose({ AddReader: a }, `Proposing ${handle(a)} as a reader`);
    setReader("");
  };
  return (
    <div className="card" style={{ marginTop: 24 }}>
      <div className="label">Who can buy a read · {config.readers_only ? `${readers.length} approved readers` : "anyone"}</div>
      <p className="muted" style={{ marginTop: 8 }}>
        {config.readers_only
          ? "Paid reads are limited to the readers below, approved by the council."
          : "Anyone can pay to read a published round. The council can limit reads to readers it approves, such as vetted lenders."}{" "}
        Funds whose mark counted, and their auditors, always read their own rounds free.
      </p>
      {readers.length > 0 && (
        <ul className="members" style={{ marginTop: 12 }}>
          {readers.map((r, i) => (
            <li key={r}>
              <span className="av">{i + 1}</span>
              <span className="mono">{r}</span>
              {isCouncil && (
                <button className="btn ghost small" onClick={() => onPropose({ RemoveReader: r }, `Proposing to remove ${handle(r)} from the readers`)}>Propose removal</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {isCouncil && (
        <>
          <form onSubmit={add} className="field" style={{ marginTop: 12 }}>
            <label htmlFor="reader" className="sr-only">Account to approve as a reader</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input id="reader" style={{ flex: 1 }} placeholder="lender.testnet" value={reader} onChange={(e) => (setReader(e.target.value), setErr(null))} />
              <button className="btn ghost" type="submit">Propose reader</button>
            </div>
            {err && <span className="err">{err}</span>}
          </form>
          <button
            className="btn ghost small"
            style={{ marginTop: 12 }}
            onClick={() => onPropose({ SetReadersOnly: !config.readers_only }, config.readers_only ? "Proposing to open reads to anyone" : "Proposing to limit reads to readers")}
          >
            {config.readers_only ? "Propose opening reads to anyone" : "Propose limiting reads to approved readers"}
          </button>
        </>
      )}
    </div>
  );
}

function Applications({ applications, config, isCouncil, account }: { applications: Application[]; config?: Config; isCouncil: boolean; account: string | null }) {
  const { act } = useAccount();
  const [busy, setBusy] = useState<string | null>(null);
  const threshold = config?.threshold ?? 2;
  const run = async (method: string, accountId: string, label: string) => {
    setBusy(accountId);
    await act({ method, args: { account: accountId }, label, tgas: 60 });
    setBusy(null);
  };
  return (
    <div className="apps">
      <div className="label">Waiting to join · {applications.length}</div>
      {applications.length === 0 ? (
        <p className="hint" style={{ marginTop: 8 }}>No applications. Funds apply from this page with their own wallet.</p>
      ) : (
        applications.map((a) => {
          const readyMs = a.ready_at ? nsToMs(a.ready_at) : null;
          const windowOpen = readyMs !== null && readyMs > Date.now();
          const canFinalize = readyMs !== null && !windowOpen;
          const approved = !!account && a.approvals.includes(account);
          return (
            <div className="app" key={a.account}>
              <div>
                <strong>{handle(a.account)}</strong> <span className="hint">· applied {date(a.applied_at)}</span>
                <span className="mono" style={{ display: "block" }}>{a.account}</span>
                {a.note && <p className="muted" style={{ fontSize: 14, marginTop: 4 }}>{a.note}</p>}
                <p className="hint" style={{ fontSize: 13 }}>{a.auditor ? `Auditor: ${a.auditor}` : "No auditor named"} · bond {near(a.bond)}, returned either way</p>
                <p className="hint" style={{ fontSize: 13 }}>
                  {a.approvals.length} of {threshold} council approvals
                  {windowOpen && ` · veto window open until ${date(a.ready_at!)}`}
                  {canFinalize && " · ready to admit"}
                </p>
              </div>
              <div className="app-actions">
                {isCouncil && !approved && !a.ready_at && (
                  <button className="btn small" onClick={() => run("approve", a.account, `Approving ${handle(a.account)}`)} disabled={busy === a.account}>Approve</button>
                )}
                {canFinalize && (
                  <button className="btn small" onClick={() => run("finalize_admission", a.account, `Admitting ${handle(a.account)}`)} disabled={busy === a.account}>Admit</button>
                )}
                {isCouncil && (
                  <button className="btn ghost small" onClick={() => run("reject", a.account, `${a.ready_at ? "Vetoing" : "Turning away"} ${handle(a.account)}`)} disabled={busy === a.account}>
                    {a.ready_at ? "Veto" : "Turn away"}
                  </button>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

const DEFAULT_BOND = (5n * 10n ** 22n).toString();

function Apply({ account, pending, bond = DEFAULT_BOND, threshold }: { account: string; pending?: Application; bond?: string; threshold: number }) {
  const { act } = useAccount();
  const [auditor, setAuditor] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const withdraw = async () => {
    setBusy(true);
    await act({ method: "withdraw_application", args: {}, label: "Withdrawing your application" });
    setBusy(false);
  };

  if (pending)
    return (
      <div className="card">
        <div className="label">Your application</div>
        <h3 className="serif" style={{ fontSize: 30, margin: "10px 0 6px" }}>Waiting on the council</h3>
        <p className="muted">
          Applied {date(pending.applied_at)}{pending.auditor ? `, naming ${pending.auditor} as your auditor` : ""}. {pending.approvals.length} of {threshold} council
          members have approved. Your {near(pending.bond)} bond comes back whether you're admitted or not.
        </p>
        <button className="btn ghost wide" style={{ marginTop: 18 }} disabled={busy} onClick={withdraw}>
          {busy ? "Waiting for your wallet…" : "Withdraw application"}
        </button>
      </div>
    );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const a = auditor.trim().toLowerCase();
    if (a && !validAccount(a)) return setErr("Enter the auditor's NEAR account, or leave it empty.");
    if (a === account) return setErr("A fund can't audit itself.");
    if (new TextEncoder().encode(note).length > MAX_NOTE) return setErr("Keep the note to 140 characters.");
    setErr(null);
    setBusy(true);
    await act({ method: "apply", args: { auditor: a || null, note: note.trim() || null }, deposit: BigInt(bond), label: "Applying to the panel" });
    setBusy(false);
  };

  return (
    <form className="card" onSubmit={submit}>
      <div className="label">Join the panel</div>
      <p className="muted" style={{ margin: "10px 0 4px" }}>
        {handle(account)} isn't on the panel. Apply, and {threshold} council members must approve you; any of them can still veto during the
        waiting period. Panel funds mark rounds, read results for free and share the read fees.
      </p>
      <div className="field" style={{ marginTop: 14 }}>
        <label htmlFor="aud">Auditor (optional)</label>
        <input id="aud" placeholder="your-auditor.testnet" value={auditor} onChange={(e) => (setAuditor(e.target.value), setErr(null))} />
        <small>They can have the enclave open your own submissions, and no one else's. You can change this later.</small>
      </div>
      <div className="field" style={{ marginTop: 14 }}>
        <label htmlFor="note">Note to the council (optional)</label>
        <input id="note" placeholder="Strategy, size, why you'd add to the panel" maxLength={MAX_NOTE} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {err && <p style={{ color: "var(--rose-ink)", fontSize: 13, marginTop: 12 }}>{err}</p>}
      <button className="btn wide" style={{ marginTop: 18 }} type="submit" disabled={busy}>
        {busy ? "Waiting for your wallet…" : `Apply · ${near(bond)} bond, returned`}
      </button>
    </form>
  );
}

function OpenRound({ loans, members, floor }: { loans: RegisteredLoan[]; members: number; floor: number }) {
  const { act } = useAccount();
  const navigate = useNavigate();
  const [loanId, setLoanId] = useState("");
  const [hours, setHours] = useState("48");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const h = Number(hours);
    if (!loanId) return setErr("Choose a registered loan.");
    if (!Number.isFinite(h) || h < 0.1 || h > 24 * 30) return setErr("Keep the round open between 6 minutes and 30 days.");
    setErr(null);
    setBusy(true);
    const closes_at = (BigInt(Date.now() + Math.round(h * 3_600_000)) * 1_000_000n).toString();
    const ok = await act({ method: "open_round", args: { loan_id: loanId, closes_at }, deposit: ENCLAVE_FEE_YOCTO, tgas: 300, label: "Opening the round" });
    setBusy(false);
    if (ok) navigate("/rounds");
  };

  return (
    <form className="card" onSubmit={submit}>
      <div className="label">Open a round</div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="loan">Loan</label>
          <select id="loan" value={loanId} onChange={(e) => (setLoanId(e.target.value), setErr(null))}>
            <option value="">Choose a registered loan</option>
            {loans.map((l) => <option key={l.id} value={l.id}>{loanName(l.label)}</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor="h">Open for (hours)</label><input id="h" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} /></div>
      </div>
      {loans.length === 0 && <p className="note bad">No loans are registered yet. A council member can propose one below.</p>}
      {members < floor && <p className="note bad">Only {members} funds are on the panel. A round needs {floor} valid marks to publish anything.</p>}
      {err && <p style={{ color: "var(--rose-ink)", fontSize: 13, marginTop: 12 }}>{err}</p>}
      <button className="btn wide" style={{ marginTop: 18 }} type="submit" disabled={busy}>
        {busy ? "Waiting for your wallet…" : `Open round · ${near(ENCLAVE_FEE_YOCTO)} enclave fee`}
      </button>
    </form>
  );
}

function Decisions({ proposals, config, account }: { proposals: Proposal[]; config: Config; account: string }) {
  const { act } = useAccount();
  const [busy, setBusy] = useState<string | null>(null);
  const vote = async (id: string) => {
    setBusy(id);
    await act({ method: "vote", args: { proposal_id: id }, label: "Voting", tgas: 60 });
    setBusy(null);
  };
  return (
    <div className="card">
      <div className="label">Council decisions · {proposals.length}</div>
      {proposals.length === 0 ? (
        <p className="hint" style={{ marginTop: 8 }}>Nothing is waiting for a vote.</p>
      ) : (
        proposals.map((p) => (
          <div className="app" key={p.id}>
            <div>
              <strong>{describe(p.kind)}</strong>
              <p className="hint" style={{ fontSize: 13 }}>
                Proposed by {handle(p.proposer)} · {p.votes.filter((v) => config.council.includes(v)).length} of {config.threshold} votes · lapses 7 days after {date(p.created_at)}
              </p>
            </div>
            <div className="app-actions">
              {!p.votes.includes(account) && <button className="btn small" disabled={busy === p.id} onClick={() => vote(p.id)}>Vote yes</button>}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

type Propose = (kind: ProposalKind, label: string) => Promise<void>;

function ReadPrice({ current, onPropose }: { current: string; onPropose: Propose }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d+(\.\d{1,6})?$/.test(value.trim())) return setErr("Enter a price in NEAR, like 0.25.");
    const [whole, frac = ""] = value.trim().split(".");
    const yocto = BigInt(whole) * YOCTO + BigInt(frac.padEnd(24, "0"));
    if (yocto === 0n) return setErr("The price must be above zero.");
    setErr(null);
    setBusy(true);
    await onPropose({ SetReadPrice: yocto.toString() }, `Proposing a price of ${near(yocto)}`);
    setValue("");
    setBusy(false);
  };
  return (
    <form className="card" onSubmit={submit}>
      <div className="label">Read price</div>
      <p className="serif" style={{ fontSize: 34, margin: "10px 0 4px" }}>{near(current)}</p>
      <p className="hint">Paid to the funds whose marks counted, after the council's fixed share. A change needs the council's votes.</p>
      <div className="field" style={{ marginTop: 14 }}>
        <label htmlFor="price" className="sr-only">New price in NEAR</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input id="price" style={{ flex: 1 }} inputMode="decimal" placeholder="0.25" value={value} onChange={(e) => (setValue(e.target.value), setErr(null))} />
          <button className="btn ghost" type="submit" disabled={busy}>{busy ? "…" : "Propose price"}</button>
        </div>
        {err && <span className="err">{err}</span>}
      </div>
    </form>
  );
}

function RegisterLoan({ onPropose }: { onPropose: Propose }) {
  const [borrower, setBorrower] = useState("");
  const [facility, setFacility] = useState("");
  const [maturity, setMaturity] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const label = encodeLoan({ borrower: borrower.trim(), ...(facility.trim() && { facility: facility.trim() }), ...(maturity && { maturity }) });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!borrower.trim()) return setErr("Name the borrower.");
    if (new TextEncoder().encode(label).length > MAX_LOAN) return setErr("Shorten the names; the loan label is limited to 120 characters.");
    setErr(null);
    setBusy(true);
    await onPropose({ RegisterLoan: label }, `Proposing the loan ${borrower.trim()}`);
    setBorrower("");
    setFacility("");
    setMaturity("");
    setBusy(false);
  };
  return (
    <form className="card" onSubmit={submit}>
      <div className="label">Register a loan</div>
      <p className="hint" style={{ marginTop: 6 }}>Rounds open only on registered loans, so every fund prices the same instrument. The registry holds 64 at a time; remove old ones to make room.</p>
      <div className="form-grid">
        <div className="field"><label htmlFor="b">Borrower</label><input id="b" placeholder="Harbor Retail" value={borrower} onChange={(e) => setBorrower(e.target.value)} /></div>
        <div className="field"><label htmlFor="f">Facility</label><input id="f" placeholder="Term loan B" value={facility} onChange={(e) => setFacility(e.target.value)} /></div>
        <div className="field"><label htmlFor="m">Maturity</label><input id="m" type="date" value={maturity} onChange={(e) => setMaturity(e.target.value)} /></div>
      </div>
      {err && <p style={{ color: "var(--rose-ink)", fontSize: 13, marginTop: 12 }}>{err}</p>}
      <button className="btn ghost wide" style={{ marginTop: 18 }} type="submit" disabled={busy}>{busy ? "…" : "Propose this loan"}</button>
    </form>
  );
}

/** The council's own seats and how many must agree. */
function Seats({ config, onPropose }: { config: Config; onPropose: Propose }) {
  const [seat, setSeat] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const n = config.council.length;
  const majority = Math.floor(n / 2) + 1;
  const thresholds = Array.from({ length: n - majority + 1 }, (_, i) => majority + i).filter((t) => t >= 2);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const a = seat.trim().toLowerCase();
    if (!validAccount(a)) return setErr("Enter a NEAR account.");
    if (config.council.includes(a)) return setErr("Already on the council.");
    if (n >= 7) return setErr("The council has 7 seats, the most it can.");
    setErr(null);
    await onPropose({ AddCouncil: a }, `Proposing ${handle(a)} for the council`);
    setSeat("");
  };
  return (
    <div className="card">
      <div className="label">Council seats · {config.threshold} of {n} decide</div>
      <ul className="members">
        {config.council.map((c, i) => (
          <li key={c}>
            <span className="av">{i + 1}</span>
            <span className="mono">{c}</span>
            {n > 3 && n - 1 >= config.threshold && (
              <button className="btn ghost small" onClick={() => onPropose({ RemoveCouncil: c }, `Proposing to remove ${handle(c)} from the council`)}>Propose removal</button>
            )}
          </li>
        ))}
      </ul>
      <p className="hint" style={{ marginTop: 8 }}>3 to 7 seats. Adding a seat raises the threshold if needed, so a majority always decides.</p>
      <form onSubmit={add} className="field" style={{ marginTop: 12 }}>
        <label htmlFor="seat" className="sr-only">Account to seat</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input id="seat" style={{ flex: 1 }} placeholder="new-member.testnet" value={seat} onChange={(e) => (setSeat(e.target.value), setErr(null))} />
          <button className="btn ghost" type="submit">Propose seat</button>
        </div>
        {err && <span className="err">{err}</span>}
      </form>
      {thresholds.length > 1 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          {thresholds.filter((t) => t !== config.threshold).map((t) => (
            <button key={t} className="btn ghost small" onClick={() => onPropose({ SetThreshold: t }, `Proposing ${t} of ${n} to decide`)}>Propose {t} of {n}</button>
          ))}
        </div>
      )}
    </div>
  );
}

const DAY_MS = 24 * 3600 * 1000;

/** What happens if the council stops: the panel's funds can replace it by a two-thirds vote. */
function CouncilWatch({ config, members, takeover, account, isCouncil, onPropose }: { config: Config; members: string[]; takeover: Takeover | null; account: string | null; isCouncil: boolean; onPropose: Propose }) {
  const { act } = useAccount();
  const [accounts, setAccounts] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isMember = !!account && members.includes(account);
  const quietMs = Date.now() - nsToMs(config.last_council_action);
  const limitMs = config.council_dormant_after_secs * 1000;
  const dormant = quietMs >= limitMs;
  const needed = Math.ceil((members.length * 2) / 3);
  const days = (ms: number) => Math.max(0, Math.floor(ms / DAY_MS));

  const start = async (e: FormEvent) => {
    e.preventDefault();
    const list = accounts.split(/[\s,]+/).map((a) => a.trim().toLowerCase()).filter(Boolean);
    if (list.length < 3 || list.length > 7 || new Set(list).size !== list.length) return setErr("Name 3 to 7 different accounts.");
    if (!list.every(validAccount)) return setErr("One of those isn't a NEAR account.");
    setErr(null);
    setBusy(true);
    await act({ method: "propose_council_takeover", args: { council: list, threshold: Math.floor(list.length / 2) + 1 }, label: "Proposing a new council", tgas: 60 });
    setBusy(false);
  };
  const vote = async () => {
    setBusy(true);
    await act({ method: "vote_council_takeover", args: {}, label: "Voting for the new council", tgas: 60 });
    setBusy(false);
  };

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <div className="label">If the council goes quiet</div>
      <p className="muted" style={{ marginTop: 8 }}>
        If the council makes no decision for {days(limitMs)} days, two thirds of the panel's funds can vote in a new one. The council's last decision was {days(quietMs)} days ago.
        {isCouncil && " Any decision resets the clock; a heartbeat is the cheapest."}
      </p>
      {isCouncil && (
        <button className="btn ghost small" style={{ marginTop: 12 }} onClick={() => onPropose("Heartbeat", "Proposing a heartbeat")}>Propose a heartbeat</button>
      )}
      {takeover && (
        <div className="app" style={{ marginTop: 16 }}>
          <div>
            <strong>Vote to replace the council</strong>
            <p className="hint" style={{ fontSize: 13 }}>
              New council: {takeover.council.map(handle).join(", ")} · {takeover.threshold} of {takeover.council.length} to decide · {takeover.votes.filter((v) => members.includes(v)).length} of {needed} votes needed. It lapses 14 days after {date(takeover.created_at)}, and the old council can still stop it by deciding anything.
            </p>
          </div>
          <div className="app-actions">
            {isMember && !takeover.votes.includes(account!) && <button className="btn small" disabled={busy} onClick={vote}>Vote yes</button>}
          </div>
        </div>
      )}
      {!takeover && dormant && isMember && members.length >= config.min_contributors && (
        <form onSubmit={start} style={{ marginTop: 16 }}>
          <div className="field">
            <label htmlFor="newcouncil">The council has been silent. Propose a new one (3 to 7 accounts, separated by commas)</label>
            <input id="newcouncil" placeholder="one.near, two.near, three.near" value={accounts} onChange={(e) => (setAccounts(e.target.value), setErr(null))} />
            {err && <span className="err">{err}</span>}
          </div>
          <button className="btn wide" type="submit" disabled={busy} style={{ marginTop: 12 }}>{busy ? "Waiting for your wallet…" : "Propose this council"}</button>
        </form>
      )}
    </div>
  );
}

function Registry({ loans, busy, isCouncil, onPropose }: { loans: RegisteredLoan[]; busy: Set<string>; isCouncil: boolean; onPropose: Propose }) {
  if (loans.length === 0) return null;
  return (
    <div className="card" style={{ marginTop: 24 }}>
      <div className="label">Registered loans · {loans.length}</div>
      <ul className="members">
        {loans.map((l) => (
          <li key={l.id}>
            <span className="av">{l.id}</span>
            <span>{loanName(l.label)}</span>
            {busy.has(l.id) && <span className="hint" style={{ marginLeft: "auto" }}>round running</span>}
            {isCouncil && !busy.has(l.id) && (
              <button className="btn ghost small" onClick={() => onPropose({ RemoveLoan: l.id }, `Proposing to remove ${loanName(l.label)}`)}>
                Propose removal
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
