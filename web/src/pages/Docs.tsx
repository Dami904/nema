import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useToast } from "../components/Toaster";
import { useChain } from "../lib/chain";
import { NET } from "../lib/attest";
import { BUILDS, CONFIG, ENCLAVE_FEE_YOCTO, READ_EXTRA_YOCTO } from "../lib/config";
import { FAQ, TRUST, WHO_SEES_WHAT } from "../lib/content";
import { near, short } from "../lib/format";
import { base58ToHex } from "../lib/hashes";
import { viewAccount } from "../lib/near";
import "./Docs.css";

const SECTIONS = [
  { group: "Start here", items: [{ id: "overview", title: "Overview" }, { id: "quick-start", title: "Quick start" }] },
  { group: "Understand", items: [{ id: "rounds", title: "How a round works" }, { id: "who-sees-what", title: "Who sees what" }, { id: "trust", title: "Trust model" }] },
  { group: "Verify", items: [{ id: "verify", title: "Verify it yourself" }] },
  { group: "Reference", items: [{ id: "contract", title: "Contract methods" }, { id: "enclave", title: "Enclave interface" }, { id: "faq", title: "FAQ" }] },
];
const FLAT = SECTIONS.flatMap((g) => g.items);

export default function Docs() {
  const active = useScrollSpy(FLAT.map((s) => s.id));
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);

  const { hash } = useLocation();
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [hash]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const q = query.trim().toLowerCase();
  const visible = (title: string, id: string) => !q || title.toLowerCase().includes(q) || (KEYWORDS[id] ?? "").includes(q);
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const i = FLAT.findIndex((s) => s.id === active);

  return (
    <div className="docs wrap display">
      <aside className="docs-nav" aria-label="Docs sections">
        <label className="docs-search">
          <span className="sr-only">Search the docs</span>
          <input ref={search} placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const hit = FLAT.find((s) => visible(s.title, s.id));
                if (hit) go(hit.id);
              }
            }} />
          <kbd>Ctrl K</kbd>
        </label>
        {SECTIONS.map((g) => {
          const items = g.items.filter((s) => visible(s.title, s.id));
          if (!items.length) return null;
          return (
            <div key={g.group} className="docs-group">
              <div className="label">{g.group}</div>
              {items.map((s) => (
                <a key={s.id} href={`#${s.id}`} aria-current={active === s.id ? "true" : undefined}
                  onClick={(e) => (e.preventDefault(), go(s.id), history.replaceState(null, "", `#${s.id}`))}>
                  {s.title}
                </a>
              ))}
            </div>
          );
        })}
        {q && !FLAT.some((s) => visible(s.title, s.id)) && <p className="hint">Nothing matches “{query}”.</p>}
      </aside>

      <label className="docs-jump">
        <span className="label">Jump to</span>
        <select value={active} onChange={(e) => go(e.target.value)}>
          {SECTIONS.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.items.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </optgroup>
          ))}
        </select>
      </label>

      <article className="docs-body">
        <Overview />
        <QuickStart />
        <RoundsSection />
        <WhoSees />
        <Trust />
        <Verify />
        <ContractRef />
        <EnclaveRef />
        <Faq />
        <nav className="docs-pager" aria-label="Previous and next section">
          {i > 0 ? <button onClick={() => go(FLAT[i - 1].id)}><span className="label">Previous</span>{FLAT[i - 1].title}</button> : <span />}
          {i < FLAT.length - 1 && <button className="next" onClick={() => go(FLAT[i + 1].id)}><span className="label">Next</span>{FLAT[i + 1].title}</button>}
        </nav>
      </article>

      <LiveRail />
    </div>
  );
}

