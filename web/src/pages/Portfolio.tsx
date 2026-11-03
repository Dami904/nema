import { useId, useState, type ChangeEvent } from "react";
import { Link } from "react-router-dom";
import { Empty, Skeleton } from "../components/bits";
import { usd } from "../components/Lending";
import { useAccount } from "../lib/account";
import { useChain } from "../lib/chain";
import { date } from "../lib/format";
import { useReads } from "../lib/reads";
import { borrowingBase, download, holdings, portfolioCsv, termsFor, useTerms, type Holding } from "../lib/valuation";
import { useWallet } from "../lib/wallet";
import "./Portfolio.css";

/** A fall this large, in points of par, is flagged even when it's inside one spread. */
const DROP_FLAG = 1;

export default function Portfolio() {
  const { rounds, link } = useChain();
  const { accountId } = useAccount();
  const { signIn } = useWallet();
  const { purchases, byRound } = useReads(accountId);
  // Bumped when any row's terms change, so the totals re-read them.
  const [edits, setEdits] = useState(0);

  const list = holdings(rounds, byRound);
  const waiting = Object.values(byRound).filter((s) => s.kind !== "opened").length;
  const rows = list.map((h) => {
    const t = termsFor(accountId, h.latest.round.loan, Number(h.latest.opened.mean));
    return { h, t, b: borrowingBase(t, Number(h.latest.opened.mean), Number(h.latest.opened.spread)) };
  });
  const total = rows.reduce((a, r) => ({ face: a.face + (Number(r.t.face) || 0), base: a.base + r.b.base, claimed: a.claimed + r.b.claimed }), { face: 0, base: 0, claimed: 0 });
  const flagged = list.filter(isFlagged);

  const exportCsv = () => {
    download(`nema-portfolio-${new Date().toISOString().slice(0, 10)}.csv`, portfolioCsv(list, (h) => termsFor(accountId, h.latest.round.loan, Number(h.latest.opened.mean))));
  };

  return (
    <div className="wrap page portfolio" data-edits={edits}>
      <div className="page-head">
        <div>
          <div className="eyebrow">Portfolio</div>
          <h1>What you can <em>lend against</em></h1>
          {accountId && <p className="mono" style={{ marginTop: 10 }}>{accountId}</p>}
        </div>
        {list.length > 0 && (
          <div className="portfolio-actions no-print">
            <button className="btn ghost small" onClick={exportCsv}>Export CSV</button>
            <button className="btn ghost small" onClick={() => window.print()}>Print or save as PDF</button>
          </div>
        )}
      </div>

      {!accountId ? (
        <Empty title="Connect the wallet you read with" action={<button className="btn" onClick={signIn}>Connect wallet</button>}>
          Every loan you've opened a consensus for, with its borrowing base and how its price moved, worked out on this device.
        </Empty>
      ) : link === "loading" || purchases === undefined ? (
        <Skeleton h={240} />
      ) : list.length === 0 ? (
        <Empty title="No results opened yet" action={<Link className="btn" to="/rounds">See rounds</Link>}>
          {waiting > 0
            ? "You have reads that are still sealing or sealed to a key this browser doesn't hold. Restore your key backup from the Vault to open them."
            : "Buy a read of a published round and it shows up here, grouped by loan."}
        </Empty>
      ) : (
        <>
          <section className="grid3 portfolio-stats">
            <div className="card">
              <div className="label">Borrowing base</div>
              <div className="serif big">{usd(total.base)}</div>
              <p className="hint">across {list.length} {list.length === 1 ? "loan" : "loans"}, {usd(total.face)} face</p>
            </div>
            <div className="card">
              <div className="label">Held back by the consensus</div>
              <div className="serif big">{usd(Math.max(0, total.claimed - total.base))}</div>
              <p className="hint">what the funds' own prices would have lent on top</p>
            </div>
            <div className="card">
              <div className="label">Price falls</div>
              <div className="serif big">{flagged.length}</div>
              <p className="hint">{flagged.length ? flagged.map((h) => h.loan.borrower).join(", ") : "none since the last round"}</p>
            </div>
          </section>

          <section className="holdings">
            {rows.map(({ h }) => (
              <HoldingRow key={h.key} h={h} onEdit={() => setEdits((n) => n + 1)} />
            ))}
          </section>
          <p className="hint" style={{ marginTop: 16 }}>
            Price used is the lower of the fund's own price and the consensus less one spread. Faces, prices and rates stay on this device.
            {waiting > 0 && ` ${waiting} more ${waiting === 1 ? "read is" : "reads are"} not open here yet; see the Vault.`}
          </p>
        </>
      )}
    </div>
  );
}

