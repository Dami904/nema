# Nema

Quiet consensus. Funds agree on a price without showing each other their numbers.

> Status: live on NEAR testnet and run end to end. The contract
> (sha256 `1820d211…bfa2`) is live on `nema-dev.testnet` with 4 panel funds, and
> the enclave (sha256 `3ed58517…50d6`, the
> [`enclave-v2`](https://github.com/Dami904/nema/releases/tag/enclave-v2) release
> of this repository) is the active version of the OutLayer project
> `nema-dev.testnet/nema-aggregator`. Round 2 ran in full on 2026-11-03: four
> sealed marks, the enclave tally, a free copy for a fund, a paid read for a
> lender with the fee split four ways, and an audit, all 17 smoke checks passing.

## The problem

Private loans rarely trade, so every fund prices its own holdings. Two funds can
carry the same loan at different marks, and a lender has to trust whichever
number it is given. Funds would compare notes if it did not mean showing their
book to competitors.

## What Nema does

Each fund submits its private mark encrypted. A hash-pinned module running in a
hardware enclave decrypts the marks and computes the count, mean and spread. The
chain shows only how many funds took part and a commitment to the result. A
lender pays to read it, and the enclave encrypts the result to that lender's key
alone. The fee is shared among the funds that contributed, and those funds read
the result for free. No single price is ever revealed, and the consensus is not
public either.

Funds join by applying; the owner admits or turns them away. A fund can name an
auditor, who can have the enclave open that fund's own marks (exactly as
submitted, not a copy the fund could edit) and test them against the consensus.

## What exists today

