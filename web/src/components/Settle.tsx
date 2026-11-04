import { useState } from "react";
import { useAccount } from "../lib/account";
import { useLoad, useNow } from "../lib/chain";
import { STALE_AFTER_MS } from "../lib/config";
import { nsToMs } from "../lib/format";
import type { PendingKind } from "../lib/source";

const METHOD: Record<PendingKind, { method: string; arg: string; label: string; does: string }> = {
  round: { method: "reconcile_round", arg: "round_id", label: "Settling the close", does: "marks the close failed so it can be retried" },
  read: { method: "reconcile_read", arg: "purchase_id", label: "Settling your read", does: "refunds the read price (OutLayer keeps its fee)" },
  audit: { method: "reconcile_audit", arg: "audit_id", label: "Settling the audit", does: "marks it failed so it can be asked again" },
};

/**
 * The contract stops waiting on an enclave call 30 minutes after it was made.
 * Until then this says when; after, anyone can settle it.
 */
export function Settle({ kind, id }: { kind: PendingKind; id: string }) {
  const { act } = useAccount();
  const now = useNow(10_000);
  const [busy, setBusy] = useState(false);
  const { data: since } = useLoad((s) => s.pendingSince(kind, id), [kind, id]);
  if (!since) return null;

  const due = nsToMs(since) + STALE_AFTER_MS;
  const m = METHOD[kind];
  if (now < due)
    return (
      <p className="hint" style={{ marginTop: 8 }}>
        If the enclave hasn't answered by {new Date(due).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, anyone can settle this; settling {m.does}.
      </p>
    );

  const settle = async () => {
    setBusy(true);
    await act({ method: m.method, args: { [m.arg]: Number(id) }, label: m.label });
    setBusy(false);
  };
  return (
    <>
      <button className="btn ghost small" style={{ marginTop: 10 }} onClick={settle} disabled={busy} aria-disabled={busy}>
        {busy ? "Waiting for your wallet…" : "Settle it"}
      </button>
      <p className="hint" style={{ marginTop: 6 }}>The enclave hasn't answered in 30 minutes. Settling {m.does}.</p>
    </>
  );
}
