const YOCTO = 10n ** 24n;

/** Formats yoctoNEAR as NEAR with up to 4 decimals, trimming zeros. */
export function near(yocto: string | bigint): string {
  const y = typeof yocto === "bigint" ? yocto : BigInt(yocto);
  const whole = y / YOCTO;
  const frac = ((y % YOCTO) * 10_000n) / YOCTO;
  const f = frac.toString().padStart(4, "0").replace(/0+$/, "");
  return `${whole}${f ? "." + f : ""} NEAR`;
}

export const nsToMs = (ns: string) => Number(BigInt(ns) / 1_000_000n);

export function date(ns: string): string {
  return new Date(nsToMs(ns)).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function until(ms: number, now = Date.now()): string {
  let s = Math.max(0, Math.floor((ms - now) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

export const short = (hex: string | null | undefined, n = 4) => (hex ? `${hex.slice(0, n)}…${hex.slice(-n)}` : "—");

/** Shows the account's first label, e.g. "fund1" for fund1.nema-dev.testnet. */
export const handle = (account: string) => account.split(".")[0];
