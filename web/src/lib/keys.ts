// The buyer key: a secp256k1 key made in this browser. The enclave seals each
// result to its public half; only this device (or a restored backup) can open it.
// Also the marks a fund chose to keep on this device.

import { PrivateKey, decrypt, encrypt } from "eciesjs";
import { CONFIG } from "./config";
import { fromHex, toHex } from "./hashes";
import type { AuditOpened, Opened } from "./types";

type StoredKey = { sk: string; pk: string; account: string; contract: string; created: string };

const keyName = (account: string) => `nema.buyerkey.${CONFIG.contract}.${account}`;
const markName = (account: string, roundId: string) => `nema.mark.${CONFIG.contract}.${account}.${roundId}`;

function read<T>(name: string): T | null {
  try {
    const v = localStorage.getItem(name);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

function write(name: string, value: unknown): boolean {
  try {
    localStorage.setItem(name, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function getBuyerKey(account: string): StoredKey | null {
  return read<StoredKey>(keyName(account));
}

/** Returns this account's buyer key, creating one on first use. */
export function ensureBuyerKey(account: string): StoredKey {
  const existing = getBuyerKey(account);
  if (existing) return existing;
  const sk = new PrivateKey();
  const key = { sk: sk.toHex(), pk: sk.publicKey.toHex(true), account, contract: CONFIG.contract, created: new Date().toISOString() };
  if (!write(keyName(account), key)) throw new Error("This browser won't store the key (private window?). Reads can't be opened without it.");
  return key;
}

/** Saves the key as a file the user keeps. */
export function downloadBackup(account: string): void {
  const key = getBuyerKey(account);
  if (!key) return;
  const blob = new Blob([JSON.stringify({ kind: "nema-buyer-key", ...key }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `nema-key-${account}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Restores a backup file. Refuses a file made for another account or contract. */
export async function restoreBackup(account: string, file: File): Promise<void> {
  let parsed: Partial<StoredKey> & { kind?: string };
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("That file isn't a Nema key backup.");
  }
  if (parsed.kind !== "nema-buyer-key" || !parsed.sk || !parsed.pk) throw new Error("That file isn't a Nema key backup.");
  if (parsed.account !== account) throw new Error(`That backup belongs to ${parsed.account}, not ${account}.`);
  if (parsed.contract !== CONFIG.contract) throw new Error("That backup is for a different Nema contract.");
  if (PrivateKey.fromHex(parsed.sk).publicKey.toHex(true) !== parsed.pk) throw new Error("That backup is damaged: its two halves don't match.");
  write(keyName(account), { sk: parsed.sk, pk: parsed.pk, account, contract: CONFIG.contract, created: parsed.created ?? new Date().toISOString() });
}

/** Opens a sealed delivery with this device's key. Throws if the key doesn't fit. */
export function openSealed(sk: string, sealedHex: string): Opened {
  const plain = decrypt(sk, fromHex(sealedHex));
  const o = JSON.parse(new TextDecoder().decode(plain));
  if (typeof o.count !== "number" || typeof o.mean !== "string" || typeof o.spread !== "string" || typeof o.salt !== "string")
    throw new Error("The opened copy isn't in the expected shape.");
  return o;
}

/** Opens a fund's submission that the enclave sealed for its auditor. */
export function openAudit(sk: string, sealedHex: string): AuditOpened {
  const o = JSON.parse(new TextDecoder().decode(decrypt(sk, fromHex(sealedHex))));
  if (o.kind !== "audit" || typeof o.mark !== "number" || typeof o.account !== "string")
    throw new Error("The opened copy isn't in the expected shape.");
  return o;
}

/** Encrypts a fund's mark to the round key. The account inside stops another fund replaying it. */
export function sealMark(roundPubkeyHex: string, account: string, hundredths: number): string {
  const plain = new TextEncoder().encode(JSON.stringify({ account, mark: hundredths }));
  return toHex(encrypt(roundPubkeyHex, plain));
}

export function keepMark(account: string, roundId: string, hundredths: number): void {
  write(markName(account, roundId), hundredths);
}

export function keptMark(account: string, roundId: string): number | null {
  return read<number>(markName(account, roundId));
}