| Part | State |
| --- | --- |
| `aggregator/` enclave module (round keys, decrypt, tally, sealed delivery, audit) | Written, 32 tests passing, builds to `wasm32-wasip2` (about 461 KB, sha256 `3ed58517…50d6` with Rust 1.96; the same bytes from a fresh clone) |
| `contract/` NEAR contract (members, applications, rounds, committed set, listings, paid and free reads, audits, refunds, earnings, state migration) | Written, 82 unit tests passing. Live on `nema-dev.testnet` (sha256 `1820d211…bfa2`) with 4 panel funds |
| `interop/` browser encryption (eciesjs) against the enclave | Verified in both directions |
| OutLayer testnet | Project `nema-dev.testnet/nema-aggregator` runs the enclave from this repository's `enclave-v2` release, checked by hash. The master secret is generated inside OutLayer's TEE and released only to `nema-dev.testnet` running that exact hash |
| `web/` app (Vite, React) | Seven pages on the live contract (including Docs and an auditor's desk), sample data for every state, wallet sign-in (Meteor, MyNearWallet, HERE), marks sealed in the browser, reads opened with a key kept on the device, a borrowing-base tool and price history per loan |
| Lender portfolio and export | `/portfolio` totals the borrowing base across every loan an account has opened, flags prices that fell since the last read, and exports CSV or prints to PDF. Each round's result exports as CSV with the salt and commitment, so the file can be checked without the app. Inputs stay on the device |
| Fund track record | A fund's Vault charts each of its marks against the consensus, round by round: how often it sat within one spread, its average gap and its lean. The fund sees it from marks kept on its device; its auditor sees the same from marks the enclave opened for it. No one else can |
| Enclave proofs | Each round's Verify view fetches OutLayer's Intel TDX quote for every enclave run behind it and checks it in the browser: Intel's certificate chain to a pinned root, the task hash in the quote, the worker image on OutLayer's approved list, Nema's build hash, the requesting contract and the result on chain. `npm run check-attest` runs the same checks on any OutLayer job; tested on real mainnet and testnet runs |
| `web/scripts/` | `npm run smoke` runs one full round on the live network and checks it end to end (passed on round 2); `npm run close-rounds` closes rounds past their deadline |

## Try it in two minutes

No wallet needed. Open the hosted app at **https://nema-near.vercel.app** or run
it locally (below), then:

1. Click **Sample** in the switch at the top right (or **Try it with sample data**
   on the home page). The persona menu next to it
   now picks who you are.
2. As **Fund · fund1**, open **Vault**. You see your earnings, the reads you got for
   free and your track record: each mark against the consensus, 3 of 4 within one
   spread, with round 8 flagged outside the band.
3. Open **Rounds**, then a published round (Calder Logistics, round 02), and its
   **Verify** tab. The set hash and commitment are recomputed in your browser, and
   the enclave proof panel lists each enclave run with its checks.
4. Switch to **Lender**. On the same round you see the opened consensus, the
   borrowing-base tool and **Download valuation (CSV)**. **Portfolio** totals the
   book and flags Kestrel Software, whose price fell.
5. Switch to **Auditor** and open **Audit**. You see fund1's marks, as the enclave
   opened them, against the consensus, with the same track record.
6. Click **Live** to read the real contract on NEAR testnet.

## Run the tests

```
cd aggregator
cargo test
```

Build the enclave module, from the repository root (this is the same command
OutLayer runs when it builds the enclave from this repository):

```
rustup target add wasm32-wasip2
cargo build --target wasm32-wasip2 --release
# target/wasm32-wasip2/release/nema-aggregator.wasm
```

Run the contract tests, and build the contract (Rust 1.93 or newer):

```
cd contract
cargo test
bash build.sh
```

Run the web app (Node 22.18 or newer):

```
cd web
npm install
npm run dev     # http://localhost:5179, add ?demo=1 for sample data
npm test        # browser hashes and sealing against the shared and Rust vectors
```

Run one real round on testnet and check it (signs with NEAR CLI from the OS
keychain; costs about 0.06 NEAR in enclave fees, 0.06 NEAR in storage deposits
and one read price):

```
npm run smoke -- --owner nema-dev.testnet --lender lender.nema-dev.testnet --minutes 4
```

## Design rules

- Integer arithmetic only, so the mean and spread are exact.
- A round publishes nothing below 4 valid contributors, because a mean and spread
  over three or fewer funds can reveal individual prices.
- Only the round's contract can ask the enclave to tally or deliver, and only for
  the submission set it committed to at the deadline.
- Out-of-range, undecryptable and copied submissions are dropped and named, so one
  bad fund cannot veto a round.
- A failed enclave call never strands a round or a payment: closes can be retried
  and purchases are refunded.

More in [DESIGN.md](DESIGN.md).

## Trust model (to be stated in full before submission)

- Privacy rests on the enclave hardware and its operator, not on a threshold of
  independent nodes.
- A buyer who opens the result can share it.
- The buyer's reading key lives in that browser's local storage. Anything that can
  read the page's storage (an extension, someone at the machine) can open that
  buyer's reads. The app offers a backup file; losing both means losing access.
- A fund can still lie inside the valid range. Only out-of-range values are caught.

## Hosting

The web app is a static site, hosted on Vercel at https://nema-near.vercel.app;
the contract and the enclave run on NEAR and OutLayer, so there is no server. To
host your own copy, import the repo into Vercel and set the root directory to
`web`. `web/vercel.json` sets the build and sends every path to the app.

No environment variables are needed for testnet. To point at another contract or
network, set the `VITE_*` values from `web/.env.example`; they end up in the
browser bundle, so put nothing secret there.

## How it was built

All code in this repo was written during the hackathon, starting 2026-11-02, so
there is no earlier baseline.

AI-assisted: the code, tests and docs were written with Claude Code (Anthropic)
pair-programming under the author's direction, across the contract, the enclave
module, the web app and the scripts. The author chose the design, reviewed the
changes and ran the deployments.

Third-party code, used as libraries and not copied in:

- Contract: `near-sdk`, `serde_json`, `hex`
- Enclave: `ecies` (pure Rust), `hkdf`, `sha2`, `serde`, `serde_json`, `hex`
- Web: React, React Router, Vite, `eciesjs`, NEAR Wallet Selector (Meteor,
  MyNearWallet, HERE), `buffer`
- Services: OutLayer (TEE execution and attestations), FastNEAR RPC, NearBlocks
  explorer links
- Intel's SGX root CA public key is pinned in `web/src/lib/attest.ts` to check
  enclave quotes

`testdata/interop/rust.json` holds a throwaway key made for the test vectors; it
guards nothing.

## License

MIT, see [LICENSE](LICENSE).

## Prior art and credits

- The encrypt-submit, decrypt-in-enclave, aggregate pattern follows OutLayer's
  private-dao-example (https://app.outlayer.ai/docs/examples).
- Visual direction drew on templates in the Kombai gallery (kombai.com/gallery). No template code is used.
- Built for NEAR Hackathon, Privacy & Private AI track.
