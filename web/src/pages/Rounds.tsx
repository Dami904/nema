import { useState } from "react";
import { Link } from "react-router-dom";
import { Countdown, Empty, LoanTitle, Skeleton, StatusPill, loanMeta } from "../components/bits";
import { useChain } from "../lib/chain";
import type { Round } from "../lib/types";
import "./Rounds.css";

const FILTERS = [
  { key: "all", label: "All", match: () => true },
  { key: "open", label: "Open", match: (r: Round) => r.status === "Open" || r.status === "AwaitingKey" },
  { key: "published", label: "Published", match: (r: Round) => r.status === "Published" },
  { key: "other", label: "Other", match: (r: Round) => ["Closing", "CloseFailed", "Failed"].includes(r.status) },
] as const;

export default function Rounds() {
  const { rounds, link, config, setDemoMode, demoMode } = useChain();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const shown = rounds.filter(FILTERS.find((f) => f.key === filter)!.match);
  const floor = config?.min_contributors ?? 4;

  return (
    <div className="wrap page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Rounds</div>
          <h1>What's being <em>priced</em></h1>
        </div>
        <div className="seg" role="group" aria-label="Filter rounds">
          {FILTERS.map((f) => (
            <button key={f.key} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</button>
          ))}
        </div>
      </div>

      {link === "loading" ? (
        <div className="rows">
          {[0, 1, 2].map((i) => (
            <div className="row" key={i}><Skeleton h={28} /></div>
          ))}
        </div>
      ) : rounds.length === 0 ? (
        <Empty
          title="No rounds yet"
          action={!demoMode && <button className="btn ghost" onClick={() => setDemoMode(true)}>See it with sample data</button>}
        >
          A panel fund or a council member opens a round for each registered loan. It will appear here with a countdown to its deadline.
        </Empty>
      ) : shown.length === 0 ? (
        <Empty title="Nothing here">No rounds match this filter.</Empty>
      ) : (
        <div className="rows">
          {shown.map((r, i) => (
            <Link to={`/rounds/${r.id}`} className="row fadein" key={r.id} style={{ animationDelay: `${i * 50}ms` }}>
              <span className="i">{String(r.id).padStart(2, "0")}</span>
              <span className="t">
                <LoanTitle round={r} />
                <span className="meta">{loanMeta(r)}</span>
              </span>
              <span className="lead" aria-hidden="true" />
              <span className="meta right">
                {r.status === "Open" ? <Countdown closesAt={r.closes_at} /> : r.listing ? `${r.listing.count} funds counted` : `${r.submitted.length} submitted`}
              </span>
              <StatusPill status={r.status} extra={r.status === "Open" ? `${r.submitted.length} of ${floor}` : undefined} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
