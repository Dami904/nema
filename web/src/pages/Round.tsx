import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Countdown, Empty, Gauge, LoanTitle, Ring, Skeleton, StatusPill, loanMeta } from "../components/bits";
import { BorrowingBase, PriceHistory } from "../components/Lending";
import { EnclaveProof } from "../components/Proof";
import { Settle } from "../components/Settle";
import { useToast } from "../components/Toaster";
import { useAccount } from "../lib/account";
import { useChain, useLoad, useNow } from "../lib/chain";
import { splitRead } from "../lib/split";
import { BUILDS, CONFIG, ENCLAVE_FEE_YOCTO, READ_EXTRA_YOCTO, STORAGE_DEPOSIT_YOCTO, SUBMIT_DEPOSIT_YOCTO } from "../lib/config";
import { date, handle, near, nsToMs, short } from "../lib/format";
import { commitment, setHash, sha256Hex } from "../lib/hashes";
import { downloadBackup, ensureBuyerKey, getBuyerKey, keepMark, restoreBackup, sealMark } from "../lib/keys";
import { parseLoan } from "../lib/loan";
import { useOwnMark, useReads, type ReadState } from "../lib/reads";
import type { Basis, Opened, Purchase, Round as RoundT } from "../lib/types";
import { download, fileSlug, loanKey, roundCsv, termsFor } from "../lib/valuation";
import { useWallet } from "../lib/wallet";
import "./Round.css";

type View = "fund" | "lender" | "verify";

/** Enclave calls need room for OutLayer's request plus our callback. */
const ENCLAVE_TGAS = 300;

