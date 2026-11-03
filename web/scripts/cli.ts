// Shared by the live scripts: signed calls go through NEAR CLI with keys from the
// OS keychain (the scripts never see a private key); views go straight to RPC.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG } from "../src/lib/config";
import { view } from "../src/lib/near";
import type { Round } from "../src/lib/types";

export { view };

const YOCTO = 10n ** 24n;

/** yoctoNEAR as the decimal NEAR string NEAR CLI expects. */
export function nearString(yocto: bigint): string {
  const whole = yocto / YOCTO;
  const frac = (yocto % YOCTO).toString().padStart(24, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} NEAR`;
}

/**
 * How to run NEAR CLI (near-cli-rs): `NEAR_CLI` if set, else `near` on PATH. On
 * Windows npm installs `near.cmd`, which Node can't run without a shell (and a
 * shell would mangle the JSON arguments), so run its JavaScript entry directly.
 */
function nearCli(): [string, string[]] {
  if (process.env.NEAR_CLI) return [process.env.NEAR_CLI, []];
  if (process.platform !== "win32") return ["near", []];
  let cmd = "";
  try {
    cmd = execFileSync("where", ["near.cmd"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
  } catch {
    // not on PATH
  }
  const entry = cmd && join(dirname(cmd), "node_modules", "near-cli-rs", "run-near.js");
  if (!entry || !existsSync(entry)) {
    throw new Error("NEAR CLI not found. Install it with `npm i -g near-cli-rs`, or set NEAR_CLI to its path.");
  }
  return [process.execPath, [entry]];
}

let cli: [string, string[]] | undefined;

/** Signs `method` as `signer` with NEAR CLI and waits for the transaction. */
export function call(signer: string, method: string, args: object, deposit = 0n, tgas = 30): void {
  cli ??= nearCli();
  const [bin, pre] = cli;
  const r = spawnSync(
    bin,
    [
      ...pre,
      "contract", "call-function", "as-transaction", CONFIG.contract, method,
      "json-args", JSON.stringify(args),
      "prepaid-gas", `${tgas} Tgas`,
      "attached-deposit", nearString(deposit),
      "sign-as", signer,
      "network-config", CONFIG.network,
      "sign-with-keychain", "send",
    ],
    { encoding: "utf8", timeout: 180_000 },
  );
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  // The exit status is the signal; the text check catches a transaction that
  // landed but whose function call failed, which the CLI reports as an outcome.
  if (r.error || r.status !== 0 || /FunctionCallError|ActionError|Smart contract panicked/.test(out)) {
    throw new Error(`${method} as ${signer} failed:\n${(r.error?.message ?? "") + out.slice(-800)}`);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `get` until `done` holds, or throws after `ms`. */
export async function until<T>(what: string, get: () => Promise<T>, done: (v: T) => boolean, ms = 300_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5_000);
  }
}

export async function allRounds(): Promise<Round[]> {
  const out: Round[] = [];
  for (let from = 0; ; from += 50) {
    const page = await view<Round[]>("get_rounds", { from_index: from, limit: 50 });
    out.push(...page);
    if (page.length < 50) return out;
  }
}

/** `--name value` from argv, or the fallback. */
export function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
