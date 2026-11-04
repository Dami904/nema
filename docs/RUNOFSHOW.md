# Demo run-of-show

Three minutes, live. The one moment to land: **the chain proves a price exists
and is fixed, yet nobody can see it, not even the person who closed the round.**

## Before going live

- [ ] [nema-near.vercel.app](https://nema-near.vercel.app) loads, **Live** shows round 02 as Published.
- [ ] A second tab on round 02 → **Verify**, already scrolled to the enclave runs.
- [ ] A terminal in `web/` with `pnpm install` done, and this command typed but not run:
      `pnpm live:check-attest --job 16947 --network testnet --contract nema-dev.testnet`
- [ ] Sample mode works offline-from-chain: open `?demo=1` once so it is cached.
- [ ] Screen recording of the full run as a fallback (see Contingencies).

## Script

| Time | Do | Say |
| --- | --- | --- |
| 0:00 | Landing page | "Private loans rarely trade, so every fund marks its own. Lenders taking them as collateral have to trust one number. Funds would compare, if it didn't mean showing their book." |
| 0:20 | **Rounds** → round 02 | "Four funds priced this loan. Each mark was sealed in the browser to a key only an enclave holds." |
| 0:35 | **Verify** tab: set hash on chain vs recomputed | "The chain stores ciphertext and commits to the exact set at the deadline. My browser recomputes it: same hash." |
| 0:55 | Point at `count 4` and `commitment`, no mean | **The moment.** "The enclave published how many counted and a commitment. No mean, no spread, anywhere on chain." |
| 1:15 | Scroll to the enclave runs, each ✓ | "Every run is checked here against Intel's quote: right hardware, right build hash, asked for by this contract." |
| 1:35 | Terminal: run `check-attest` | "Same check from a terminal, including tampered copies that must fail." |
| 1:55 | **Sample** → **Lender** → round 02 opened | "A lender pays 0.1 NEAR. The enclave seals the result to the lender's key alone, and the browser checks it against that commitment." |
| 2:15 | **Vault** as fund1 | "That fee is split among the funds whose marks counted. Contributing pays." |
| 2:30 | **Audit** as auditor | "A fund's auditor sees exactly what the fund sent, not a copy it could edit." |
| 2:45 | Back to landing | "Funds seal. The enclave counts. NEAR keeps the receipts." |

## Contingencies

**Wi-Fi drops.** Switch to **Sample** mode: every screen still works without the
chain. Say "this is sample data; the live round is the same flow" and continue
from 1:55. Skip the terminal step.

**The live app won't load.** Run it locally: `pnpm dev` in `web/`, open
`http://localhost:5179/?demo=1`. If that fails too, play the recording from the
current step.

**The RPC is slow and Live shows "offline".** It retries every 15 seconds. Keep
talking over the Verify step from the second tab, which already loaded.

**`check-attest` hangs or errors.** Ctrl+C. Say "the same five checks ran in the
browser a moment ago" and point back at the ✓ marks. Don't debug on stage.

**A wallet prompt appears.** Nothing in this script signs. Cancel it.

**Asked "what if the owner redeploys?"** Answer straight: today the owner key
could, and that is the top item in [THREAT_MODEL.md](THREAT_MODEL.md); removing
the key after the final deploy closes it.
