// Checks an OutLayer enclave run in the browser: the Intel TDX quote, what it
// vouches for, which worker image and which code ran, and that the run is the one
// the Nema contract asked for. Nothing here trusts OutLayer's API: it only fetches
// the quote and the fields the quote commits to, and every check is recomputed.
//
// What it does not do: check Intel's TCB status or revocation lists for the
// platform (OutLayer's dashboard does, from archived collateral). The panel says so.

import { CONFIG } from "./config";
import { sha256Hex, toHex } from "./hashes";

export type Net = { api: string; rpc: string; register: string; dashboard: string; network: string };

export function netFor(network: string): Net {
  const main = network === "mainnet";
  return {
    api: main ? "https://api.outlayer.ai" : "https://testnet-api.outlayer.ai",
    rpc: main ? "https://rpc.mainnet.fastnear.com" : CONFIG.rpc,
    register: main ? "worker.outlayer.near" : "worker.outlayer.testnet",
    dashboard: "https://app.outlayer.ai/attestation/",
    network,
  };
}

export const NET = netFor(CONFIG.network);

/** One run as OutLayer's public API lists it. */
export type Job = {
  job_id: number;
  request_id: number | null;
  user_account_id: string | null;
  project_id: string | null;
  job_type: string;
  status: string;
  transaction_hash: string | null;
  created_at: string;
};

/** OutLayer's attestation for one run: the quote plus every field its task hash covers. */
export type Attestation = {
  task_id: number;
  task_type: string;
  tdx_quote: string;
  worker_measurement: string | null;
  request_id: number | null;
  caller_account_id: string | null;
  transaction_hash: string | null;
  block_height: number | null;
  repo_url?: string | null;
  commit_hash?: string | null;
  build_target: string | null;
  wasm_hash: string | null;
  input_hash: string | null;
  output_hash: string;
  project_id: string | null;
  secrets_ref: string | null;
  attached_usd: string | null;
  timestamp: number;
};

/** `ok: null` means the check couldn't be made, which is not the same as failing. */
export type Check = { id: string; label: string; ok: boolean | null; detail: string };

/** The Intel SGX Root CA public key (uncompressed P-256 point), pinned. It is the
 * same key Intel's provisioning service returns in its issuer chains. */
export const INTEL_ROOT_KEY =
  "040ba9c4c0c0c86193a3fe23d6b02cda10a8bbd4e88e48b4458561a36e705525f567918e2edc88e40d860bd0cc4ee26aacc988e505a953558c453f6b0904ae7394";

// ---- fetching ----

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

export const jobsOf = (account: string, net = NET) =>
  getJson<Job[]>(`${net.api}/public/jobs?limit=50&offset=0&source=near&user_account_id=${encodeURIComponent(account)}`);

export const attestationOf = (jobId: number, net = NET) => getJson<Attestation>(`${net.api}/attestations/${jobId}`);

async function rpc<T>(net: Net, method: string, params: unknown): Promise<T> {
  const res = await fetch(net.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "nema", method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.data ?? body.error.message ?? "RPC error");
  return body.result as T;
}

async function viewOn<T>(net: Net, account: string, method: string, args: object): Promise<T> {
  const r = await rpc<{ result: number[] }>(net, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: account,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result)));
}

/** What the transaction that started a run asked OutLayer to do. */
export type Requested = {
  /** The account that called OutLayer: the Nema contract, for Nema's runs. */
  predecessor: string;
  input: string;
  /** Every receipt's return value in the transaction, decoded as text. */
  returns: string[];
};

type TxStatus = {
  receipts_outcome: { outcome: { logs: string[]; status: { SuccessValue?: string } } }[];
};

export async function requestOf(att: Attestation, net = NET): Promise<Requested | null> {
  if (!att.transaction_hash || !att.caller_account_id) return null;
  const tx = await rpc<TxStatus>(net, "EXPERIMENTAL_tx_status", {
    tx_hash: att.transaction_hash,
    sender_account_id: att.caller_account_id,
    wait_until: "FINAL",
  });
  let found: Requested | null = null;
  const returns: string[] = [];
  for (const { outcome } of tx.receipts_outcome) {
    if (outcome.status.SuccessValue) returns.push(new TextDecoder().decode(b64(outcome.status.SuccessValue)));
    for (const log of outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      const ev = JSON.parse(log.slice(11));
      if (ev.event !== "execution_requested") continue;
      const req = JSON.parse(ev.data[0].request_data);
      if (att.request_id === null || req.request_id === att.request_id) {
        found = { predecessor: req.predecessor_id, input: req.input_data ?? "", returns };
      }
    }
  }
  return found;
}

// ---- the quote ----

