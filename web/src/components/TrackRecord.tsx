import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { recordStats, type RecordPoint } from "../lib/record";
import { LoanTitle } from "./bits";
import "./TrackRecord.css";

const OUTCOME = { counted: "counted", dropped: "dropped", failed: "round failed", waiting: "not tallied yet" };

const sigma = (z: number) => `${z >= 0 ? "+" : "−"}${Math.abs(z).toFixed(2)}σ`;
const points = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`;

/** How a fund's marks sat against the consensus, round after round. */
export function TrackRecord({ points: list, who, table = false, empty }: { points: RecordPoint[]; who: string; table?: boolean; empty: ReactNode }) {
  const s = recordStats(list);
  const compared = list.filter((p) => p.z !== undefined);

  return (
    <div className="record">
      <dl className="record-figs">
        <div>
          <dt>Rounds marked</dt>
          <dd className="serif">{s.marked}</dd>
          <small>{s.counted} counted{s.dropped ? ` · ${s.dropped} dropped` : ""}</small>
        </div>
        <div>
          <dt>Within one spread</dt>
          <dd className="serif">{s.compared ? `${s.withinOne} of ${s.compared}` : "—"}</dd>
          <small>of the rounds compared here</small>
        </div>
        <div>
          <dt>Average gap</dt>
          <dd className="serif">{s.avgGap === null ? "—" : `${s.avgGap.toFixed(2)}σ`}</dd>
          <small>distance from the mean</small>
        </div>
        <div>
          <dt>Lean</dt>
          <dd className="serif">{s.lean === null ? "—" : points(s.lean)}</dd>
          <small>{s.lean === null ? "no rounds compared" : `points ${s.lean < 0 ? "below" : "above"} the panel, on average`}</small>
        </div>
      </dl>

      {compared.length > 0 ? <GapChart points={compared} who={who} /> : <p className="hint record-empty">{empty}</p>}

      {table && (
        <div className="record-table" role="table" aria-label={`${who} round by round`}>
          <div className="record-row head" role="row">
            <span role="columnheader">Round</span>
            <span role="columnheader">Mark</span>
            <span role="columnheader">Consensus</span>
            <span role="columnheader">Gap</span>
          </div>
          {[...list].reverse().map((p) => (
            <Link className="record-row" role="row" key={p.round.id} to={`/rounds/${p.round.id}`}>
              <span role="cell">
                <LoanTitle round={p.round} />
                <small className="hint">R{p.round.id.padStart(2, "0")} · {p.reason ? `dropped: ${p.reason}` : OUTCOME[p.outcome]}</small>
              </span>
              <span role="cell" className="serif">{p.mark?.toFixed(2) ?? <small className="hint">not kept</small>}</span>
              <span role="cell" className="serif">{p.mean !== undefined ? `${p.mean.toFixed(2)} ± ${p.spread!.toFixed(2)}` : <small className="hint">{p.outcome === "counted" ? "not opened" : "—"}</small>}</span>
              <span role="cell" className={`serif ${p.z === undefined ? "" : Math.abs(p.z) <= 1 ? "in" : "out"}`}>{p.z !== undefined ? sigma(p.z) : "—"}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/** Each mark's distance from the mean, in spreads, with the one-spread band shaded. */
function GapChart({ points, who }: { points: RecordPoint[]; who: string }) {
  // Drawn at the card's own width, so labels and dots keep their size on a phone.
  const box = useRef<HTMLElement>(null);
  const [W, setW] = useState(640);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(240, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 130;
  const PAD = 20;
  const lim = Math.max(2, Math.ceil(Math.max(...points.map((p) => Math.abs(p.z!)))));
  const x = (i: number) => PAD + (points.length === 1 ? (W - 2 * PAD) / 2 : (i / (points.length - 1)) * (W - 2 * PAD));
  const y = (z: number) => PAD + (1 - (z + lim) / (2 * lim)) * (H - 2 * PAD - 10);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.z!)}`).join("");

  return (
    <figure className="record-chart" ref={box}>
      <figcaption>
        <span className="label">Distance from the consensus</span>
        <span className="hint">shaded band is one spread either side of the mean</span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${who}: ${points.map((p) => `round ${p.round.id} ${sigma(p.z!)}`).join(", ")}`}
      >
        <rect x={0} y={y(1)} width={W} height={y(-1) - y(1)} className="band" />
        <line x1={0} x2={W} y1={y(0)} y2={y(0)} className="zero" />
        <text x={2} y={y(1) - 3} className="axis">+1σ</text>
        <text x={2} y={y(-1) + 10} className="axis">−1σ</text>
        <path d={line} className="line" />
        {points.map((p, i) => (
          <g key={p.round.id}>
            <circle cx={x(i)} cy={y(p.z!)} r={3.5} className={Math.abs(p.z!) <= 1 ? "dot" : "dot out"} />
            <text x={x(i)} y={H - 1} textAnchor="middle">R{p.round.id.padStart(2, "0")}</text>
          </g>
        ))}
      </svg>
    </figure>
  );
}