export default function Round() {
  const { id = "" } = useParams();
  const { rounds, members, config, link } = useChain();
  const { accountId } = useAccount();
  const [params, setParams] = useSearchParams();
  const round = rounds.find((r) => r.id === id);
  const isMember = !!accountId && members.includes(accountId);
  const view = (params.get("view") as View | null) ?? (isMember ? "fund" : "lender");
  const setView = (v: View) => setParams({ view: v }, { replace: true });

  if (link === "loading") return <div className="wrap page"><Skeleton h={60} w="60%" /><div style={{ height: 24 }} /><Skeleton h={300} /></div>;
  if (!round)
    return (
      <div className="wrap page">
        <Empty title="No such round" action={<Link className="btn ghost" to="/rounds">All rounds</Link>}>
          Round {id} doesn't exist on this contract.
        </Empty>
      </div>
    );

  const floor = config?.min_contributors ?? 4;
  return (
    <div className="wrap page">
      <Link to="/rounds" className="back">← All rounds</Link>
      <div className="page-head">
        <div>
          <div className="eyebrow">Round {String(round.id).padStart(2, "0")}</div>
          <div className="round-title"><LoanTitle round={round} as="h1" /></div>
          <p className="muted" style={{ marginTop: 10 }}>
            {[loanMeta(round), `opened ${date(round.opened_at)}`].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="seg" role="group" aria-label="Choose a view">
          <button aria-pressed={view === "fund"} onClick={() => setView("fund")}>Fund</button>
          <button aria-pressed={view === "lender"} onClick={() => setView("lender")}>Result</button>
          <button aria-pressed={view === "verify"} onClick={() => setView("verify")}>Verify</button>
        </div>
      </div>

      <div className="grid2">
        <PanelCard round={round} floor={floor} />
        <div>
          {view === "fund" && <FundView round={round} isMember={isMember} />}
          {view === "lender" && <LenderView round={round} />}
          {view === "verify" && <VerifyView round={round} />}
        </div>
      </div>
    </div>
  );
}

function PanelCard({ round, floor }: { round: RoundT; floor: number }) {
  const { config } = useChain();
  const { act } = useAccount();
  const [busy, setBusy] = useState(false);
  const now = useNow();
  const counted = round.listing?.count ?? round.submitted.length;
  const closable = (round.status === "Open" && nsToMs(round.closes_at) <= now) || round.status === "CloseFailed";

  const close = async () => {
    setBusy(true);
    await act({ method: "close_round", args: { round_id: Number(round.id) }, deposit: ENCLAVE_FEE_YOCTO, tgas: ENCLAVE_TGAS, label: "Closing the round" });
    setBusy(false);
  };

  return (
    <div className="card fadein">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="label">Panel</div>
        <StatusPill status={round.status} />
      </div>
      <div className="ringrow">
        <Ring value={counted} floor={floor} />
        <dl className="kv" style={{ flex: 1 }}>
          <dt>Deadline</dt>
          <dd>{round.status === "Open" || round.status === "AwaitingKey" ? <Countdown closesAt={round.closes_at} /> : date(round.closes_at)}</dd>
          <dt>Read price</dt>
          <dd>{config ? near(config.read_price) : "—"}</dd>
        </dl>
      </div>
      <StateNote round={round} floor={floor} />
      {round.status === "Closing" && <Settle kind="round" id={round.id} />}
      {round.submitted.length > 0 && (
        <div className="funds" aria-label="Funds that submitted">
          {round.submitted.map((a, i) => (
            <span className="fund" key={a} title={a}><i>{i + 1}</i>{handle(a)}</span>
          ))}
        </div>
      )}
      {round.listing && round.listing.rejected.length > 0 && (
        <div className="rejected">
          <div className="label">Dropped</div>
          {round.listing.rejected.map((r) => (
            <p key={r.account}><strong>{handle(r.account)}</strong> <span className="muted">· {r.reason}</span></p>
          ))}
        </div>
      )}
      {closable && (
        <>
          <button className="btn wide" style={{ marginTop: 20 }} onClick={close} aria-disabled={busy} disabled={busy}>
            {busy ? "Waiting for your wallet…" : round.status === "CloseFailed" ? "Retry the close" : "Close the round"}
          </button>
          <p className="hint" style={{ marginTop: 8 }}>
            Anyone can close it. Attaches {near(ENCLAVE_FEE_YOCTO)} for the enclave, returned if too few funds submitted.
          </p>
        </>
      )}
    </div>
  );
}

function StateNote({ round, floor }: { round: RoundT; floor: number }) {
  const notes: Partial<Record<RoundT["status"], string>> = {
    AwaitingKey: "The enclave is creating this round's key. Submissions open as soon as it lands, usually within a minute.",
    Closing: "The enclave is tallying the sealed marks. The count and a commitment will appear here shortly.",
    CloseFailed: `The tally didn't come back${round.last_error ? `: ${round.last_error}` : ""}. Anyone can retry the close.`,
    Failed: `This round published nothing${round.last_error ? `: ${round.last_error}` : ""}. No marks were revealed.`,
  };
  if (round.status === "Open" && round.submitted.length < floor)
    return <p className="note">{floor - round.submitted.length} more {floor - round.submitted.length === 1 ? "fund needs" : "funds need"} to submit before this round can publish.</p>;
  const n = notes[round.status];
  return n ? <p className={`note ${round.status.includes("Fail") ? "bad" : ""}`}>{n}</p> : null;
}

function FundView({ round, isMember }: { round: RoundT; isMember: boolean }) {
  const { demoMode } = useChain();
  const { accountId, act } = useAccount();
  const { signIn } = useWallet();
  const [mark, setMark] = useState("");
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mine = accountId ? round.submitted.includes(accountId) : false;

  if (!accountId)
    return (
      <Empty title="Sign in as a fund" action={<button className="btn" onClick={signIn}>Connect wallet</button>}>
        Panel funds submit their marks here. Connect the wallet of a fund on the panel to mark this round.
      </Empty>
    );
  if (!isMember)
    return <Empty title="Not on the panel">{handle(accountId)} isn't a panel fund. Only funds the council has admitted can mark a round.</Empty>;
  if (round.status !== "Open")
    return (
      <div className="card fadein">
        <div className="label">Your mark</div>
        <h3 className="big-line">{mine ? "You marked this round." : "You didn't mark this round."}</h3>
        <p className="muted">
          {round.status === "AwaitingKey" ? "Submissions open once the round key arrives." : round.status === "Published" ? (round.listing?.contributors.includes(accountId) ? "Your mark counted, so your copy of the result is free. Open it from the Result view to see where your price sat." : "Your mark didn't count in this round. The Result view says why.") : "Submissions are closed."}
        </p>
      </div>
    );

  const submit = async () => {
    const v = Number(mark);
    if (mark.trim() === "" || !Number.isFinite(v)) return setErr("Enter a price, like 94.25.");
    if (v < 0 || v > 200) return setErr("Marks run from 0 to 200 points of par.");
    const hundredths = Math.round(v * 100);
    if (Math.abs(hundredths - v * 100) > 1e-6) return setErr("Use at most two decimals.");
    if (!round.pubkey) return setErr("This round has no key yet.");
    setErr(null);
    if (demoMode) {
      if (await act({ method: "submit", args: { round_id: round.id, mark: hundredths }, label: "Your sealed mark" })) setMark("");
      return;
    }
    setBusy(true);
    const ciphertext_hex = sealMark(round.pubkey, accountId, hundredths);
    const ok = await act({ method: "submit", args: { round_id: Number(round.id), ciphertext_hex }, deposit: SUBMIT_DEPOSIT_YOCTO, label: "Your sealed mark" });
    if (ok) {
      if (keep) keepMark(accountId, round.id, hundredths);
      setMark("");
    }
    setBusy(false);
  };

  return (
    <div className="card fadein">
      <div className="label">Your mark</div>
      {mine && <p className="note">You've submitted. You can replace your mark until the deadline; the latest one counts.</p>}
      <div className="field" style={{ marginTop: 18 }}>
        <label htmlFor="mark">Price, in points of par</label>
        <input id="mark" inputMode="decimal" placeholder="94.25" value={mark} onChange={(e) => (setMark(e.target.value), setErr(null))}
          aria-invalid={!!err} aria-describedby="mark-help" />
        {err ? <span className="err">{err}</span> : <small id="mark-help">Encrypted in your browser before it leaves. Only the enclave can open it. Attaches {near(SUBMIT_DEPOSIT_YOCTO)} for storage; the unused part comes back.</small>}
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
        Keep my mark on this device (unencrypted, in this browser only), so I can see where I stood once the round publishes
      </label>
      <button className="btn wide" style={{ marginTop: 18 }} onClick={submit} disabled={busy} aria-disabled={busy}>
        {busy ? "Waiting for your wallet…" : mine ? "Replace my mark" : "Seal and submit"}
      </button>
    </div>
  );
}

function LenderView({ round }: { round: RoundT }) {
  const { config, demoMode } = useChain();
  const { accountId, act } = useAccount();
  const { signIn } = useWallet();
  const { toast } = useToast();
  const { purchases, byRound } = useReads(accountId);
  const [busy, setBusy] = useState(false);
  const [justBought, setJustBought] = useState(false);
  const { data: clients } = useLoad((s) => (accountId ? s.clientsOf(accountId) : Promise.resolve([] as string[])), [accountId]);
  // The contract decides who reads free (an auditor only for rounds that closed
  // after it was named), so ask it rather than guess from the client list.
  const { data: free } = useLoad(
    (s) => (accountId && round.status === "Published" ? s.freeBasis(round.id, accountId) : Promise.resolve(null as Basis | null)),
    [accountId, round.id, round.status],
  );
  const read = byRound[round.id];
  const refunded = (purchases ?? []).filter((p) => p.round_id === round.id && p.status === "Refunded");
  const counted = round.listing?.contributors ?? [];
  const client = clients?.find((c) => counted.includes(c));
  // Until we know whether this account reads free, show neither offer.
  const deciding = !!accountId && (free === undefined || purchases === undefined);

  if (round.status !== "Published")
    return (
      <Empty title="Nothing to read yet">
        {round.status === "Failed" ? "This round didn't publish, so there's no result to buy." : "A result can be bought once the round publishes."}
      </Empty>
    );

  const price = config ? BigInt(config.read_price) : 0n;
  const contributors = round.listing?.contributors.length ?? 0;
  const seats = config?.council?.length ?? 0;
  const split = splitRead(price, contributors, seats, config?.council_share_bps ?? 0);
  // The council can limit paid reads to readers it approved.
  const barred = !!config?.readers_only && !!accountId && !(config.readers ?? []).includes(accountId);

  const buy = async () => {
    if (!accountId) return signIn();
    const method = free ? "claim_read" : "buy_read";
    const label = free ? "Opening your free copy" : "Buying a read";
    if (demoMode) {
      if (await act({ method, args: { round_id: round.id }, label })) setJustBought(true);
      return;
    }
    let pk: string;
    try {
      pk = ensureBuyerKey(accountId).pk;
    } catch (e) {
      return toast("bad", "Can't keep a key in this browser", e instanceof Error ? e.message : String(e));
    }
    setBusy(true);
    const ok = await act({
      method,
      args: { round_id: Number(round.id), buyer_pubkey: pk },
      deposit: (free ? 0n : price) + READ_EXTRA_YOCTO,
      tgas: ENCLAVE_TGAS,
      label,
    });
    setBusy(false);
    if (ok) setJustBought(true);
  };

  return (
    <div className="card fadein">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div className="label">Consensus</div>
        {read && read.purchase.basis !== "Purchased" && <span className="pill tone-open">Free copy</span>}
      </div>
      {read?.kind === "opened" ? (
        <OpenedResult round={round} opened={read.opened} byRound={byRound} />
      ) : (
        <>
          <div className="sealed">
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span className="muted" style={{ fontSize: 13 }}>
                {read?.kind === "pending" ? "The enclave is sealing your copy…" : read ? "Delivered, sealed to your key" : "Sealed until you buy a read"}
              </span>
              <span className="label" style={{ color: "var(--sage)" }}>Your key only</span>
            </div>
            <div className="nums">
              <div><div className="label">Mean</div><span className="blurnum serif">94.125</span></div>
              <div><div className="label">Spread</div><span className="blurnum serif">1.75</span></div>
              <div><div className="label">Funds</div><span className="serif">{round.listing?.count}</span></div>
            </div>
          </div>
          {read?.kind === "pending" && read.purchase.status === "Pending" && <Settle kind="read" id={read.purchase.id} />}
          {read?.kind === "locked" && accountId && <LockedRead account={accountId} />}
          {read?.kind === "broken" && <p className="note bad">Your copy couldn't be opened: {read.error}</p>}
          {deciding && <Skeleton h={120} />}
          {!deciding && !read && free && (
            <>
              <div className="stand">
                <div className="label">{free === "Contributed" ? "Your mark counted" : client ? `You audit ${handle(client)}` : "You audit a fund that counted"}</div>
                <p>
                  {free === "Contributed"
                    ? "Funds whose marks counted read the result for free. Lenders pay; you share their fees."
                    : "The auditor a counted fund named reads the result for free, to check that fund's price against it."}
                </p>
              </div>
              <Fees total={READ_EXTRA_YOCTO}>
                <dt>Read price</dt><dd>free</dd>
                <dt>Enclave fee (OutLayer)</dt><dd>{near(ENCLAVE_FEE_YOCTO)}</dd>
                <dt>Storage, kept by the contract</dt><dd>{near(STORAGE_DEPOSIT_YOCTO)}</dd>
              </Fees>
              <button className="btn wide" onClick={buy} disabled={busy} aria-disabled={busy}>
                {busy ? "Waiting for your wallet…" : `Open your free copy · ${near(READ_EXTRA_YOCTO)}`}
              </button>
              <p className="hint" style={{ marginTop: 8 }}>One free copy per round, sealed to a key made in this browser. Back the key up when asked.</p>
            </>
          )}
          {!deciding && !read && !free && (
            <>
              <Fees total={price + READ_EXTRA_YOCTO}>
                <dt>Read price</dt><dd>{near(price)}</dd>
                <dt>To each of {contributors} funds</dt><dd>{near(split.perFund)}</dd>
                {split.perSeat > 0n && (<><dt>To each of {seats} council seats</dt><dd>{near(split.perSeat)}</dd></>)}
                {split.remainder > 0n && (<><dt>Rounding, to the first council seat</dt><dd>{split.remainder < 10n ** 20n ? "under 0.0001 NEAR" : near(split.remainder)}</dd></>)}
                <dt>Enclave fee (OutLayer)</dt><dd>{near(ENCLAVE_FEE_YOCTO)}</dd>
                <dt>Storage, kept by the contract</dt><dd>{near(STORAGE_DEPOSIT_YOCTO)}</dd>
              </Fees>
              {barred ? (
                <p className="note">This panel sells paid reads only to readers its council approved. A council member can propose your account on the Panel page.</p>
              ) : (
                <>
                  <button className="btn wide" onClick={buy} disabled={busy} aria-disabled={busy}>
                    {busy ? "Waiting for your wallet…" : accountId ? `Buy a read · ${near(price + READ_EXTRA_YOCTO)}` : "Connect wallet to buy"}
                  </button>
                  <p className="hint" style={{ marginTop: 8 }}>If the enclave fails, the read price comes back to you.</p>
                </>
              )}
            </>
          )}
        </>
      )}
      {(justBought || read?.kind === "pending") && accountId && !demoMode && <BackupPrompt account={accountId} />}
      {/* Once a copy opens, an older refund is history; the Vault still lists it. */}
      {read?.kind !== "opened" && refunded.map((p) => (
        <p className="note bad" key={p.id}>Read #{p.id} was refunded{p.error ? `: ${p.error}` : ""}.</p>
      ))}
    </div>
  );
}

/** The total, with where it goes folded underneath. */
function Fees({ total, children }: { total: bigint; children: ReactNode }) {
  return (
    <details className="fees">
      <summary>
        <span>You pay <span className="hint">· where it goes</span></span>
        <strong>{near(total)}</strong>
      </summary>
      <dl className="kv">{children}</dl>
    </details>
  );
}

function BackupPrompt({ account }: { account: string }) {
  return (
    <div className="stand" style={{ marginTop: 16 }}>
      <div className="label">Keep your key safe</div>
      <p>Your copy is sealed to a key that lives only in this browser. Save a backup, or you can't open it after clearing site data or on another device.</p>
      <button className="btn ghost small" style={{ marginTop: 10 }} onClick={() => downloadBackup(account)}>Download key backup</button>
    </div>
  );
}

function LockedRead({ account }: { account: string }) {
  const { refresh } = useChain();
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const restore = async (file: File | undefined) => {
    if (!file) return;
    try {
      await restoreBackup(account, file);
      toast("ok", "Key restored");
      refresh();
    } catch (e) {
      toast("bad", "Couldn't restore that key", e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="stand">
      <div className="label">Sealed to another key</div>
      <p>
        {getBuyerKey(account) ? "This browser holds a different key from the one this read was sealed to." : "This browser doesn't hold the key this read was sealed to."} Restore your key backup to open it.
      </p>
      <input ref={input} type="file" accept="application/json,.json" hidden onChange={(e) => restore(e.target.files?.[0])} />
      <button className="btn ghost small" style={{ marginTop: 10 }} onClick={() => input.current?.click()}>Restore key backup</button>
    </div>
  );
}

/** Files a lender can keep: the valuation as CSV, or the page printed to PDF. */
function ExportRound({ round, opened, purchase }: { round: RoundT; opened: Opened; purchase: Purchase }) {
  const { accountId } = useAccount();
  const save = () => {
    const name = `nema-${fileSlug(parseLoan(round.loan).borrower)}-round-${round.id}.csv`;
    download(name, roundCsv(round, opened, purchase, termsFor(accountId, round.loan, Number(opened.mean))));
  };
  return (
    <div className="export no-print">
      <button className="btn ghost small" onClick={save}>Download valuation (CSV)</button>
      <button className="btn ghost small" onClick={() => window.print()}>Print or save as PDF</button>
      <p className="hint">The file holds the result, the salt and the on-chain commitment, so anyone you give it to can check it.</p>
    </div>
  );
}

function OpenedResult({ round, opened, byRound }: { round: RoundT; opened: Opened; byRound: Record<string, ReadState> }) {
  const { rounds } = useChain();
  const { accountId } = useAccount();
  const ownMark = useOwnMark(accountId, round.id);
  const purchase = byRound[round.id]?.purchase;
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    commitment(CONFIG.contract, BigInt(round.id), opened.salt, opened.count, opened.mean, opened.spread).then((c) => setOk(c === round.listing?.commitment));
  }, [round, opened]);

  const mean = Number(opened.mean);
  const spread = Number(opened.spread);
  const sameLoan = rounds.filter((r) => loanKey(r.loan) === loanKey(round.loan));
  const history = sameLoan
    .flatMap((r) => {
      const st = byRound[r.id];
      return st?.kind === "opened" ? [{ id: r.id, mean: Number(st.opened.mean), spread: Number(st.opened.spread) }] : [];
    })
    .sort((a, b) => Number(a.id) - Number(b.id));
  const own = accountId && round.submitted.includes(accountId) ? ownMark : undefined;
  const ownPrice = own !== undefined ? own / 100 : undefined;
  const z = ownPrice !== undefined && spread > 0 ? (ownPrice - mean) / spread : undefined;

  return (
    <div className="fadein">
      <div className="result">
        <span className="serif mean">{opened.mean}</span>
        <span className="serif spread">± {spread.toFixed(2)}</span>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>{methodNote(opened, round.id)}</p>
      <Gauge mean={mean} spread={spread} own={ownPrice} />
      {z !== undefined && (
        <div className="stand">
          <div className="label">Where you stand</div>
          <p>
            Your mark of <strong>{ownPrice!.toFixed(2)}</strong> sat <strong className={Math.abs(z) <= 1 ? "in" : "out"}>{z >= 0 ? "+" : ""}{z.toFixed(2)}σ</strong> from the
            consensus{Math.abs(z) <= 1 ? ", inside one spread." : ", outside one spread."}
          </p>
        </div>
      )}
      <div className="check" style={{ marginTop: 14 }}>
        <span className="dot" style={ok === false ? { background: "var(--rose-ink)" } : undefined} />
        {ok === null ? "Checking against the on-chain commitment…" : ok ? "Matches the commitment published on chain." : "Does not match the on-chain commitment."}
      </div>
      {history.length > 1 && <PriceHistory points={history} current={round.id} />}
      <BorrowingBase mean={mean} spread={spread} loan={round.loan} />
      {purchase && <ExportRound round={round} opened={opened} purchase={purchase} />}
    </div>
  );
}

/** How the enclave turned the marks into this result. */
function methodNote(opened: Opened, roundId: string): string {
  if (opened.method === "exact" && Number(roundId) > BUILDS.earlierEnclaveLastRound)
    return "Warning: this round was tallied exactly, by an enclave build that should no longer run. Its result is not rounded.";
  if (opened.method !== "rounded") return `Mean and one standard deviation, in points of par, from ${opened.count} funds.`;
  const trim = Math.floor((opened.count - 1) / 4);
  const mean = trim > 0 ? `The mean of the middle ${opened.count - 2 * trim} of ${opened.count} marks (the ${trim === 1 ? "highest and lowest are" : `${trim} highest and ${trim} lowest are`} left out)` : `The mean of all ${opened.count} marks`;
  return `${mean}, to the nearest eighth of a point, and the spread of all ${opened.count}, to the nearest quarter. Rounding means funds that pool their own marks can place the others only to within about a point, not solve for them.`;
}

function VerifyView({ round }: { round: RoundT }) {
  const { data: subs } = useLoad((s) => s.submissions(round.id), [round.id]);
  const [computed, setComputed] = useState<string | null>(null);
  const [rows, setRows] = useState<{ account: string; hash: string; at: string }[]>([]);

  useEffect(() => {
    if (!subs) return;
    setHash(subs).then(setComputed);
    Promise.all(subs.map(async (s) => ({ account: s.account, hash: await sha256Hex(s.ciphertext_hex), at: s.submitted_at }))).then(setRows);
  }, [subs]);

  const onChain = round.listing?.set_hash ?? round.set_hash;
  return (
    <>
    <div className="card fadein">
      <div className="label">Check it yourself</div>
      <p className="muted" style={{ margin: "10px 0 18px", fontSize: 14 }}>
        Recomputed in your browser from the ciphertexts stored on chain. Nothing here needs a wallet.
      </p>
      <dl className="kv verify">
        <dt>Set hash, on chain</dt><dd className="mono">{onChain ?? "set at the deadline"}</dd>
        <dt>Set hash, recomputed</dt><dd className="mono">{computed ?? "…"}</dd>
        {round.listing && (<><dt>Commitment</dt><dd className="mono">{round.listing.commitment}</dd></>)}
        <dt>Round key</dt><dd className="mono">{round.pubkey ? short(round.pubkey, 10) : "not created yet"}</dd>
      </dl>
      {onChain && computed && (
        <div className="check" style={{ marginTop: 14 }}>
          <span className="dot" style={onChain === computed ? undefined : { background: "var(--rose-ink)" }} />
          {onChain === computed
            ? "The enclave tallied exactly the submissions stored on chain."
            : "The stored submissions don't match the committed set."}
        </div>
      )}
      {rows.length > 0 && (
        <details className="subs">
          <summary className="label">Submissions ({rows.length}) <span aria-hidden="true">+</span></summary>
          {rows.map((r) => (
            <div className="sub" key={r.account}>
              <span>{handle(r.account)}</span>
              <span className="mono">{short(r.hash, 8)}</span>
              <span className="hint">{date(r.at)}</span>
            </div>
          ))}
        </details>
      )}
      <a className="btn ghost wide" style={{ marginTop: 18 }} href={`${CONFIG.explorerAccount}${CONFIG.contract}`} target="_blank" rel="noreferrer">
        Contract transactions on explorer ↗
      </a>
    </div>
    <EnclaveProof round={round} />
    </>
  );
}
