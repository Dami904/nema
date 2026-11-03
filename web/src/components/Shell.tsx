import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { DEMO_PERSONAS, useAccount } from "../lib/account";
import { useChain, useLoad } from "../lib/chain";
import { CONFIG, REPO_URL } from "../lib/config";
import { handle } from "../lib/format";
import { useWallet } from "../lib/wallet";
import "./Shell.css";

const LINKS = [
  { to: "/rounds", label: "Rounds" },
  { to: "/vault", label: "Vault" },
  { to: "/panel", label: "Panel" },
  { to: "/docs", label: "Docs" },
];

export default function Shell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { pathname, hash } = useLocation();
  const { accountId } = useAccount();
  const { data: clients } = useLoad((s) => (accountId ? s.clientsOf(accountId) : Promise.resolve([] as string[])), [accountId]);
  // Anyone signed in may hold reads, so they get a portfolio; auditors also get their desk.
  const links = [
    ...LINKS.slice(0, 2),
    ...(accountId ? [{ to: "/portfolio", label: "Portfolio" }] : []),
    LINKS[2],
    ...(clients?.length ? [{ to: "/audit", label: "Audit" }] : []),
    ...LINKS.slice(3),
  ];
  useEffect(() => {
    setOpen(false);
    // A link to a section (/docs#faq) is scrolled by the page itself.
    if (!hash) window.scrollTo(0, 0);
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <a href="#main" className="skip">Skip to content</a>
      <Banners />
      <header className="nav">
        <Link to="/" className="brand" aria-label="Nema home">Nema</Link>
        <nav className="links" aria-label="Main navigation">
          {links.map((l) => (
            <NavLink key={l.to} to={l.to}>{l.label}</NavLink>
          ))}
        </nav>
        <div className="nav-right">
          <DataSwitch />
          <AccountButton />
          <button className="menu-btn" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} onClick={() => setOpen(!open)}>
            <span /><span />
          </button>
        </div>
      </header>
      {open && (
        <nav className="sheet fadein" aria-label="Main navigation">
          {links.map((l) => (
            <NavLink key={l.to} to={l.to}>{l.label}</NavLink>
          ))}
        </nav>
      )}
      <main id="main">{children}</main>
      <Footer />
    </>
  );
}

function Banners() {
  const { demoMode, setDemoMode, link, refresh } = useChain();
  return (
    <>
      {!demoMode && link === "offline" && (
        <div className="offline" role="status">
          <span>Can't reach NEAR {CONFIG.network} right now. Trying again every 15 seconds.</span>
          <span style={{ display: "flex", gap: 8 }}>
            <button className="btn small ghost" onClick={refresh}>Retry</button>
            <button className="btn small ghost" onClick={() => setDemoMode(true)}>Show sample data</button>
          </span>
        </div>
      )}
    </>
  );
}

/** Sample or live data, in one control; the dot shows whether the chain answers. */
function DataSwitch() {
  const { link, demoMode, setDemoMode } = useChain();
  const state = demoMode ? "demo" : link;
  const title = demoMode ? "Showing sample data" : link === "live" ? `Live from NEAR ${CONFIG.network}` : link === "loading" ? "Connecting" : "Offline";
  return (
    <div className="data-switch" role="group" aria-label="Data shown" title={title}>
      <button aria-pressed={demoMode} onClick={() => setDemoMode(true)}>Sample</button>
      <button aria-pressed={!demoMode} onClick={() => setDemoMode(false)}>
        <span className={`pulse ${state}`} aria-hidden="true" />
        Live
      </button>
    </div>
  );
}

function AccountButton() {
  const { demoMode } = useChain();
  const { accountId, setDemoAccount } = useAccount();
  if (demoMode) {
    return (
      <label className="persona">
        <span className="sr-only">Viewing as</span>
        <select value={accountId ?? ""} onChange={(e) => setDemoAccount(e.target.value)}>
          {DEMO_PERSONAS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.role} · {handle(p.id)}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return <WalletButton />;
}

function WalletButton() {
  const { ready, accountId, signIn, signOut } = useWallet();
  const [open, setOpen] = useState(false);
  if (!accountId)
    return (
      <button className="btn small" onClick={signIn} disabled={!ready}>
        Connect wallet
      </button>
    );
  return (
    <div className="acct">
      <button className="btn small ghost" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)} title={accountId}>
        {handle(accountId)} ▾
      </button>
      {open && (
        <div className="acct-menu fadein" role="menu" onMouseLeave={() => setOpen(false)}>
          <p className="mono">{accountId}</p>
          <Link role="menuitem" to="/vault" onClick={() => setOpen(false)}>Your vault</Link>
          <a role="menuitem" href={`${CONFIG.explorerAccount}${accountId}`} target="_blank" rel="noreferrer">On explorer ↗</a>
          <button role="menuitem" onClick={() => (setOpen(false), signOut())}>Sign out</button>
        </div>
      )}
    </div>
  );
}

function Footer() {
  const cols: { title: string; links: { label: string; to?: string; href?: string }[] }[] = [
    { title: "Use it", links: [{ label: "Rounds", to: "/rounds" }, { label: "Vault", to: "/vault" }, { label: "Portfolio", to: "/portfolio" }, { label: "Panel", to: "/panel" }] },
    {
      title: "Check it",
      links: [
        { label: "Verify it yourself", to: "/docs#verify" },
        { label: "What you're trusting", to: "/docs#trust" },
        { label: "Contract on explorer ↗", href: `${CONFIG.explorerAccount}${CONFIG.contract}` },
      ],
    },
    {
      title: "Learn",
      links: [
        { label: "Docs", to: "/docs" },
        { label: "Questions", to: "/docs#faq" },
        ...(REPO_URL ? [{ label: "Source code ↗", href: REPO_URL }] : []),
      ],
    },
  ];
  return (
    <footer className="foot">
      <div className="wrap foot-top">
        <div className="foot-brand">
          <Link to="/" className="brand">Nema</Link>
          <p className="muted">Private consensus marks for private loans. Funds agree on a price without showing each other their numbers.</p>
        </div>
        {cols.map((c) => (
          <nav className="foot-col" key={c.title} aria-label={c.title}>
            <div className="label">{c.title}</div>
            {c.links.map((l) =>
              l.to ? <Link key={l.label} to={l.to}>{l.label}</Link> : <a key={l.label} href={l.href} target="_blank" rel="noreferrer">{l.label}</a>,
            )}
          </nav>
        ))}
      </div>
      <div className="foot-hills" aria-hidden="true">
        <svg viewBox="0 0 1200 120" preserveAspectRatio="none">
          <path d="M0 60 Q150 20 320 50 T640 40 T960 52 T1200 38 V120 H0Z" fill="#cfdcd5" />
          <path d="M0 84 Q180 52 380 76 T760 70 T1200 74 V120 H0Z" fill="#8aa898" />
          <path d="M0 104 Q220 86 470 100 T1200 96 V120 H0Z" fill="#3f5a4c" />
        </svg>
      </div>
      <div className="foot-base">
        <div className="wrap">
          <span className="mono">{CONFIG.contract} · NEAR {CONFIG.network}</span>
          <span>MIT licence · Built for the NEAR Hackathon 2026</span>
        </div>
      </div>
    </footer>
  );
}
