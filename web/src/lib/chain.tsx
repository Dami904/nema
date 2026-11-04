import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { POLL_MS } from "./config";
import { demo, live, type Source } from "./source";
import type { Config, Round } from "./types";

export type Link = "loading" | "live" | "offline";

type Chain = {
  demoMode: boolean;
  setDemoMode(on: boolean): void;
  source: Source;
  link: Link;
  error: string | null;
  config: Config | null;
  members: string[];
  rounds: Round[];
  /** Ticks after every successful poll, so pages can refetch their own data. */
  version: number;
  refresh(): void;
};

const ChainContext = createContext<Chain | null>(null);

function initialDemo(): boolean {
  const q = new URLSearchParams(location.search).get("demo");
  try {
    if (q !== null) sessionStorage.setItem("nema.demo", q === "0" ? "0" : "1");
    return sessionStorage.getItem("nema.demo") === "1";
  } catch {
    return q !== null && q !== "0";
  }
}

export function ChainProvider({ children }: { children: ReactNode }) {
  const [demoMode, setDemo] = useState(initialDemo);
  const [link, setLink] = useState<Link>("loading");
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [members, setMembers] = useState<string[]>([]);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [version, setVersion] = useState(0);
  const source = demoMode ? demo : live;
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [c, m, r] = await Promise.all([source.config(), source.members(), source.rounds()]);
      if (mine !== seq.current) return;
      setConfig(c);
      setMembers(m);
      setRounds([...r].sort((a, b) => Number(b.id) - Number(a.id)));
      setLink("live");
      setError(null);
      setVersion((v) => v + 1);
    } catch (e) {
      if (mine !== seq.current) return;
      setLink("offline");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [source]);

  useEffect(() => {
    setLink("loading");
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const setDemoMode = (on: boolean) => {
    try {
      sessionStorage.setItem("nema.demo", on ? "1" : "0");
    } catch {
      /* private window */
    }
    setDemo(on);
  };

  return (
    <ChainContext.Provider value={{ demoMode, setDemoMode, source, link, error, config, members, rounds, version, refresh }}>
      {children}
    </ChainContext.Provider>
  );
}

export function useChain(): Chain {
  const c = useContext(ChainContext);
  if (!c) throw new Error("useChain outside ChainProvider");
  return c;
}

/** Loads something from the current source and reloads it after every poll. */
export function useLoad<T>(load: (s: Source) => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | null } {
  const { source, version } = useChain();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    load(source).then(
      (d) => alive && (setData(d), setError(null)),
      (e) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
    // The caller passes what `load` reads as `deps`; `load` itself is a new
    // closure every render and would reload on each one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, version, ...deps]);
  return { data, error };
}

/** Re-renders every second, for countdowns. */
export function useNow(every = 1000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}
