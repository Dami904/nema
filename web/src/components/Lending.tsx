import { useId, type ChangeEvent } from "react";
import { useAccount } from "../lib/account";
import { borrowingBase, useTerms, type Terms } from "../lib/valuation";
import "./Lending.css";

export type HistoryPoint = { id: string; mean: number; spread: number };

/** A loan's consensus round after round: the mean, with its one-spread band. */
export function PriceHistory({ points, current }: { points: HistoryPoint[]; current: string }) {
  const W = 320;
  const H = 96;
  const PAD = 14;
  const lo = Math.min(...points.map((p) => p.mean - p.spread));
  const hi = Math.max(...points.map((p) => p.mean + p.spread));
  const span = hi - lo || 1;
  const x = (i: number) => PAD + (points.length === 1 ? (W - 2 * PAD) / 2 : (i / (points.length - 1)) * (W - 2 * PAD));
  const y = (v: number) => PAD + (1 - (v - lo) / span) * (H - 2 * PAD);
  const top = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.mean + p.spread)}`).join("");
  const bottom = [...points].reverse().map((p, j) => `L${x(points.length - 1 - j)},${y(p.mean - p.spread)}`).join("");
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.mean)}`).join("");
  const first = points[0];
  const last = points[points.length - 1];
  const move = last.mean - first.mean;

  return (
    <figure className="history">
      <figcaption>
        <span className="label">This loan, round by round</span>
        <span className="hint">
          {points.length} rounds · {move === 0 ? "unchanged" : `${move > 0 ? "▲ +" : "▼ "}${Math.abs(move).toFixed(2)}`} since round {first.id.padStart(2, "0")}
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Consensus over ${points.length} rounds, from ${first.mean.toFixed(2)} to ${last.mean.toFixed(2)}`}>
        <path d={`${top}${bottom}Z`} className="band" />
        <path d={line} className="line" />
        {points.map((p, i) => (
          <g key={p.id}>
            <circle cx={x(i)} cy={y(p.mean)} r={p.id === current ? 4.5 : 3} className={p.id === current ? "now" : "dot"} />
            <text x={x(i)} y={H - 1} textAnchor="middle">R{p.id.padStart(2, "0")}</text>
          </g>
        ))}
      </svg>
    </figure>
  );
}

export const usd = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/**
 * What a lender would advance against this loan: the face held times the
 * advance rate, at the lower of the fund's own price and the consensus less one
 * spread. Worked out in the browser and kept on this device; nothing is sent.
 */
export function BorrowingBase({ mean, spread, loan }: { mean: number; spread: number; loan: string }) {
  const id = useId();
  const { accountId } = useAccount();
  const [terms, setTerms] = useTerms(accountId, loan, mean);
  const { price, usesConsensus, base, claimed } = borrowingBase(terms, mean, spread);
  const set = (k: keyof Terms) => (e: ChangeEvent<HTMLInputElement>) =>
    setTerms({ ...terms, [k]: k === "face" ? e.target.value.replace(/[^\d]/g, "") : e.target.value });

  return (
    <details className="bbase">
      <summary>
        <span>
          <span className="label">Borrowing base</span>
          <span className="hint">What this price lets you lend against the loan</span>
        </span>
        <span aria-hidden="true">+</span>
      </summary>
      <div className="bbase-in">
        <label htmlFor={`${id}f`}>Face held (USD)<input id={`${id}f`} inputMode="numeric" value={terms.face} onChange={set("face")} /></label>
        <label htmlFor={`${id}o`}>Fund's own price<input id={`${id}o`} inputMode="decimal" value={terms.own} onChange={set("own")} /></label>
        <label htmlFor={`${id}r`}>Advance rate %<input id={`${id}r`} inputMode="decimal" value={terms.rate} onChange={set("rate")} /></label>
      </div>
      <dl className="bbase-out">
        <div>
          <dt>Price used</dt>
          <dd>{price.toFixed(2)}<small>{usesConsensus ? "consensus less one spread" : "the fund's own price"}</small></dd>
        </div>
        <div>
          <dt>Borrowing base</dt>
          <dd>{usd(base)}</dd>
        </div>
        <div>
          <dt>On the fund's price alone</dt>
          <dd className="muted">{usd(claimed)}</dd>
        </div>
      </dl>
      <p className="hint">
        {claimed > base
          ? `The independent price holds back ${usd(claimed - base)} that the fund's own price would have lent.`
          : "The fund's own price sits at or below the consensus, so it stands."}{" "}
        Worked out on this page and kept on this device; nothing is sent.
      </p>
    </details>
  );
}
