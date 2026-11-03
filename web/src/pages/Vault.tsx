import { useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Empty, LoanTitle, Skeleton } from "../components/bits";
import { TrackRecord } from "../components/TrackRecord";
import { useToast } from "../components/Toaster";
import { useAccount } from "../lib/account";
import { useChain, useLoad } from "../lib/chain";
import { handle, near, short } from "../lib/format";
import { downloadBackup, getBuyerKey, restoreBackup } from "../lib/keys";
import { ownMark, useReads } from "../lib/reads";
import { recordPoints } from "../lib/record";
import type { Basis, PurchaseStatus } from "../lib/types";
import { useWallet } from "../lib/wallet";
import "./Vault.css";

const PURCHASE: Record<PurchaseStatus, { label: string; tone: string }> = {
  Pending: { label: "Sealing", tone: "tone-busy" },
  Delivered: { label: "Delivered", tone: "tone-open" },
  Refunded: { label: "Refunded", tone: "tone-bad" },
};

const BASIS: Record<Basis, string> = { Purchased: "", Contributed: "free · your mark counted", Audit: "free · as auditor" };

export default function Vault() {
  const { rounds, demoMode, members } = useChain();
  const { accountId: account, act } = useAccount();
  const { signIn } = useWallet();
  const [busy, setBusy] = useState(false);

  const { data: earnings } = useLoad((s) => (account ? s.earnings(account) : Promise.resolve("0")), [account]);
  const { purchases, byRound } = useReads(account);
  const withdraw = async () => {
    setBusy(true);
    await act({ method: "withdraw", args: {}, label: `Withdrawing ${earnings ? near(earnings) : "earnings"}` });
    setBusy(false);
  };
  const marked = account ? rounds.some((r) => r.submitted.includes(account)) : false;
  const isMember = !!account && members.includes(account);

  return (
    <div className="wrap page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Vault</div>
          <h1>Your vault</h1>
          {account && <p className="mono" style={{ marginTop: 10 }}>{account}</p>}
        </div>
        {account && (isMember || (earnings !== undefined && BigInt(earnings) > 0n)) && (
          <div className="earn">
            <div>
              <div className="label">Earnings to withdraw</div>
              {earnings === undefined ? <Skeleton h={30} w={110} /> : <b>{near(earnings)}</b>}
            </div>
            {earnings !== undefined && BigInt(earnings) > 0n && (
              <button className="btn small" onClick={withdraw} disabled={busy} aria-disabled={busy}>
                {busy ? "Waiting for your wallet…" : "Withdraw"}
              </button>
            )}
          </div>
        )}
      </div>

      {!account ? (
        <Empty title="Connect your wallet" action={<button className="btn" onClick={signIn}>Connect wallet</button>}>
          Your earnings, the results you've read and your track record live here.
        </Empty>
      ) : (
        <>
          <section className="section first">
            <div className="section-head"><div><div className="eyebrow">Reads</div><h2>Results read</h2></div></div>
            {purchases && purchases.length === 0 ? (
              <Empty title="No reads yet" action={<Link className="btn ghost" to="/rounds">Browse rounds</Link>}>
                Results you buy, or open free because your mark counted, are kept on chain sealed to your key and listed here.
              </Empty>
            ) : (
              <div className="list">
                {(purchases ?? []).map((p) => {
                  const r = rounds.find((x) => x.id === p.round_id);
                  const st = byRound[p.round_id];
                  const note =
                    p.error ??
                    (p.status !== "Delivered" || st?.purchase.id !== p.id
                      ? null
                      : st.kind === "opened"
                        ? `${st.opened.mean} ± ${Number(st.opened.spread).toFixed(2)}`
                        : st.kind === "locked"
                          ? "sealed to a key this device doesn't hold"
                          : null);
                  const basis = BASIS[p.basis];
                  return (
                    <Link className="item" key={p.id} to={`/rounds/${p.round_id}?view=lender`}>
                      <span className="i">#{p.id}</span>
                      <span>
                        {r ? <LoanTitle round={r} /> : <h3>Round {p.round_id}</h3>}
                        {(note || basis) && <span className="hint">{[basis, note].filter(Boolean).join(" · ")}</span>}
                      </span>
                      <span className="muted">{p.basis === "Purchased" ? near(p.price) : "free"}</span>
                      <span className={`pill ${PURCHASE[p.status].tone}`}>{PURCHASE[p.status].label}</span>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>

          {marked && (
            <section className="section">
              <div className="section-head">
                <div>
                  <div className="eyebrow">Track record</div>
                  <h2>Where your marks sat</h2>
                  <p className="muted" style={{ marginTop: 8, maxWidth: 620 }}>
                    Your marks kept on this device against the consensus you read for free. Only you, and an auditor you name, can see this.
                  </p>
                </div>
              </div>
              <div className="card">
                <TrackRecord
                  who="Your marks"
                  table
                  points={recordPoints(account, rounds, (id) => {
                    const h = ownMark(account, id, demoMode);
                    return h === undefined ? undefined : h / 100;
                  }, byRound)}
                  empty="Nothing to compare yet. A round shows here once it publishes, you open your free copy, and your mark was kept on this device when you sent it."
                />
              </div>
            </section>
          )}

          {(!demoMode || isMember) && (
            <details className="card settings">
              <summary>
                <span>
                  <span className="label">Settings</span>
                  <span className="hint">{[!demoMode && "Reading key and backup", isMember && "your auditor"].filter(Boolean).join(", ")}</span>
                </span>
                <span aria-hidden="true">+</span>
              </summary>
              {!demoMode && <KeySection account={account} />}
              {isMember && <AuditorSection account={account} />}
            </details>
          )}
        </>
      )}
    </div>
  );
}

function AuditorSection({ account }: { account: string }) {
  const { act } = useAccount();
  const { data: current } = useLoad((s) => s.auditorOf(account), [account]);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async (auditor: string | null) => {
    if (auditor !== null) {
      const a = auditor.trim().toLowerCase();
      if (!/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(a) || a.length < 2 || a.length > 64)
        return setErr("Enter the auditor's NEAR account.");
      if (a === account) return setErr("A fund can't audit itself.");
      auditor = a;
    }
    setErr(null);
    setBusy(true);
    if (await act({ method: "set_auditor", args: { auditor }, label: auditor ? `Naming ${handle(auditor)} your auditor` : "Removing your auditor" })) setValue("");
    setBusy(false);
  };

  return (
    <div className="setting">
      <h3>Your auditor</h3>
      <div>
        <p className="muted">
          Your auditor can have the enclave open your own sealed marks, exactly as you sent them, and reads results you counted in for free.
          It can't see any other fund's mark. Only you can name or remove it.
        </p>
        <dl className="kv" style={{ marginTop: 16 }}>
          <dt>Current auditor</dt>
          <dd className="mono">{current === undefined ? "…" : current ?? "none"}</dd>
        </dl>
        <form className="field" style={{ marginTop: 16 }} onSubmit={(e: FormEvent) => (e.preventDefault(), save(value))}>
          <label htmlFor="auditor" className="sr-only">Auditor account</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input id="auditor" style={{ flex: 1, minWidth: 180 }} placeholder="your-auditor.testnet" value={value} onChange={(e) => (setValue(e.target.value), setErr(null))} />
            <button className="btn ghost small" type="submit" disabled={busy}>{current ? "Change" : "Name auditor"}</button>
            {current && <button className="btn ghost small" type="button" disabled={busy} onClick={() => save(null)}>Remove</button>}
          </div>
          {err && <span className="err">{err}</span>}
        </form>
      </div>
    </div>
  );
}

function KeySection({ account }: { account: string }) {
  const { refresh } = useChain();
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [, bump] = useState(0);
  const key = getBuyerKey(account);

  const restore = async (file: File | undefined) => {
    if (!file) return;
    try {
      await restoreBackup(account, file);
      toast("ok", "Key restored", "Reads sealed to it open on this device now.");
      bump((n) => n + 1);
      refresh();
    } catch (e) {
      toast("bad", "Couldn't restore that key", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="setting">
      <h3>Your reading key</h3>
      <div>
        <p className="muted">
          Results are sealed to a key made in this browser. It never leaves your device unless you save a backup.
          Anyone holding the backup file can open your reads, so keep it somewhere private.
        </p>
        <dl className="kv" style={{ marginTop: 16 }}>
          <dt>On this device</dt>
          <dd className="mono">{key ? short(key.pk, 10) : "none yet, made on your first read"}</dd>
        </dl>
        <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
          {key && <button className="btn ghost small" onClick={() => downloadBackup(account)}>Download backup</button>}
          <button className="btn ghost small" onClick={() => input.current?.click()}>Restore from backup</button>
          <input ref={input} type="file" accept="application/json,.json" hidden onChange={(e) => restore(e.target.files?.[0])} />
        </div>
      </div>
    </div>
  );
}
