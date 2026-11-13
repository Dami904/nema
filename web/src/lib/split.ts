/**
 * How the contract pays out a read fee (`credit_contributors`): the council's
 * share first, equal among its seats, then equal shares to the funds whose marks
 * counted. Whatever does not divide goes to the first council seat.
 */
export type ReadSplit = {
  /** Paid to each council seat. */
  perSeat: bigint;
  /** Paid to each fund whose mark counted. */
  perFund: bigint;
  /** What does not divide; it goes to the first council seat. */
  remainder: bigint;
};

export function splitRead(amount: bigint, contributors: number, councilSeats: number, shareBps: number): ReadSplit {
  if (contributors === 0 || amount === 0n) return { perSeat: 0n, perFund: 0n, remainder: 0n };
  const bps = BigInt(shareBps);
  // amount * bps / 10_000, computed the way the contract does so the rounding matches.
  const cut = (amount / 10_000n) * bps + ((amount % 10_000n) * bps) / 10_000n;
  const seats = BigInt(councilSeats);
  const perSeat = seats > 0n ? cut / seats : 0n;
  const pool = amount - perSeat * seats;
  const perFund = pool / BigInt(contributors);
  return { perSeat, perFund, remainder: pool - perFund * BigInt(contributors) };
}