function isFlagged(h: Holding): boolean {
  if (h.change === null || h.change >= 0) return false;
  return -h.change >= DROP_FLAG || -h.change > Number(h.latest.opened.spread);
}

function HoldingRow({ h, onEdit }: { h: Holding; onEdit: () => void }) {
  const id = useId();
  const { accountId } = useAccount();
  const mean = Number(h.latest.opened.mean);
  const spread = Number(h.latest.opened.spread);
  const [terms, setTerms] = useTerms(accountId, h.latest.round.loan, mean);
  const b = borrowingBase(terms, mean, spread);
  const set = (k: "face" | "own" | "rate") => (e: ChangeEvent<HTMLInputElement>) => {
    setTerms({ ...terms, [k]: k === "face" ? e.target.value.replace(/[^\d]/g, "") : e.target.value });
    onEdit();
  };
  const fell = isFlagged(h);

  return (
    <article className={`card holding${fell ? " fell" : ""}`}>
      <header>
        <div>
          <Link className="plain" to={`/rounds/${h.latest.round.id}?view=lender`}>
            <h3>{h.loan.borrower} <em>{h.loan.facility}</em></h3>
          </Link>
          <p className="hint">
            Round {h.latest.round.id.padStart(2, "0")} · closed {date(h.latest.round.closes_at)} · {h.rounds} {h.rounds === 1 ? "round" : "rounds"} read
          </p>
        </div>
        {fell && <span className="pill tone-bad">Price fell</span>}
      </header>
      <dl className="holding-figs">
        <div>
          <dt>Consensus</dt>
          <dd className="serif">{h.latest.opened.mean}<small>± {spread.toFixed(2)} · {h.latest.opened.count} funds</small></dd>
        </div>
        <div>
          <dt>Since last read</dt>
          <dd className={`serif ${h.change === null ? "" : h.change < 0 ? "down" : "up"}`}>
            {h.change === null ? "—" : h.change === 0 ? "0.00" : `${h.change > 0 ? "▲ +" : "▼ "}${Math.abs(h.change).toFixed(2)}`}
            <small>{h.previous ? `from round ${h.previous.round.id.padStart(2, "0")}` : "first read"}</small>
          </dd>
        </div>
        <div>
          <dt>Price used</dt>
          <dd className="serif">{b.price.toFixed(2)}<small>{b.usesConsensus ? "consensus less one spread" : "the fund's own price"}</small></dd>
        </div>
        <div>
          <dt>Borrowing base</dt>
          <dd className="serif">{usd(b.base)}<small>at a {terms.rate}% advance rate</small></dd>
        </div>
      </dl>
      <div className="holding-in no-print">
        <label htmlFor={`${id}f`}>Face held (USD)<input id={`${id}f`} inputMode="numeric" value={terms.face} onChange={set("face")} /></label>
        <label htmlFor={`${id}o`}>Fund's own price<input id={`${id}o`} inputMode="decimal" value={terms.own} onChange={set("own")} /></label>
        <label htmlFor={`${id}r`}>Advance rate %<input id={`${id}r`} inputMode="decimal" value={terms.rate} onChange={set("rate")} /></label>
      </div>
      <p className="print-only hint">Face {usd(Number(terms.face) || 0)} · fund price {terms.own} · advance rate {terms.rate}%</p>
    </article>
  );
}
