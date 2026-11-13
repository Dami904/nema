// Shared by the live scripts: signed calls go through NEAR CLI with keys from the
// OS keychain (the scripts never see a private key); views go straight to RPC.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG } from "../src/lib/config";
import { view } from "../src/lib/near";
import type { Application, Config, Proposal, ProposalKind, RegisteredLoan, Round } from "../src/lib/types";

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

/** Signs `method` on the Nema contract (or `contract`) as `signer` with NEAR CLI and waits for the transaction. */
export function call(signer: string, method: string, args: object, deposit = 0n, tgas = 30, contract = CONFIG.contract): void {
  cli ??= nearCli();
  const [bin, pre] = cli;
  const r = spawnSync(
    bin,
    [
      ...pre,
      "contract", "call-function", "as-transaction", contract, method,
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

/**
 * The accounts the live scripts sign as. Names come from here, not from the
 * contract's own name, so a new contract can reuse the same funded accounts.
 */
export const BASE = process.env.NEMA_ACCOUNTS ?? "nema-dev.testnet";
export const FUNDS = [1, 2, 3, 4].map((n) => `fund${n}.${BASE}`);
export const LENDER = `lender.${BASE}`;
/** Council seats the scripts hold keys for. Another seat may be a wallet the scripts can't sign for. */
export const COUNCIL_SIGNERS = (process.env.NEMA_COUNCIL ?? `${BASE},${LENDER}`).split(",");

const APPLICATION_BOND = 5n * 10n ** 22n;

/** Puts `kind` to the council and votes it through with the seats the scripts hold. */
export async function decide(kind: ProposalKind): Promise<void> {
  const { threshold } = await view<Config>("get_config");
  if (COUNCIL_SIGNERS.length < threshold) throw new Error(`the scripts hold ${COUNCIL_SIGNERS.length} council seats; ${threshold} votes are needed`);
  const before = new Set((await view<Proposal[]>("get_proposals")).map((p) => p.id));
  call(COUNCIL_SIGNERS[0], "propose", { kind }, 0n, 60);
  const made = (await view<Proposal[]>("get_proposals")).find((p) => !before.has(p.id));
  if (!made) return; // it passed on the proposal itself
  for (const signer of COUNCIL_SIGNERS.slice(1, threshold)) call(signer, "vote", { proposal_id: made.id }, 0n, 60);
}

/** The id of a registered loan with this label, registering it by council vote if needed. */
export async function registerLoan(label: string): Promise<string> {
  const find = async () => (await view<RegisteredLoan[]>("get_loans")).find((l) => l.label === label);
  const have = await find();
  if (have) return have.id;
  await decide({ RegisterLoan: label });
  const made = await find();
  if (!made) throw new Error("the loan was not registered");
  return made.id;
}

/** Council approvals up to the threshold, then (after the veto window) the admission itself. */
export async function approveAndAdmit(account: string): Promise<void> {
  const config = await view<Config>("get_config");
  const application = async () => (await view<Application[]>("get_applications")).find((a) => a.account === account);
  const first = await application();
  if (!first) throw new Error(`${account} has not applied`);
  // Safe to re-run: seats that already approved are skipped, and so is a ready admission.
  if (!first.ready_at) {
    const live = first.approvals.filter((a) => config.council.includes(a)).length;
    const todo = COUNCIL_SIGNERS.filter((s) => !first.approvals.includes(s)).slice(0, Math.max(0, config.threshold - live));
    for (const signer of todo) call(signer, "approve", { account }, 0n, 60);
  }
  const app = await application();
  if (!app?.ready_at) throw new Error(`${account} is not ready to admit`);
  const readyMs = Number(BigInt(app.ready_at) / 1_000_000n);
  const wait = readyMs - Date.now() + 2_000;
  if (wait > 0) {
    console.log(`  …   veto window: waiting ${Math.ceil(wait / 1000)}s`);
    await sleep(wait);
  }
  call(BASE, "finalize_admission", { account }, 0n, 60);
}

/** A fund applies (with its bond) and the council admits it. */
export async function applyAndAdmit(account: string): Promise<void> {
  call(account, "apply", { auditor: null, note: null }, APPLICATION_BOND, 30);
  await approveAndAdmit(account);
}
