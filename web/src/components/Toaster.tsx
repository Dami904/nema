import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type Tone = "info" | "ok" | "bad";
type Toast = { id: number; tone: Tone; title: string; body?: string };
type Toaster = { toast(tone: Tone, title: string, body?: string): void };

const ToastContext = createContext<Toaster | null>(null);
let next = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = useCallback((tone: Tone, title: string, body?: string) => {
    const id = next++;
    setToasts((t) => [...t, { id, tone, title, body }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "bad" ? 9000 : 5000);
  }, []);
  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div aria-live="polite" className="toaster" style={{ position: "fixed", right: 16, bottom: 16, display: "grid", gap: 10, zIndex: 30, maxWidth: "min(380px, calc(100vw - 32px))" }}>
        {toasts.map((t) => (
          <div key={t.id} className="card fadein" role="status" style={{ padding: "14px 18px", borderRadius: 18, boxShadow: "0 10px 30px rgba(28,36,32,.12)",
            borderColor: t.tone === "bad" ? "var(--rose-bg)" : t.tone === "ok" ? "var(--mist)" : "var(--hair)" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <span className="dot" style={{ background: t.tone === "bad" ? "var(--rose-ink)" : t.tone === "ok" ? "var(--sage)" : "var(--faint)" }} />
              <div>
                <strong style={{ fontWeight: 500 }}>{t.title}</strong>
                {t.body && <p className="hint" style={{ marginTop: 2 }}>{t.body}</p>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): Toaster {
  const t = useContext(ToastContext);
  if (!t) throw new Error("useToast outside ToastProvider");
  return t;
}
