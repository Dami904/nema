import { CONFIG } from "./config";

export class RpcError extends Error {}

async function rpc<T>(method: string, params: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(CONFIG.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "nema", method, params }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new RpcError("Can't reach the NEAR RPC.");
  }
  if (!res.ok) throw new RpcError(`The NEAR RPC answered ${res.status}.`);
  const body = await res.json();
  if (body.error) throw new RpcError(body.error.data ?? body.error.message ?? "RPC error");
  return body.result as T;
}

/** Calls a view method on the Nema contract, or on `account` if given. */
export async function view<T>(method: string, args: Record<string, unknown> = {}, account = CONFIG.contract): Promise<T> {
  const result = await rpc<{ result?: number[]; error?: string }>("query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: account,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  if (result.error) throw new RpcError(result.error);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result ?? [])));
}

export type AccountView = { amount: string; code_hash: string; storage_usage: number };

export function viewAccount(accountId: string): Promise<AccountView> {
  return rpc("query", { request_type: "view_account", finality: "final", account_id: accountId });
}

export type TxOutcome = {
  status?: { Failure?: unknown };
  transaction: { hash: string; receiver_id: string; actions: ({ FunctionCall?: { method_name: string } } | string)[] };
  receipts_outcome?: { outcome: { status: { Failure?: unknown } } }[];
};

/**
 * The newest transaction `signer` sent since `sinceMs` that calls `method` on the
 * Nema contract, or null. For a wallet that timed out or lost its connection
 * after the transaction may already have gone out.
 */
export async function findSent(signer: string, method: string, sinceMs: number): Promise<TxOutcome | null> {
  let res: Response;
  try {
    res = await fetch(`${CONFIG.txApi}/v0/account`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account_id: signer }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const { account_txs = [] } = (await res.json()) as {
    account_txs?: { transaction_hash: string; tx_block_timestamp: string; is_signer: boolean }[];
  };
  const since = BigInt(sinceMs) * 1_000_000n;
  for (const t of account_txs) {
    if (BigInt(t.tx_block_timestamp) < since) break;
    if (!t.is_signer) continue;
    const tx = await rpc<TxOutcome>("tx", { tx_hash: t.transaction_hash, sender_account_id: signer, wait_until: "EXECUTED_OPTIMISTIC" }).catch(() => null);
    const calls = tx?.transaction.receiver_id === CONFIG.contract && tx.transaction.actions.some((a) => typeof a === "object" && a.FunctionCall?.method_name === method);
    if (calls) return tx;
  }
  return null;
}
