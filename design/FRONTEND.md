# Nema frontend plan

Style: `design/mockup.html` (linen, sage, forest; Instrument Serif, Inter,
JetBrains Mono). Visual inspiration: Kombai gallery. All code written fresh.

## Pages

| Page | Route | Who | What's on it |
| --- | --- | --- | --- |
| Home | `/` | everyone | Hero, live stats, the three steps, what's public and what isn't, FAQ |
| Rounds | `/rounds` | everyone | Numbered list of rounds, status pill, countdown, filter by status |
| Round | `/rounds/:id` | everyone | Panel ring, state card, Fund / Lender / Verify switch |
| Vault | `/vault` | signed in | Earnings and withdraw, reads, track record; reading key and auditor under Settings |
| Panel | `/panel` | owner (read-only for others) | Members, open a round, read price |
| Docs | `/docs` | everyone | Quick start per role, round lifecycle, who sees what, trust model, verify-it-yourself, contract and enclave reference, FAQ |

## Elements, by page

Shell
- Floating pill nav; menu sheet on phones
- Testnet banner
- Live dot: polls the RPC; turns grey when it can't reach it
- Offline banner with retry when RPC calls fail
- Wallet button: picker (Meteor, MyNearWallet, HERE), account menu, sign out
- Toasts for every transaction: sent, confirmed, failed with a readable reason

Home
- Live stats: rounds published, funds on the panel, read price
- An animated scatter showing several private prices settling into one sealed band
- Three steps (seal, tally, deliver) on the forest band
- "Who sees what" summary linking to Docs
- FAQ: can the owner read marks, what if a fund lies, what if the enclave fails

Rounds
- Rows: number, loan (borrower, facility, maturity), countdown or status, funds count
- Status pills for every round state: awaiting key, open, closing, close failed, published, failed
- Empty state when there are no rounds

Round
- Header: loan details, status, countdown to the deadline
- Panel ring: submissions so far against the floor of 4
- Fund view: mark input in price points, "encrypted in your browser" step, submitted state that
  can be replaced until the deadline, option to keep your own mark on this device
- Lender view: fee breakdown before paying (share per fund, owner remainder, 0.01 NEAR enclave fee),
  then pending, delivered, opened; refunded state with the reason
- Opened result: mean with ± spread, a gauge on a par scale, change since the last round of the same
  loan, and a "matches the on-chain commitment" check
- Where you stand (fund who also opened the result): its own mark against the consensus in σ
- Verify view: set hash recomputed in the browser, commitment, rejected accounts with reasons,
  transaction links to the explorer
- Close button for anyone after the deadline; retry when the close failed

Vault
- Earnings and withdraw with a confirm step
- Reads bought: reopen any sealed result with the key on this device
- Settings (collapsed): key backup download and restore, and the fund's auditor
- Track record (own vault only): every round marked, with kept mark, consensus and gap;
  rounds within one spread, average gap in σ, lean in points; a gap chart with the
  one-spread band

Portfolio (`/portfolio`, in the nav when signed in)
- Per loan: latest consensus, change since the previous read (flagged when it falls a
  point or more than one spread), price used and borrowing base, editable face, price
  and advance rate kept on the device; totals; CSV export and print to PDF

Audit (`/audit`, in the nav only for an account some fund named)
- Per client fund: each round it marked, "Open what it sent" (enclave audit), the
  opened mark against the consensus with the gap in σ and a gauge
- The client's track record above its rounds, from the marks the enclave opened

Panel
- Applications waiting, with Admit / Turn away (owner); an Apply form with auditor
  and note for anyone not on the panel, or their pending application to withdraw
- Members list, add and remove (owner only)
- Open a round: borrower, facility, maturity, duration; warning when fewer than 4 funds are members
- Read price setting

Docs (replaces the earlier How it works page; `/how` redirects here)
- Three columns: section nav with a filter (Ctrl K), the article, and a live rail (contract code
  hash match, ciphertexts stored, plain marks and results on chain: 0). On phones the nav becomes a
  sticky "Jump to" select and the rail sits above the article.
- Sections: Overview, Quick start (fund / lender / owner tabs), How a round works (every status),
  Who sees what, Trust model, Verify it yourself (code hash, set hash and commitment formulas),
  Contract methods (who can call, what to attach), Enclave interface, FAQ
- Previous / next section at the foot; every heading has an anchor link

## Data

- Views over JSON-RPC (`query` / `call_function`) against `nema-dev.testnet`; no SDK needed for reads.
- Signing through NEAR Wallet Selector.
- Loan details go into the round's `loan` string as JSON `{"borrower","facility","maturity"}`;
  plain strings still display.
- Demo data mode (`?demo=1`) fills every state while testnet FastFS is down.
