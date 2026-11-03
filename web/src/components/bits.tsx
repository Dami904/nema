import type { ReactNode } from "react";
import { useNow } from "../lib/chain";
import { nsToMs, until } from "../lib/format";
import { parseLoan } from "../lib/loan";
import type { Round, RoundStatus } from "../lib/types";

const STATUS: Record<RoundStatus, { label: string; tone: string }> = {
  AwaitingKey: { label: "Preparing key", tone: "tone-busy" },
  Open: { label: "Open", tone: "tone-open" },
  Closing: { label: "Tallying", tone: "tone-busy" },
  CloseFailed: { label: "Close failed", tone: "tone-bad" },
  Published: { label: "Published", tone: "tone-pub" },
  Failed: { label: "Did not publish", tone: "tone-bad" },
};

export function StatusPill({ status, extra }: { status: RoundStatus; extra?: string }) {
  const s = STATUS[status];
  return (
    <span className={`pill ${s.tone}`}>
      <span className="d" aria-hidden="true" />
      {s.label}
      {extra ? ` · ${extra}` : ""}
    </span>
  );
}

/** Time left until a round's deadline, or "deadline passed". */
export function Countdown({ closesAt }: { closesAt: string }) {
  const now = useNow();
  const ms = nsToMs(closesAt);
  return <>{ms > now ? `closes in ${until(ms, now)}` : "deadline passed"}</>;
}

export function LoanTitle({ round, as = "h3" }: { round: Round; as?: "h1" | "h3" }) {
  const loan = parseLoan(round.loan);
  const Tag = as;
  return (
    <Tag>
      {loan.borrower} {loan.facility && <em>{loan.facility}</em>}
    </Tag>
  );
}

export function loanMeta(round: Round): string {
  const loan = parseLoan(round.loan);
  return loan.maturity ? `matures ${new Date(loan.maturity).toLocaleDateString(undefined, { month: "short", year: "numeric" })}` : "";
}

/** Submissions so far against the floor needed to publish. */
export function Ring({ value, floor, size = 132 }: { value: number; floor: number; size?: number }) {
  const r = 50;
  const c = 2 * Math.PI * r;
  const frac = Math.min(1, value / Math.max(1, floor));
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" role="img" aria-label={`${value} of ${floor} funds`}>
      <circle cx="60" cy="60" r={r} fill="none" stroke="#e7e2d8" strokeWidth="9" />
      <circle cx="60" cy="60" r={r} fill="none" stroke={frac >= 1 ? "#6e8f7e" : "#b5764f"} strokeWidth="9" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - frac)} transform="rotate(-90 60 60)" style={{ transition: "stroke-dashoffset .8s ease" }} />
      <text x="60" y="60" textAnchor="middle" fontFamily="Inter" fontWeight="600" fontSize="30" fill="#1c2420">{value}</text>
      <text x="60" y="80" textAnchor="middle" fontFamily="Inter" fontSize="10" fill="#8a918b">of {floor} needed</text>
    </svg>
  );
}

/** Mean and ± spread on a price scale, in points of par. */
export function Gauge({ mean, spread, own }: { mean: number; spread: number; own?: number }) {
  const lo = Math.floor(Math.min(mean - 3 * spread, own ?? Infinity) - 1);
  const hi = Math.ceil(Math.max(mean + 3 * spread, own ?? -Infinity) + 1);
  const x = (v: number) => ((v - lo) / (hi - lo)) * 100;
  return (
    <div style={{ margin: "18px 0 6px" }}>
      <svg viewBox="0 0 100 18" preserveAspectRatio="none" style={{ width: "100%", height: 34 }} aria-hidden="true">
        <rect x="0" y="8" width="100" height="2" rx="1" fill="#e4ded3" />
        <rect x={x(mean - spread)} y="5" width={x(mean + spread) - x(mean - spread)} height="8" rx="4" fill="#dce5df" />
        <rect x={x(mean) - 0.4} y="2" width="0.8" height="14" fill="#1e2b25" />
        {own !== undefined && <circle cx={x(own)} cy="9" r="2.2" fill="#b5764f" />}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between" }} className="label">
        <span>{lo}</span>
        <span>{hi}</span>
      </div>
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty fadein">
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function Skeleton({ h = 20, w = "100%" }: { h?: number; w?: number | string }) {
  return <div className="skeleton" style={{ height: h, width: w }} />;
}

/** Soft layered hills, the app's one illustration. */
export function Hills({ children }: { children?: ReactNode }) {
  return (
    <div style={{ borderRadius: 28, overflow: "hidden", position: "relative", background: "#e7edea", aspectRatio: "4 / 4.3" }}>
      <svg viewBox="0 0 400 430" preserveAspectRatio="xMidYMid slice" style={{ display: "block", width: "100%", height: "100%" }} aria-hidden="true">
        <circle cx="300" cy="110" r="46" fill="#f6f1e6" />
        <path d="M0 210 Q70 150 140 190 T280 170 T400 185 V430 H0Z" fill="#cfdcd5" />
        <path d="M0 255 Q90 205 170 240 T330 225 T400 235 V430 H0Z" fill="#afc4b8" />
        <path d="M0 300 Q80 265 160 292 T320 280 T400 290 V430 H0Z" fill="#8aa898" />
        <path d="M0 350 Q100 318 200 342 T400 336 V430 H0Z" fill="#5f7f6f" />
        <path d="M0 395 Q120 372 230 390 T400 384 V430 H0Z" fill="#3f5a4c" />
      </svg>
      {children}
    </div>
  );
}
