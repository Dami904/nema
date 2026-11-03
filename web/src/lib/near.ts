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

/** Calls a view method on the Nema contract. */
export async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await rpc<{ result?: number[]; error?: string }>("query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: CONFIG.contract,
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
