import { Link, useNavigate } from "react-router-dom";
import { Hills, Skeleton } from "../components/bits";
import { useChain } from "../lib/chain";
import { near } from "../lib/format";
import { FAQ, WHO_SEES_WHAT } from "../lib/content";
import "./Home.css";

export default function Home() {
  const { rounds, members, config, link, setDemoMode } = useChain();
  const published = rounds.filter((r) => r.status === "Published").length;
  const open = rounds.filter((r) => r.status === "Open").length;
  const loading = link === "loading";
  const go = useNavigate();
  const sample = (to: string) => {
    setDemoMode(true);
    go(to);
  };

  return (
    <div className="display">
      <div className="wrap">
        <section className="hero">
          <div className="fadein">
            <span className="eyebrow">Private marks for private loans</span>
            <h1>
              Agree on a price.
              <br />
              <em>Reveal nothing.</em>
            </h1>
            <p className="lede">
              Funds submit their marks sealed. An enclave finds the consensus. Lenders pay to read it, and the fee goes back to the funds
              that made it.
            </p>
            <div className="cta">
              <Link className="btn" to="/rounds">Browse rounds →</Link>
              <Link className="btn ghost" to="/docs">Read the docs</Link>
            </div>
          </div>
          <Hills>
            <Scatter />
          </Hills>
        </section>

        <section className="built-on" aria-label="Built on">
          <span className="label">Built on</span>
          <span>NEAR Protocol</span>
          <span>OutLayer enclaves</span>
          <span>Intel TDX</span>
          <span>ECIES in the browser</span>
        </section>

        <section className="stats-row" aria-label="Live from the contract">
          <Stat label="Rounds published" value={loading ? null : String(published)} note={open ? `${open} open now` : "none open right now"} />
          <Stat label="Funds on the panel" value={loading ? null : String(members.length)} note={`a round needs ${config?.min_contributors ?? 4}`} />
          <Stat label="Price of a read" value={loading || !config ? null : near(config.read_price)} note="shared by the funds who marked it" />
        </section>
      </div>

      <section className="method">
        <div className="wrap">
          <div className="eyebrow" style={{ textAlign: "center" }}>The method</div>
          <h2>Three quiet steps</h2>
          <p className="sub">No fund sees another's number. Nobody sees the result without paying for it.</p>
          <svg viewBox="0 0 1000 90" className="path" aria-hidden="true">
            <path d="M40 70 C200 -10 330 110 500 45 S800 0 960 55" fill="none" stroke="#6e8f7e" strokeWidth="1.5" strokeDasharray="3 6" />
            <circle cx="40" cy="70" r="5" fill="#b5764f" />
            <circle cx="500" cy="45" r="5" fill="#6e8f7e" />
            <circle cx="960" cy="55" r="5" fill="#6e8f7e" />
          </svg>
          <ol className="steps">
            <li>
              <div className="n">01</div>
              <h3>Seal</h3>
              <p>Each fund encrypts its mark in the browser to the round's key. Only the enclave can open it.</p>
            </li>
            <li>
              <div className="n">02</div>
              <h3>Tally</h3>
              <p>At the deadline the enclave counts, averages and measures the spread. The chain gets a count and a commitment, never the numbers.</p>
            </li>
            <li>
              <div className="n">03</div>
              <h3>Deliver</h3>
              <p>A lender pays and receives the result sealed to their own key, with a salt to check it against the chain.</p>
            </li>
          </ol>
        </div>
      </section>

      <div className="wrap">
        <section className="section">
          <div className="section-head">
            <div>
              <div className="eyebrow">What you can do</div>
              <h2>One price, <em>three uses</em></h2>
            </div>
          </div>
          <div className="uses">
            <button className="use" onClick={() => sample("/rounds/2?view=verify")}>
              <UseArt kind="proof" />
              <div className="label">Anyone</div>
              <h3>Check the enclave yourself</h3>
              <p>Every tally carries Intel's signed quote. Your browser checks it against the chain, not against our word.</p>
              <span className="go">See a proof →</span>
            </button>
            <button className="use" onClick={() => sample("/portfolio")}>
              <UseArt kind="book" />
              <div className="label">Lenders</div>
              <h3>Lend against a fair price</h3>
              <p>Open the consensus, size the borrowing base, watch the whole book for falls and export it for your files.</p>
              <span className="go">See a portfolio →</span>
            </button>
            <button className="use" onClick={() => sample("/vault")}>
              <UseArt kind="record" />
              <div className="label">Funds and auditors</div>
              <h3>Know where your marks sit</h3>
              <p>Earn a share of every read, and see each mark against the panel. Only you and your auditor can.</p>
              <span className="go">See a track record →</span>
            </button>
          </div>
        </section>

        <section className="section">
          <div className="section-head">
            <div>
              <div className="eyebrow">Who sees what</div>
              <h2>Private by <em>default</em></h2>
            </div>
            <Link className="btn ghost" to="/docs#who-sees-what">The full picture</Link>
          </div>
          <div className="who">
            {WHO_SEES_WHAT.slice(0, 4).map((w) => (
              <div className="card" key={w.party}>
                <div className="label">{w.party}</div>
                <p className="who-sees">{w.sees}</p>
                <p className="hint">Can't see: {w.not}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="section">
          <div className="section-head">
            <div>
              <div className="eyebrow">Questions</div>
              <h2>Fair <em>questions</em></h2>
            </div>
            <Link className="btn ghost" to="/docs#faq">All questions</Link>
          </div>
          <div className="faq">
            {FAQ.slice(0, 5).map((f) => (
              <details key={f.q}>
                <summary>
                  {f.q}
                  <span aria-hidden="true">+</span>
                </summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="closer">
          <div>
            <h2>See a round <em>from every side</em></h2>
            <p>The sample data plays a fund, a lender, an auditor and the owner. No wallet needed.</p>
          </div>
          <div className="cta">
            <button className="btn light" onClick={() => sample("/rounds")}>Try it with sample data</button>
            <Link className="btn ghost dark" to="/docs">Read the docs</Link>
          </div>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string | null; note: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      {value === null ? <Skeleton h={40} w={90} /> : <b>{value}</b>}
      <small>{note}</small>
    </div>
  );
}

/** Small drawings for the three uses. */
function UseArt({ kind }: { kind: "proof" | "book" | "record" }) {
  return (
    <svg viewBox="0 0 160 70" className="use-art" aria-hidden="true">
      {kind === "proof" && (
        <>
          <rect x="44" y="8" width="72" height="54" rx="12" fill="#dce5df" />
          <path d="M66 36l10 10 20-22" fill="none" stroke="#2f5242" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {kind === "book" &&
        [30, 44, 22, 52, 38].map((h, i) => <rect key={i} x={30 + i * 22} y={62 - h} width="14" height={h} rx="4" fill={i === 3 ? "#b5764f" : "#afc4b8"} />)}
      {kind === "record" && (
        <>
          <rect x="10" y="24" width="140" height="22" rx="11" fill="#dce5df" />
          <line x1="10" x2="150" y1="35" y2="35" stroke="#1e2b25" strokeWidth="1" />
          {[[30, 30], [62, 40], [94, 28], [126, 56]].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="5" fill={i === 3 ? "#b5764f" : "#2f5242"} />
          ))}
        </>
      )}
    </svg>
  );
}

/** Five private prices drifting into one sealed band. */
function Scatter() {
  const dots = [
    { x: 60, y: 70 },
    { x: 130, y: 150 },
    { x: 205, y: 55 },
    { x: 265, y: 165 },
    { x: 335, y: 95 },
  ];
  return (
    <div className="scatter">
      <svg viewBox="0 0 400 230" aria-hidden="true">
        <rect x="140" y="99" width="120" height="24" rx="12" fill="#fbf9f4" className="band" />
        {dots.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="6" fill="#1e2b25" opacity="0.85">
            <animate attributeName="cx" values={`${p.x};${p.x};${180 + i * 10};${180 + i * 10};${p.x}`} keyTimes="0;0.15;0.5;0.75;1" dur="7s" repeatCount="indefinite" />
            <animate attributeName="cy" values={`${p.y};${p.y};111;111;${p.y}`} keyTimes="0;0.15;0.5;0.75;1" dur="7s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.85;0.85;0.2;0.2;0.85" keyTimes="0;0.15;0.5;0.75;1" dur="7s" repeatCount="indefinite" />
          </circle>
        ))}
      </svg>
      <div className="sealchip">
        <div>
          <div className="label">Consensus</div>
          <div className="blurnum serif" style={{ fontSize: 34, lineHeight: 1, marginTop: 8 }}>94.10</div>
        </div>
        <span className="pill tone-pub">Sealed</span>
      </div>
    </div>
  );
}