/** Bytes backed by a plain ArrayBuffer, which is what WebCrypto accepts. */
type Bytes = Uint8Array<ArrayBuffer>;

const digestHex = async (b: Bytes) => toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", b)));

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const u16 = (b: Bytes, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Bytes, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export type Quote = {
  /** Header and TD report: the bytes the attestation key signs. */
  signed: Bytes;
  reportData: Bytes;
  measurements: { mrtd: string; rtmr0: string; rtmr1: string; rtmr2: string; rtmr3: string };
  signature: Bytes;
  attestationKey: Bytes;
  qeReport: Bytes;
  qeSignature: Bytes;
  qeAuth: Bytes;
  /** PEM certificates, leaf (PCK) first. */
  chain: string[];
};

/** A TDX quote, version 4 (Intel DCAP layout). */
export function parseQuote(base64Quote: string): Quote {
  const q = b64(base64Quote);
  if (q.length < 640 || u16(q, 0) !== 4 || u32(q, 4) !== 0x81) throw new Error("not a TDX v4 quote");
  const m = (o: number) => toHex(q.subarray(o, o + 48));
  let o = 632 + 4;
  const signature = q.subarray(o, o + 64);
  const attestationKey = q.subarray(o + 64, o + 128);
  o += 128;
  if (u16(q, o) !== 6) throw new Error("unexpected certification data type");
  o += 6;
  const qeReport = q.subarray(o, o + 384);
  const qeSignature = q.subarray(o + 384, o + 448);
  o += 448;
  const authLen = u16(q, o);
  const qeAuth = q.subarray(o + 2, o + 2 + authLen);
  o += 2 + authLen;
  if (u16(q, o) !== 5) throw new Error("the quote carries no PCK certificate chain");
  const pem = new TextDecoder().decode(q.subarray(o + 6, o + 6 + u32(q, o + 2)));
  const chain = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  return {
    signed: q.subarray(0, 632),
    reportData: q.subarray(568, 632),
    measurements: { mrtd: m(184), rtmr0: m(376), rtmr1: m(424), rtmr2: m(472), rtmr3: m(520) },
    signature,
    attestationKey,
    qeReport,
    qeSignature,
    qeAuth,
    chain,
  };
}

/** The worker's task hash, which it puts in the quote's report data (V1 layout,
 * from OutLayer's worker/src/tdx_attestation.rs). Optional fields that are
 * absent are skipped; hashes are hashed as their hex text. */
export async function taskHash(a: Attestation): Promise<string> {
  const enc = new TextEncoder();
  const parts: Bytes[] = [];
  const text = (s: string | null | undefined) => {
    if (s !== null && s !== undefined) parts.push(enc.encode(s));
  };
  const int64 = (n: number) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, BigInt(n), true);
    parts.push(b);
  };
  text(a.task_type);
  int64(a.task_id);
  text(a.repo_url);
  text(a.commit_hash);
  text(a.build_target);
  text(a.wasm_hash);
  text(a.input_hash);
  text(a.output_hash);
  if (a.block_height !== null) int64(a.block_height);
  text(a.caller_account_id);
  text(a.project_id);
  text(a.secrets_ref);
  int64(a.timestamp);
  text(a.attached_usd);
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return digestHex(all);
}

// ---- just enough DER to read three certificates ----

type Tlv = { tag: number; start: number; end: number; headerStart: number };

function tlv(b: Bytes, o: number): Tlv {
  const tag = b[o];
  let len = b[o + 1];
  let start = o + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | b[start + i];
    start += n;
  }
  return { tag, start, end: start + len, headerStart: o };
}

function children(b: Bytes, t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let o = t.start; o < t.end; ) {
    const c = tlv(b, o);
    out.push(c);
    o = c.end;
  }
  return out;
}

type Cert = { tbs: Bytes; signature: Bytes; publicKey: Bytes };

function readCert(pem: string): Cert {
  const der = b64(pem.replace(/-----[^-]+-----|\s/g, ""));
  const [tbs, , sig] = children(der, tlv(der, 0));
  const fields = children(der, tbs);
  const spki = fields[fields[0].tag === 0xa0 ? 6 : 5];
  const bits = children(der, spki)[1];
  return {
    tbs: der.subarray(tbs.headerStart, tbs.end),
    // BIT STRING: one unused-bits byte, then the DER ECDSA signature
    signature: derToRaw(der.subarray(sig.start + 1, sig.end)),
    publicKey: der.subarray(bits.start + 1, bits.end),
  };
}

/** DER ECDSA signature (SEQUENCE of two INTEGERs) to the 64-byte r‖s WebCrypto wants. */
function derToRaw(der: Bytes): Bytes {
  const [r, s] = children(der, tlv(der, 0));
  const out = new Uint8Array(64);
  const put = (t: Tlv, at: number) => {
    let v = der.subarray(t.start, t.end);
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    out.set(v, at + 32 - v.length);
  };
  put(r, 0);
  put(s, 32);
  return out;
}

