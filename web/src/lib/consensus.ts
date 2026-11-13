/**
 * The enclave's rounded consensus (aggregator/src/stats.rs, `Method::Rounded`), in
 * the same integer arithmetic, so a script that knows the marks can predict the
 * exact strings the enclave commits to. Marks are hundredths of a point.
 */

/** Marks dropped from each end before averaging: none at 4, one at 5 to 8, two at 9 to 12. */
export const trimEachEnd = (n: number) => Math.floor(Math.max(n - 1, 0) / 4);

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

const fixed = (v: bigint, d: number) => `${v / 10n ** BigInt(d)}.${(v % 10n ** BigInt(d)).toString().padStart(d, "0")}`;

export function roundedConsensus(marks: number[]): { count: number; mean: string; spread: string } {
  const all = marks.map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = BigInt(all.length);
  const sum = all.reduce((a, m) => a + m, 0n);
  const sq = all.reduce((a, m) => a + m * m, 0n);
  const k = trimEachEnd(all.length);
  const kept = all.slice(k, all.length - k);
  const m = BigInt(kept.length);
  const keptSum = kept.reduce((a, v) => a + v, 0n);
  const eighths = (16n * keptSum + 100n * m) / (200n * m);
  const quarters = (isqrt(64n * (n * sq - sum * sum)) + 100n * n) / (200n * n);
  return { count: all.length, mean: fixed(eighths * 125n, 3), spread: fixed(quarters * 25n, 2) };
}
