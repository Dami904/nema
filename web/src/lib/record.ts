// A fund's track record: where each of its marks sat against the consensus.
// Only marks someone is entitled to see are used: the fund's own, kept on its
// device, or the ones the enclave opened for its auditor. Worked out in the
// browser; nothing is sent.

import type { ReadState } from "./reads";
import type { Round } from "./types";

export type Outcome = "counted" | "dropped" | "failed" | "waiting";

export type RecordPoint = {
  round: Round;
  outcome: Outcome;
  /** Why the enclave left the mark out, when it did. */
  reason?: string;
  /** In points of par, when known. */
  mark?: number;
  mean?: number;
  spread?: number;
  /** Mark less the mean, in spreads. */
  z?: number;
};

export type RecordStats = {
  marked: number;
  counted: number;
  dropped: number;
  /** Rounds where both the mark and the consensus are known here. */
  compared: number;
  withinOne: number;
  /** Average distance from the mean, in spreads. */
  avgGap: number | null;
  /** Average of mark less mean, in points: below zero marks under the panel. */
  lean: number | null;
};

/** Every round `fund` marked, oldest deadline first. `markOf` returns points of par. */
export function recordPoints(fund: string, rounds: Round[], markOf: (roundId: string) => number | undefined, reads: Record<string, ReadState>): RecordPoint[] {
  return rounds
    .filter((r) => r.submitted.includes(fund))
    .sort((a, b) => (BigInt(a.closes_at) < BigInt(b.closes_at) ? -1 : 1))
    .map((round) => {
      const rejected = round.listing?.rejected.find((x) => x.account === fund);
      const outcome: Outcome = round.listing
        ? round.listing.contributors.includes(fund)
          ? "counted"
          : "dropped"
        : round.status === "Failed"
          ? "failed"
          : "waiting";
      const read = reads[round.id];
      const mark = markOf(round.id);
      const mean = read?.kind === "opened" ? Number(read.opened.mean) : undefined;
      const spread = read?.kind === "opened" ? Number(read.opened.spread) : undefined;
      const z = mark !== undefined && mean !== undefined && spread ? (mark - mean) / spread : undefined;
      return { round, outcome, reason: rejected?.reason, mark, mean, spread, z };
    });
}

export function recordStats(points: RecordPoint[]): RecordStats {
  const compared = points.filter((p) => p.z !== undefined && p.mark !== undefined && p.mean !== undefined);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    marked: points.length,
    counted: points.filter((p) => p.outcome === "counted").length,
    dropped: points.filter((p) => p.outcome === "dropped").length,
    compared: compared.length,
    withinOne: compared.filter((p) => Math.abs(p.z!) <= 1).length,
    avgGap: avg(compared.map((p) => Math.abs(p.z!))),
    lean: avg(compared.map((p) => p.mark! - p.mean!)),
  };
}
