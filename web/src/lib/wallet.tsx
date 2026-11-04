import { actionCreators, setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupHereWallet } from "@near-wallet-selector/here-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import "@near-wallet-selector/modal-ui/styles.css";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useToast } from "../components/Toaster";
import { CONFIG, POLL_MS } from "./config";
import { findSent } from "./near";

const TGAS = 10n ** 12n;

export type Call = {
  method: string;
  args: Record<string, unknown>;
  /** yoctoNEAR to attach. */
  deposit?: bigint;
  tgas?: number;
  /** What the toasts call this transaction, e.g. "Your mark". */
  label: string;
};

type Wallet = {
  ready: boolean;
  accountId: string | null;
  signIn(): void;
  signOut(): Promise<void>;
  /** Signs and sends one call to the Nema contract. Resolves true when it succeeded. */
  call(c: Call): Promise<boolean>;
};

const WalletContext = createContext<Wallet | null>(null);

let selectorPromise: Promise<{ selector: WalletSelector; modal: WalletSelectorModal }> | null = null;

function init() {
  selectorPromise ??= setupWalletSelector({
    network: {
      networkId: CONFIG.network,
      nodeUrl: CONFIG.rpc,
      helperUrl: `https://helper.${CONFIG.network}.near.org`,
      explorerUrl: CONFIG.explorerAccount.replace(/\/address\/$/, ""),
      indexerUrl: `https://api.${CONFIG.network}.nearblocks.io`,
    },
    modules: [setupMeteorWallet(), setupMyNearWallet(), setupHereWallet()],
  }).then((selector) => ({
    selector,
    modal: setupModal(selector, {
      contractId: CONFIG.contract,
      theme: "light",
      description: "Nema only asks your wallet to sign the calls you confirm. It never sees your keys.",
    }),
  }));
  return selectorPromise;
}

const CANCELLED = "You cancelled it in your wallet.";

/** Pulls a readable reason out of a wallet error or a failed transaction outcome. */
function reason(e: unknown): string {
  const text = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
  const m = text.match(/Smart contract panicked: ([^"\\]+)/) ?? text.match(/ExecutionError":"([^"\\]+)/);
  if (m) return m[1];
  if (/reject|cancel|denied|closed/i.test(text)) return CANCELLED;
  return text.length > 180 ? text.slice(0, 180) + "…" : text;
}

function failure(outcome: unknown): string | null {
  const o = outcome as { status?: { Failure?: unknown }; receipts_outcome?: { outcome: { status: { Failure?: unknown } } }[] } | undefined;
  if (o?.status && typeof o.status === "object" && "Failure" in o.status) return reason(JSON.stringify(o.status.Failure));
  const bad = o?.receipts_outcome?.find((r) => r.outcome.status && "Failure" in r.outcome.status);
  return bad ? reason(JSON.stringify(bad.outcome.status.Failure)) : null;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const [ready, setReady] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);

  useEffect(() => {
    let sub: { unsubscribe(): void } | undefined;
    init().then(
      ({ selector }) => {
        const pick = () => selector.store.getState().accounts.find((a) => a.active)?.accountId ?? null;
        setAccountId(pick());
        sub = selector.store.observable.subscribe(() => setAccountId(pick()));
        setReady(true);
      },
      () => setReady(true),
    );
    return () => sub?.unsubscribe();
  }, []);

  const signIn = useCallback(() => {
    init().then(({ modal }) => modal.show());
  }, []);

  const signOut = useCallback(async () => {
    const { selector } = await init();
    const wallet = await selector.wallet();
    await wallet.signOut();
    toast("info", "Signed out");
  }, [toast]);

  const call = useCallback(
    async (c: Call) => {
      const { selector, modal } = await init();
      if (!selector.isSignedIn()) {
        modal.show();
        return false;
      }
      toast("info", `${c.label}: confirm in your wallet`);
      const started = Date.now();
      try {
        const wallet = await selector.wallet();
        const outcome = await wallet.signAndSendTransaction({
          receiverId: CONFIG.contract,
          actions: [actionCreators.functionCall(c.method, c.args, BigInt(c.tgas ?? 30) * TGAS, c.deposit ?? 0n)],
        });
        const bad = failure(outcome);
        if (bad) {
          toast("bad", `${c.label} failed`, bad);
          return false;
        }
        toast("ok", `${c.label}: confirmed`);
        return true;
      } catch (e) {
        const why = reason(e);
        if (why === CANCELLED) {
          toast("bad", `${c.label} wasn't sent`, why);
          return false;
        }
        // A timeout or dropped connection can come after the transaction went out,
        // so look for it on chain before calling it failed.
        toast("info", `${c.label}: the wallet lost track of it, checking the chain`);
        const account = selector.store.getState().accounts.find((a) => a.active)?.accountId;
        for (let i = 0; account && i < 4; i++) {
          await new Promise((r) => setTimeout(r, POLL_MS / 3));
          const tx = await findSent(account, c.method, started);
          if (!tx) continue;
          const bad = failure(tx);
          if (bad) toast("bad", `${c.label} failed`, bad);
          else toast("ok", `${c.label}: confirmed`, `Found on chain: ${CONFIG.explorerTx}${tx.transaction.hash}`);
          return !bad;
        }
        toast("bad", `${c.label} not found on chain`, `${why} Nothing from your account has reached Nema since you confirmed.`);
        return false;
      }
    },
    [toast],
  );

  return <WalletContext.Provider value={{ ready, accountId, signIn, signOut, call }}>{children}</WalletContext.Provider>;
}

export function useWallet(): Wallet {
  const w = useContext(WalletContext);
  if (!w) throw new Error("useWallet outside WalletProvider");
  return w;
}