async function p256Verify(point: Bytes, signature: Bytes, data: Bytes): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", point, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, data);
  } catch {
    return false;
  }
}

/** Intel's signatures, from the pinned root down to the quote itself. */
async function intelChain(q: Quote): Promise<{ ok: boolean; detail: string }> {
  if (q.chain.length !== 3) return { ok: false, detail: `expected 3 certificates, got ${q.chain.length}` };
  const [pck, inter, root] = q.chain.map(readCert);
  if (toHex(root.publicKey) !== INTEL_ROOT_KEY) return { ok: false, detail: "the chain doesn't end at Intel's root key" };
  const steps: [string, boolean][] = [
    ["root signs itself", await p256Verify(root.publicKey, root.signature, root.tbs)],
    ["root signs the platform CA", await p256Verify(root.publicKey, inter.signature, inter.tbs)],
    ["platform CA signs the PCK certificate", await p256Verify(inter.publicKey, pck.signature, pck.tbs)],
    ["PCK key signs the quoting enclave's report", await p256Verify(pck.publicKey, q.qeSignature, q.qeReport)],
    [
      "quoting enclave vouches for the attestation key",
      (await digestHex(new Uint8Array([...q.attestationKey, ...q.qeAuth]))) === toHex(q.qeReport.subarray(320, 352)),
    ],
    ["attestation key signs this quote", await p256Verify(new Uint8Array([4, ...q.attestationKey]), q.signature, q.signed)],
  ];
  const bad = steps.find(([, ok]) => !ok);
  return bad ? { ok: false, detail: `failed: ${bad[0]}` } : { ok: true, detail: "Intel root → platform CA → PCK → quoting enclave → quote" };
}

function parseLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---- the checks ----

export type Expect = {
  /** The account that must have called OutLayer. */
  contract: string;
  project: string;
  wasmSha256: string;
};

export type Verified = { checks: Check[]; request: Requested | null; input: Record<string, unknown> | null; output: unknown };

/** Every check that doesn't depend on what Nema stored; the caller adds those. */
export async function verifyRun(att: Attestation, expect: Expect, net = NET): Promise<Verified> {
  const checks: Check[] = [];
  const add = (id: string, label: string, ok: boolean | null, detail: string) => checks.push({ id, label, ok, detail });

  let q: Quote | null = null;
  try {
    q = parseQuote(att.tdx_quote);
  } catch (e) {
    add("quote", "A genuine Intel TDX quote", false, e instanceof Error ? e.message : String(e));
  }
  if (q) {
    const chain = await intelChain(q);
    add("quote", "Signed by Intel", chain.ok, chain.detail);
    const th = await taskHash(att);
    const rd = toHex(q.reportData);
    add("binding", "The quote vouches for exactly this run", rd === th + "0".repeat(64), `task hash ${th.slice(0, 16)}…`);
    let approved: boolean | null = null;
    try {
      approved = await viewOn<boolean>(net, net.register, "is_measurements_approved", { measurements: q.measurements });
    } catch {
      approved = null;
    }
    add("worker", "An approved OutLayer worker image", approved, approved === null ? `couldn't ask ${net.register}` : `5 measurements, checked on ${net.register}`);
  }

  add(
    "code",
    "Nema's published enclave build ran",
    att.wasm_hash === expect.wasmSha256 && att.project_id === expect.project,
    `${att.project_id ?? "no project"} · wasm ${att.wasm_hash?.slice(0, 12) ?? "?"}…`,
  );

  let request: Requested | null = null;
  try {
    request = await requestOf(att, net);
  } catch {
    request = null;
  }
  let input: Record<string, unknown> | null = null;
  if (!request) {
    add("input", "Asked for by the Nema contract", null, "couldn't read the transaction");
  } else {
    const inputHash = await sha256Hex(request.input);
    try {
      input = JSON.parse(request.input);
    } catch {
      input = null;
    }
    add(
      "input",
      "Asked for by the Nema contract",
      request.predecessor === expect.contract && inputHash === att.input_hash && input?.contract === expect.contract,
      `called by ${request.predecessor} · input hash ${inputHash.slice(0, 12)}…`,
    );
  }

  let output: unknown = null;
  for (const text of request?.returns ?? []) {
    if ((await sha256Hex(text)) === att.output_hash) {
      output = parseLoose(text);
      // A JSON response format can come back as a JSON string holding the JSON.
      if (typeof output === "string") output = parseLoose(output);
    }
  }
  return { checks, request, input, output };
}

