// The reads an account bought, opened with the key on this device.

import { useMemo } from "react";
import { useChain, useLoad } from "./chain";
import { DEMO_OPENED, DEMO_OWN_MARKS } from "./demo";
import { getBuyerKey, keptMark, openSealed } from "./keys";
import type { Opened, Purchase } from "./types";

export type ReadState =
  | { kind: "opened"; opened: Opened; purchase: Purchase }
  | { kind: "pending"; purchase: Purchase }
  /** Delivered, but sealed to a key this device doesn't hold. */
  | { kind: "locked"; purchase: Purchase }
  | { kind: "broken"; purchase: Purchase; error: string };

export function useReads(account: string | null): { purchases: Purchase[] | undefined; byRound: Record<string, ReadState> } {
  const { demoMode } = useChain();
  const { data: purchases } = useLoad((s) => (account ? s.purchasesOf(account) : Promise.resolve([] as Purchase[])), [account]);

  const byRound = useMemo(() => {
    const out: Record<string, ReadState> = {};
    if (!account || !purchases) return out;
    const key = demoMode ? null : getBuyerKey(account);
    // Oldest first, so a later purchase of the same round wins.
    for (const p of [...purchases].sort((a, b) => Number(a.id) - Number(b.id))) {
      if (p.status === "Refunded") continue;
      if (out[p.round_id]?.kind === "opened") continue;
      if (p.status === "Pending" || !p.sealed) {
        out[p.round_id] = { kind: "pending", purchase: p };
      } else if (demoMode) {
        const o = DEMO_OPENED[p.round_id];
        out[p.round_id] = o ? { kind: "opened", opened: o, purchase: p } : { kind: "locked", purchase: p };
      } else if (!key || key.pk !== p.buyer_pubkey) {
        out[p.round_id] = { kind: "locked", purchase: p };
      } else {
        try {
          out[p.round_id] = { kind: "opened", opened: openSealed(key.sk, p.sealed), purchase: p };
        } catch (e) {
          out[p.round_id] = { kind: "broken", purchase: p, error: e instanceof Error ? e.message : String(e) };
        }
      }
    }
    return out;
  }, [account, purchases, demoMode]);

  return { purchases, byRound };
}

/** The mark this account kept on this device for a round, in hundredths. */
export function useOwnMark(account: string | null, roundId: string): number | undefined {
  const { demoMode } = useChain();
  return ownMark(account, roundId, demoMode);
}

export function ownMark(account: string | null, roundId: string, demoMode: boolean): number | undefined {
  if (!account) return undefined;
  if (demoMode) return DEMO_OWN_MARKS[roundId];
  return keptMark(account, roundId) ?? undefined;
}
