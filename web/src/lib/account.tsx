import { createContext, useContext, useState, type ReactNode } from "react";
import { useToast } from "../components/Toaster";
import { useChain } from "./chain";
import { CONFIG } from "./config";
import { DEMO_AUDITOR, DEMO_COUNCIL, DEMO_LENDER, simulate } from "./demo";
import { useWallet, type Call } from "./wallet";

export const DEMO_PERSONAS = [
  { id: `fund1.${CONFIG.accountsBase}`, role: "Fund" },
  { id: `fund2.${CONFIG.accountsBase}`, role: "Fund" },
  { id: DEMO_LENDER, role: "Lender" },
  { id: DEMO_AUDITOR, role: "Auditor" },
  { id: `applicant.${CONFIG.accountsBase}`, role: "Applicant" },
  { id: DEMO_COUNCIL[0], role: "Council" },
];

type Account = {
  /** The signed-in wallet account, or the demo persona. Null when nobody is signed in. */
  accountId: string | null;
  setDemoAccount(id: string): void;
  /** Sends a contract call. In demo mode it plays the call on the sample data, or explains that nothing was sent. Resolves true on success. */
  act(c: Call): Promise<boolean>;
};

const AccountContext = createContext<Account | null>(null);

export function AccountProvider({ children }: { children: ReactNode }) {
  const { demoMode, refresh } = useChain();
  const wallet = useWallet();
  const { toast } = useToast();
  const [demoAccount, setDemoAccount] = useState(DEMO_PERSONAS[0].id);
  const accountId = demoMode ? demoAccount : wallet.accountId;

  const act = async (c: Call) => {
    if (demoMode) {
      const played = await simulate(c.method, c.args, demoAccount, refresh);
      if (played === null) {
        toast("info", "Sample data: nothing was sent", "Switch to live data and sign in to do this for real.");
        return false;
      }
      if (played) toast("ok", `${c.label} (sample)`, "Played on sample data in this tab. Nothing was sent to the chain.");
      else toast("bad", `${c.label} wasn't possible`, "The contract would refuse this for the account you're viewing as.");
      return played;
    }
    const ok = await wallet.call(c);
    if (ok) refresh();
    return ok;
  };

  return <AccountContext.Provider value={{ accountId, setDemoAccount, act }}>{children}</AccountContext.Provider>;
}

export function useAccount(): Account {
  const a = useContext(AccountContext);
  if (!a) throw new Error("useAccount outside AccountProvider");
  return a;
}
