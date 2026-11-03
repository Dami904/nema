import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount } from "../lib/account";
import { useChain, useLoad } from "../lib/chain";
import { ENCLAVE_FEE_YOCTO } from "../lib/config";
import { date, handle, near } from "../lib/format";
import type { Application } from "../lib/types";
import { encodeLoan } from "../lib/loan";
import "./Panel.css";

/** The contract refuses loan labels longer than this. */
const MAX_LOAN = 120;
const MAX_NOTE = 140;
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const validAccount = (a: string) => ACCOUNT_RE.test(a) && a.length >= 2 && a.length <= 64;
const YOCTO = 10n ** 24n;

export default function Panel() {
  const { members, config } = useChain();
  const { accountId, act } = useAccount();
  const [removing, setRemoving] = useState<string | null>(null);
  const isOwner = !!config && accountId === config.owner;
  const floor = config?.min_contributors ?? 4;
  const { data: applications } = useLoad((s) => s.applications(), []);

  const remove = async (account: string) => {
    if (!confirm(`Remove ${account} from the panel? It won't be able to mark new rounds.`)) return;
    setRemoving(account);
    await act({ method: "remove_member", args: { account }, label: `Removing ${handle(account)}` });
    setRemoving(null);
  };

  const canApply = !isOwner && !!accountId && !members.includes(accountId);

  return (
    <div className="wrap page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Panel</div>
          <h1>The <em>panel</em></h1>
          <p className="muted" style={{ marginTop: 10 }}>
            Owner: <span className="mono">{config?.owner ?? "…"}</span>
          </p>
        </div>
      </div>

      {!isOwner && (
        <p className="note" style={{ marginBottom: 24 }}>
          You're viewing the panel read-only. Only the owner can admit funds, open rounds and set the read price.
        </p>
      )}

      <div className={isOwner || canApply ? "grid2" : ""}>
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
                  {isOwner && (
                    <button className="btn ghost small" onClick={() => remove(m)} disabled={removing === m}>
                      {removing === m ? "…" : "Remove"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {isOwner && <AddMember members={members} />}
          {isOwner && <Applications applications={applications ?? []} />}
        </div>

        {isOwner ? (
          <div>
            <OpenRound members={members.length} floor={floor} />
            <ReadPrice current={config!.read_price} />
          </div>
        ) : (
          canApply && <Apply account={accountId} pending={applications?.find((a) => a.account === accountId)} bond={config?.application_bond} />
        )}
      </div>
    </div>
  );
}

function AddMember({ members }: { members: string[] }) {
  const { act } = useAccount();
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const account = id.trim().toLowerCase();
    if (!validAccount(account)) return setErr("Enter a NEAR account, like new-fund.testnet.");
    if (members.includes(account)) return setErr("That fund is already on the panel.");
    setErr(null);
    setBusy(true);
    if (await act({ method: "add_member", args: { account }, label: `Admitting ${handle(account)}` })) setId("");
    setBusy(false);
  };
  return (
    <form className="field" style={{ marginTop: 20 }} onSubmit={submit}>
      <label htmlFor="member">Admit a fund</label>
      <div style={{ display: "flex", gap: 8 }}>
        <input id="member" style={{ flex: 1 }} placeholder="new-fund.testnet" value={id} onChange={(e) => (setId(e.target.value), setErr(null))} aria-invalid={!!err} />
        <button className="btn" type="submit" disabled={busy}>{busy ? "…" : "Admit"}</button>
      </div>
      {err && <span className="err">{err}</span>}
    </form>
  );
}

function Applications({ applications }: { applications: Application[] }) {
  const { act } = useAccount();
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (account: string, approve: boolean) => {
    setBusy(account);
    await act({ method: approve ? "approve" : "reject", args: { account }, label: `${approve ? "Admitting" : "Turning away"} ${handle(account)}` });
    setBusy(null);
  };
  return (
    <div className="apps">
      <div className="label">Waiting to join · {applications.length}</div>
      {applications.length === 0 ? (
        <p className="hint" style={{ marginTop: 8 }}>No applications. Funds apply from this page with their own wallet.</p>
      ) : (
        applications.map((a) => (
          <div className="app" key={a.account}>
            <div>
              <strong>{handle(a.account)}</strong> <span className="hint">· applied {date(a.applied_at)}</span>
              <span className="mono" style={{ display: "block" }}>{a.account}</span>
              {a.note && <p className="muted" style={{ fontSize: 14, marginTop: 4 }}>{a.note}</p>}
              <p className="hint" style={{ fontSize: 13 }}>{a.auditor ? `Auditor: ${a.auditor}` : "No auditor named"} · bond {near(a.bond)}, returned either way</p>
            </div>
            <div className="app-actions">
              <button className="btn small" onClick={() => decide(a.account, true)} disabled={busy === a.account}>Admit</button>
              <button className="btn ghost small" onClick={() => decide(a.account, false)} disabled={busy === a.account}>Turn away</button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

const DEFAULT_BOND = (5n * 10n ** 22n).toString();

function Apply({ account, pending, bond = DEFAULT_BOND }: { account: string; pending?: Application; bond?: string }) {
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
        <h3 className="serif" style={{ fontSize: 30, margin: "10px 0 6px" }}>Waiting on the owner</h3>
        <p className="muted">
          Applied {date(pending.applied_at)}{pending.auditor ? `, naming ${pending.auditor} as your auditor` : ""}. Your {near(pending.bond)} bond comes back
          whether you're admitted or not.
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
        {handle(account)} isn't on the panel. Apply, and the owner admits you or turns you away. Panel funds mark rounds, read results
        for free and share the read fees.
      </p>
      <div className="field" style={{ marginTop: 14 }}>
        <label htmlFor="aud">Auditor (optional)</label>
        <input id="aud" placeholder="your-auditor.testnet" value={auditor} onChange={(e) => (setAuditor(e.target.value), setErr(null))} />
        <small>They can have the enclave open your own submissions, and no one else's. You can change this later.</small>
      </div>
      <div className="field" style={{ marginTop: 14 }}>
        <label htmlFor="note">Note to the owner (optional)</label>
        <input id="note" placeholder="Strategy, size, why you'd add to the panel" maxLength={MAX_NOTE} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {err && <p style={{ color: "var(--rose-ink)", fontSize: 13, marginTop: 12 }}>{err}</p>}
      <button className="btn wide" style={{ marginTop: 18 }} type="submit" disabled={busy}>
        {busy ? "Waiting for your wallet…" : `Apply · ${near(bond)} bond, returned`}
      </button>
    </form>
  );
}

function OpenRound({ members, floor }: { members: number; floor: number }) {
  const { act } = useAccount();
  const navigate = useNavigate();
  const [borrower, setBorrower] = useState("");
  const [facility, setFacility] = useState("");
  const [maturity, setMaturity] = useState("");
  const [hours, setHours] = useState("48");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loan = encodeLoan({ borrower: borrower.trim(), ...(facility.trim() && { facility: facility.trim() }), ...(maturity && { maturity }) });
  const tooLong = new TextEncoder().encode(loan).length > MAX_LOAN;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const h = Number(hours);
    if (!borrower.trim()) return setErr("Name the borrower.");
    if (tooLong) return setErr("Shorten the borrower or facility name; the loan label is limited to 120 characters.");
    if (!Number.isFinite(h) || h < 0.1 || h > 24 * 30) return setErr("Keep the round open between 6 minutes and 30 days.");
    setErr(null);
    setBusy(true);
    const closes_at = (BigInt(Date.now() + Math.round(h * 3_600_000)) * 1_000_000n).toString();
    const ok = await act({ method: "open_round", args: { loan, closes_at }, deposit: ENCLAVE_FEE_YOCTO, tgas: 300, label: "Opening the round" });
    setBusy(false);
    if (ok) {
      setBorrower("");
      setFacility("");
      setMaturity("");
      navigate("/rounds");
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <div className="label">Open a round</div>
      <div className="form-grid">
        <div className="field"><label htmlFor="b">Borrower</label><input id="b" placeholder="Harbor Retail" value={borrower} onChange={(e) => setBorrower(e.target.value)} /></div>
        <div className="field"><label htmlFor="f">Facility</label><input id="f" placeholder="Term loan B" value={facility} onChange={(e) => setFacility(e.target.value)} /></div>
        <div className="field"><label htmlFor="m">Maturity</label><input id="m" type="date" value={maturity} onChange={(e) => setMaturity(e.target.value)} /></div>
        <div className="field"><label htmlFor="h">Open for (hours)</label><input id="h" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} /></div>
      </div>
      {members < floor && <p className="note bad">Only {members} funds are on the panel. A round needs {floor} valid marks to publish anything.</p>}
      {tooLong && <p className="note bad">The loan label is over 120 characters. Shorten the names.</p>}
      {err && <p style={{ color: "var(--rose-ink)", fontSize: 13, marginTop: 12 }}>{err}</p>}
      <button className="btn wide" style={{ marginTop: 18 }} type="submit" disabled={busy}>
        {busy ? "Waiting for your wallet…" : `Open round · ${near(ENCLAVE_FEE_YOCTO)} enclave fee`}
      </button>
    </form>
  );
}

function ReadPrice({ current }: { current: string }) {
  const { act } = useAccount();
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
    if (await act({ method: "set_read_price", args: { read_price: yocto.toString() }, label: `Setting the price to ${near(yocto)}` })) setValue("");
    setBusy(false);
  };
  return (
    <form className="card" onSubmit={submit}>
      <div className="label">Read price</div>
      <p className="serif" style={{ fontSize: 34, margin: "10px 0 4px" }}>{near(current)}</p>
      <p className="hint">Shared equally by the funds whose marks counted.</p>
      <div className="field" style={{ marginTop: 14 }}>
        <label htmlFor="price" className="sr-only">New price in NEAR</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input id="price" style={{ flex: 1 }} inputMode="decimal" placeholder="0.25" value={value} onChange={(e) => (setValue(e.target.value), setErr(null))} />
          <button className="btn ghost" type="submit" disabled={busy}>{busy ? "…" : "Change price"}</button>
        </div>
        {err && <span className="err">{err}</span>}
      </div>
    </form>
  );
}
