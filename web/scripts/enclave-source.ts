// Switches which host the OutLayer project loads the enclave from. FastFS is
// live; the GitHub release is a standby copy of the same bytes. The secret lock
// checks the wasm hash, not the URL, so the secret works from either.
//
//   pnpm live:enclave-source                  # shows which host is live, checks both
//   pnpm live:enclave-source github           # switch to the GitHub release
//   pnpm live:enclave-source fastfs           # switch back to FastFS
//
// OutLayer keys versions by hash, so a switch is three transactions signed by the
// project owner: activate an older version, remove this one, add it back with
// the other URL and activate it. A round asked for in that minute is refused by
// the secret lock and refunds like any failed run. Each costs gas, and the add
// attaches 0.1 NEAR of storage deposit.

import { createHash } from "node:crypto";
import { BUILDS, ENCLAVE_URLS } from "../src/lib/config";
import { call, view } from "./cli";

const OUTLAYER = "outlayer.testnet";
const [owner, name] = BUILDS.enclaveProject.split("/");
const hash = BUILDS.enclaveWasmSha256;
type Version = { wasm_hash: string; is_active: boolean; source: { WasmUrl?: { url: string } } };

const versions = async () => view<Version[]>("list_versions", { project_id: BUILDS.enclaveProject }, OUTLAYER);
const hostOf = (url = "") => (Object.entries(ENCLAVE_URLS).find(([, u]) => u === url)?.[0] ?? url) || "none";

async function served(url: string): Promise<boolean> {
  const res = await fetch(url);
  return res.ok && createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex") === hash;
}

const current = (await versions()).find((v) => v.wasm_hash === hash);
console.log(`live: ${hostOf(current?.source.WasmUrl?.url)}${current?.is_active ? "" : " (not active)"}`);
for (const [host, url] of Object.entries(ENCLAVE_URLS)) console.log(`  ${host}: ${(await served(url)) ? "serves" : "DOES NOT serve"} ${hash.slice(0, 12)}`);

const to = process.argv[2] as keyof typeof ENCLAVE_URLS | undefined;
if (!to) process.exit(0);
if (!(to in ENCLAVE_URLS)) throw new Error(`pick one of: ${Object.keys(ENCLAVE_URLS).join(", ")}`);
const url = ENCLAVE_URLS[to];
if (current?.is_active && current.source.WasmUrl?.url === url) {
  console.log(`already on ${to}`);
  process.exit(0);
}
if (!(await served(url))) throw new Error(`${to} does not serve the enclave build; not switching`);

if (current) {
  const other = (await versions()).find((v) => v.wasm_hash !== hash);
  if (!other) throw new Error("no other version to hold the project while this one is replaced");
  call(owner, "set_active_version", { project_name: name, version_key: other.wasm_hash }, 0n, 100, OUTLAYER);
  call(owner, "remove_version", { project_name: name, version_key: hash }, 0n, 100, OUTLAYER);
}
call(owner, "add_version", { project_name: name, set_active: true, source: { WasmUrl: { url, hash, build_target: "wasm32-wasip2" } } }, 10n ** 23n, 100, OUTLAYER);

const after = (await versions()).find((v) => v.wasm_hash === hash);
if (!after?.is_active || after.source.WasmUrl?.url !== url) throw new Error("the switch did not take; check list_versions on outlayer.testnet");
console.log(`live: ${to}`);