/** Extra words each section can be found by. */
const KEYWORDS: Record<string, string> = {
  overview: "what nema mark consensus",
  "quick-start": "wallet connect submit buy backup key fund lender owner auditor apply join start free borrowing base portfolio export csv pdf track record gap lean",
  rounds: "lifecycle status open closing published failed deadline refund retry",
  "who-sees-what": "privacy public chain enclave owner",
  trust: "tdx outlayer hardware assumption risk",
  verify: "hash set commitment code wasm check salt attestation tdx intel quote proof enclave tee",
  contract: "methods gas deposit fee call view api",
  enclave: "tally deliver derive pubkey json input output",
  faq: "questions",
};

function useScrollSpy(ids: string[]): string {
  const [active, setActive] = useState(ids[0]);
  useEffect(() => {
    const onScroll = () => {
      let current = ids[0];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top < 160) current = id;
      }
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) current = ids[ids.length - 1];
      setActive(current);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [ids.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  return active;
}

function Section({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="docs-section">
      <div className="eyebrow">{eyebrow}</div>
      <h2>
        <a href={`#${id}`} className="anchor" aria-label="Link to this section">#</a>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Callout({ tone = "note", title, children }: { tone?: "note" | "warn"; title: string; children: ReactNode }) {
  return (
    <div className={`callout ${tone}`} role="note">
      <strong>{title}</strong>
      <div>{children}</div>
    </div>
  );
}

function Copy({ text, children }: { text: string; children?: ReactNode }) {
  const { toast } = useToast();
  return (
    <span className="copyable">
      <code>{children ?? text}</code>
      <button
        aria-label="Copy"
        onClick={() => navigator.clipboard.writeText(text).then(() => toast("ok", "Copied"), () => toast("bad", "Couldn't copy"))}
      >
        Copy
      </button>
    </span>
  );
}

function Steps({ items }: { items: { title: string; body: ReactNode }[] }) {
  return (
    <ol className="steps-list">
      {items.map((s, i) => (
        <li key={s.title}>
          <span className="n">{i + 1}</span>
          <div>
            <h3>{s.title}</h3>
            <div className="muted">{s.body}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Overview() {
  return (
    <Section id="overview" eyebrow="Docs" title={<>Nema, <em>in plain terms</em></>}>
      <p className="lead">
        Private loans rarely trade, so each fund prices its own. Nema lets a panel of funds agree on a price without any of them
        showing their number. A hardware enclave works out the consensus; lenders pay to read it, and the fee goes to the funds.
      </p>
      <div className="cards">
        <Link to="/rounds" className="doc-card"><span className="label">Browse</span><strong>Rounds</strong><span className="muted">What's being priced now</span></Link>
        <a href="#quick-start" className="doc-card"><span className="label">Start</span><strong>Quick start</strong><span className="muted">Fund, lender or owner</span></a>
        <a href="#verify" className="doc-card"><span className="label">Check</span><strong>Verify it yourself</strong><span className="muted">No trust in this page needed</span></a>
      </div>
    </Section>
  );
}

function QuickStart() {
  const [role, setRole] = useState<"fund" | "lender" | "auditor" | "owner">("fund");
  const steps = {
    fund: [
      { title: "Apply to join", body: "From the Panel page, apply with your wallet and a 0.05 NEAR bond, returned whatever the outcome. You can name an auditor at the same time." },
      { title: "Connect your wallet", body: "Meteor, MyNearWallet or HERE. Nema never sees your keys; your wallet signs each call." },
      { title: "Mark an open round", body: "Enter your price in points of par (for example 94.25). It's encrypted in your browser to the round's key before it leaves." },
      { title: "Replace it if you need to", body: "Until the deadline, a new mark replaces the old one. Tick “keep on this device” to see where you stood later." },
      { title: "Read the result, free", body: "If your mark counted, open one copy of the consensus without paying the read price (only the enclave fee and storage), and see where your price sat." },
      { title: "Collect your share", body: "Each paid read of a round you marked pays you an equal share. Withdraw from the Vault whenever you like." },
      { title: "See your track record", body: "Your Vault charts every kept mark against the consensus you read: how often you sat within one spread, your average gap, and whether you lean above or below the panel. Only you and your auditor can see it." },
    ],
    lender: [
      { title: "Connect your wallet", body: "Any NEAR account can buy a read." },
      { title: "Pick a published round", body: "Published rounds show how many funds counted and a commitment, not the numbers." },
      { title: "Buy a read", body: <>You pay the read price plus {near(READ_EXTRA_YOCTO)} for the enclave and the record's storage. The result is sealed to a key made in your browser.</> },
      { title: "Back up your key", body: "Download the key backup from the Vault. Without it you can't open your reads on another device." },
      { title: "Open and check", body: "Your copy opens in the browser and is checked against the on-chain commitment automatically." },
      { title: "Size the loan", body: "Under the result, the borrowing-base tool values the loan at the lower of the fund's own price and the consensus less one spread." },
      { title: "Watch the whole book", body: "The Portfolio page totals the borrowing base across every loan you've read and flags prices that fell since your last read. Export it as CSV, or print it to PDF, with the commitment and salt so others can check each result." },
    ],
    auditor: [
      { title: "Get named", body: "A fund names you as its auditor when it applies, or later from its Vault. Only that fund can name or remove you." },
      { title: "Open what it sent", body: <>On the Audit page, ask the enclave to open one of your client's marks once the round stops taking marks ({near(READ_EXTRA_YOCTO)}). It arrives sealed to your key: exactly what the fund submitted, not a copy it could edit.</> },
      { title: "Test it against the consensus", body: "Rounds your client counted in are free for you to read. The gap shows in standard deviations." },
      { title: "Follow the record", body: "Above the rounds, each client's track record charts every opened mark against the consensus, with its average gap and which way it leans." },
    ],
    owner: [
      { title: "Admit funds", body: "Approve applications, or add funds directly, on the Panel page. A round with fewer than four valid marks publishes nothing." },
      { title: "Open a round", body: <>Name the loan and how long it stays open. Opening costs {near(ENCLAVE_FEE_YOCTO)} for the enclave to make the round's key.</> },
      { title: "Set the read price", body: "Buyers pay it per read; it's split equally among the funds whose marks counted." },
      { title: "Let it close", body: "After the deadline anyone can close the round. You don't hold any key that opens marks." },
    ],
  };
  return (
    <Section id="quick-start" eyebrow="Start here" title={<>Quick <em>start</em></>}>
      <p className="muted" style={{ marginBottom: 16 }}>Pick the role you're here as.</p>
      <div className="seg" role="tablist" aria-label="Choose your role">
        {(["fund", "lender", "auditor", "owner"] as const).map((r) => (
          <button key={r} role="tab" aria-selected={role === r} aria-pressed={role === r} onClick={() => setRole(r)}>
            {r[0].toUpperCase() + r.slice(1)}
          </button>
        ))}
      </div>
      <Steps items={steps[role]} />
      {role === "lender" && (
        <Callout tone="warn" title="Your key is your access">
          Reads are sealed to a key stored in this browser. Clearing site data without a backup means losing access to reads you paid for.
        </Callout>
      )}
    </Section>
  );
}

function RoundsSection() {
  const states = [
    { name: "Preparing key", tone: "tone-busy", body: "The owner opened the round; the enclave is deriving its public key." },
    { name: "Open", tone: "tone-open", body: "Panel funds submit sealed marks until the deadline." },
    { name: "Tallying", tone: "tone-busy", body: "Someone closed the round. The contract froze the set of submissions and asked the enclave to tally it." },
    { name: "Published", tone: "tone-pub", body: "The count, any dropped submissions and a commitment are on chain. Reads can be bought." },
    { name: "Close failed", tone: "tone-bad", body: "The enclave didn't answer usefully. Anyone can retry the close." },
    { name: "Did not publish", tone: "tone-bad", body: "Too few valid marks, or no key. Nothing is revealed, ever." },
  ];
  return (
    <Section id="rounds" eyebrow="Understand" title={<>How a round <em>works</em></>}>
      <p>Every loan is priced in its own round. A round moves through these states:</p>
      <dl className="states">
        {states.map((s) => (
          <div key={s.name}>
            <dt><span className={`pill ${s.tone}`}><span className="d" />{s.name}</span></dt>
            <dd className="muted">{s.body}</dd>
          </div>
        ))}
      </dl>
      <Callout title="Nothing gets stuck">
        If the enclave fails during a close, the round can be closed again. If it fails while sealing a read, the read price goes back to the buyer.
        If it never answers at all, anyone can settle the call 30 minutes later with the Settle button: the close can be retried, the read is
        refunded, the audit can be asked again.
      </Callout>
      <p>
        Marks are integers in hundredths of a point, from 0 to 200.00. The enclave drops out-of-range, undecryptable and copied submissions and
        names them, so one bad fund can't spoil a round. The result is the mean and one standard deviation, computed exactly with integers.
      </p>
    </Section>
  );
}

function WhoSees() {
  return (
    <Section id="who-sees-what" eyebrow="Understand" title={<>Who sees <em>what</em></>}>
      <div className="table" role="table" aria-label="Who sees what">
        <div className="tr th" role="row"><span role="columnheader">Party</span><span role="columnheader">Can see</span><span role="columnheader">Can't see</span></div>
        {WHO_SEES_WHAT.map((w) => (
          <div className="tr" role="row" key={w.party}>
            <span role="cell" className="serif party">{w.party}</span>
            <span role="cell">{w.sees}</span>
            <span role="cell" className="muted">{w.not}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Trust() {
  return (
    <Section id="trust" eyebrow="Understand" title={<>What you're <em>trusting</em></>}>
      <ul className="trust">{TRUST.map((t) => <li key={t}>{t}</li>)}</ul>
    </Section>
  );
}

function Verify() {
  return (
    <Section id="verify" eyebrow="Verify" title={<>Verify it <em>yourself</em></>}>
      <p>You don't have to trust this page. Each check below can be repeated from public data.</p>
      <h3>The contract is the published build</h3>
      <p className="muted">
        NEAR reports the sha256 of every contract's code. Compare it with the build we publish (this page also checks it live, in the “Live from chain” panel).
      </p>
      <Copy text={BUILDS.contractWasmSha256}>{short(BUILDS.contractWasmSha256, 12)}</Copy>
      <h3>The enclave tallied what was submitted</h3>
      <p className="muted">
        At the deadline the contract fixes a set hash over the submissions. Every round's Verify view recomputes it in your browser from the
        ciphertexts on chain:
      </p>
      <pre className="code">{`sha256( for each submission, sorted by account:
          u32le(len(account)) || account || sha256(ciphertext_hex) )`}</pre>
      <h3>Your result is the published one</h3>
      <p className="muted">
        A published round carries a commitment. Your sealed copy includes a salt; the app recomputes the commitment and shows whether it matches:
      </p>
      <pre className="code">{`sha256( "nema/commit/v1" || u32le(len(contract)) || contract
        || u64le(round_id) || salt || "count|mean|spread" )`}</pre>
      <Callout title="Why the salt">
        There are few plausible mean and spread pairs. Without a salt, anyone could try them all against the commitment and learn the result for free.
      </Callout>
      <h3>The enclave build</h3>
      <Copy text={BUILDS.enclaveWasmSha256}>{short(BUILDS.enclaveWasmSha256, 12)}</Copy>
      <p className="muted" style={{ marginTop: 8 }}>
        The master secret is generated inside the enclave and locked to this build hash and to the contract account.
      </p>
      <h3>Every enclave run carries Intel's proof</h3>
      <p className="muted">
        OutLayer attaches an Intel TDX quote to each run. A round's Verify view fetches the quote for its key, its tally and your own copies,
        and checks it in your browser, with nothing taken on trust from OutLayer's API:
      </p>
      <ol className="steps-plain">
        <li><strong>Signed by Intel.</strong> The certificate chain ends at Intel's SGX root key (pinned in the page), and each link signs the next, down to the quote.</li>
        <li><strong>The quote vouches for this run.</strong> Its report data is the task hash over the run's code hash, input hash, output hash, caller, project and time.</li>
        <li><strong>An approved worker image.</strong> The quote's five measurements are on OutLayer's approved list in <code>{NET.register}</code>.</li>
        <li><strong>Nema's enclave build ran.</strong> The code hash is the build above, in the project <code>{BUILDS.enclaveProject}</code>.</li>
        <li><strong>Nema's contract asked for it.</strong> The request in the transaction came from <code>{CONFIG.contract}</code>, and its input hashes to the attested input hash.</li>
        <li><strong>Its result is on chain.</strong> The output hashes to the attested output hash and matches the round key, commitment or sealed copy the contract stored.</li>
      </ol>
      <p className="muted">
        The browser doesn't check Intel's TCB status or revocation lists for the machine; OutLayer's dashboard does, and each run links to it.
        The same checks run from the command line with <code>pnpm live:check-attest --job &lt;id&gt;</code>.
      </p>
    </Section>
  );
}

function ContractRef() {
  const fee = near(ENCLAVE_FEE_YOCTO);
  const read = near(READ_EXTRA_YOCTO);
  const calls = [
    { m: "submit(round_id, ciphertext_hex)", who: "Panel fund", cost: "0.03 NEAR for storage; the unused part comes back" },
    { m: "buy_read(round_id, buyer_pubkey)", who: "Anyone", cost: `Read price + ${read} (enclave + storage)` },
    { m: "claim_read(round_id, buyer_pubkey)", who: "Counted funds, and auditors named before the deadline; once per round", cost: read },
    { m: "request_audit(round_id, fund, auditor_pubkey)", who: "The auditor that fund named, after the deadline", cost: read },
    { m: "apply(auditor?, note?) · withdraw_application()", who: "Anyone not on the panel", cost: "0.05 NEAR bond, returned" },
    { m: "set_auditor(auditor | null)", who: "A panel fund, for itself", cost: "Gas only" },
    { m: "close_round(round_id)", who: "Anyone, after the deadline", cost: `${fee}, returned if too few marks` },
    { m: "withdraw()", who: "Funds with earnings", cost: "Gas only; put back if the transfer fails" },
    {
      m: "reconcile_round(round_id) · reconcile_read(purchase_id) · reconcile_audit(audit_id)",
      who: "Anyone, 30 minutes after the enclave call",
      cost: "Gas only; a read's price goes back",
    },
    { m: "open_round(loan, closes_at)", who: "Owner", cost: fee },
    { m: "approve(account) · reject(account)", who: "Owner", cost: "Gas only; the bond goes back" },
    { m: "add_member(account) · remove_member(account)", who: "Owner", cost: "Gas only" },
    { m: "set_read_price(read_price)", who: "Owner", cost: "Gas only" },
  ];
  const views = [
    "get_config", "get_members", "get_rounds", "get_round", "get_submissions", "get_purchase", "get_purchases_of", "get_earnings",
    "get_applications", "get_auditor", "get_appointment", "get_clients_of", "get_audits_of", "get_free_basis", "get_pending_since", "get_audit",
  ];
  return (
    <Section id="contract" eyebrow="Reference" title={<>Contract <em>methods</em></>}>
      <p>
        Contract <Copy text={CONFIG.contract} /> on NEAR {CONFIG.network}.
      </p>
      <div className="table ref" role="table" aria-label="Contract calls">
        <div className="tr th" role="row"><span role="columnheader">Call</span><span role="columnheader">Who</span><span role="columnheader">Attach</span></div>
        {calls.map((c) => (
          <div className="tr" role="row" key={c.m}>
            <span role="cell" className="mono">{c.m}</span>
            <span role="cell">{c.who}</span>
            <span role="cell" className="muted">{c.cost}</span>
          </div>
        ))}
      </div>
      <h3>Views</h3>
      <p className="mono">{views.join(" · ")}</p>
    </Section>
  );
}

function EnclaveRef() {
  return (
    <Section id="enclave" eyebrow="Reference" title={<>Enclave <em>interface</em></>}>
      <p className="muted">
        Project <Copy text={BUILDS.enclaveProject} />. Only the round's contract may call it: the module refuses any request whose{" "}
        <code>contract</code> isn't the caller.
      </p>
      <pre className="code">{`derive_pubkey  in   {"action":"derive_pubkey","contract","round_id"}
               out  {"ok":true,"pubkey":"<compressed secp256k1, hex>"}

tally          in   {"action":"tally","contract","round_id","min_contributors",
                     "set_hash","submissions":[{"account","ciphertext_hex"}]}
               out  {"ok":true,"count","rejected":[{"account","reason"}],
                     "set_hash","commitment"}

deliver        in   tally's fields + "commitment","buyer_pubkey"
               out  {"ok":true,"set_hash","commitment","sealed":"<hex>"}

audit          in   {"action":"audit","contract","round_id","account",
                     "ciphertext_hex","auditor_pubkey"}
               out  {"ok":true,"sealed":"<hex>"}`}</pre>
      <p className="muted">
        A fund encrypts <code>{`{"account","mark"}`}</code>; a buyer opens <code>{`{"count","mean","spread","salt"}`}</code>; an auditor opens{" "}
        <code>{`{"kind":"audit","account","round_id","mark"}`}</code>. The contract asks for an audit only on behalf of the auditor that fund named. ECIES on secp256k1 with
        HKDF-SHA256 and AES-256-GCM.
      </p>
    </Section>
  );
}

function Faq() {
  return (
    <Section id="faq" eyebrow="Reference" title={<>Fair <em>questions</em></>}>
      <div className="faq">
        {FAQ.map((f) => (
          <details key={f.q}>
            <summary>{f.q}<span aria-hidden="true">+</span></summary>
            <p>{f.a}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}

function LiveRail() {
  const { rounds, members, link, demoMode } = useChain();
  const [codeHash, setCodeHash] = useState<string | null | undefined>();
  useEffect(() => {
    viewAccount(CONFIG.contract).then((a) => setCodeHash(base58ToHex(a.code_hash)), () => setCodeHash(null));
  }, []);
  const ciphertexts = useMemo(() => rounds.reduce((n, r) => n + r.submitted.length, 0), [rounds]);
  const match = codeHash === BUILDS.contractWasmSha256;

  return (
    <aside className="docs-rail" aria-label="Live from the chain">
      <div className="label">{demoMode ? "Sample data" : link === "live" ? "Live from chain" : "Chain"}</div>
      <div className="rail-row">
        <span className="dot" style={codeHash && !match ? { background: "var(--rose-ink)" } : codeHash === undefined ? { background: "var(--faint)" } : undefined} />
        <span>{codeHash === undefined ? "Checking contract code…" : codeHash === null ? "Couldn't read contract code" : match ? "Contract matches the published build" : "Contract differs from the published build"}</span>
      </div>
      <dl>
        <div><dt>Encrypted marks stored</dt><dd>{ciphertexts}</dd></div>
        <div><dt>Marks in the clear</dt><dd>0</dd></div>
        <div><dt>Results in the clear</dt><dd>0</dd></div>
        <div><dt>Rounds</dt><dd>{rounds.length}</dd></div>
        <div><dt>Panel funds</dt><dd>{members.length}</dd></div>
      </dl>
      <a href={`${CONFIG.explorerAccount}${CONFIG.contract}`} target="_blank" rel="noreferrer" className="hint">Contract on explorer ↗</a>
    </aside>
  );
}
