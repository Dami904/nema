// The same hashes the contract and the enclave compute (see DESIGN.md).

const enc = new TextEncoder();

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    buf.set(p, at);
    at += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

export const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function setHash(subs: { account: string; ciphertext_hex: string }[]): Promise<string> {
  const sorted = [...subs].sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
  const parts: Uint8Array[] = [];
  for (const s of sorted) {
    const account = enc.encode(s.account);
    parts.push(u32le(account.length), account, await sha256(enc.encode(s.ciphertext_hex)));
  }
  return toHex(await sha256(...parts));
}

export async function commitment(
  contract: string,
  roundId: bigint,
  saltHex: string,
  count: number,
  mean: string,
  spread: string,
): Promise<string> {
  const c = enc.encode(contract);
  return toHex(
    await sha256(
      enc.encode("nema/commit/v1"),
      u32le(c.length),
      c,
      u64le(roundId),
      fromHex(saltHex),
      enc.encode(`${count}|${mean}|${spread}`),
    ),
  );
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await sha256(enc.encode(text)));
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** NEAR reports a contract's code hash in base58; we publish ours in hex. */
export function base58ToHex(s: string): string {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return "";
    n = n * 58n + BigInt(i);
  }
  return n.toString(16).padStart(64, "0");
}
