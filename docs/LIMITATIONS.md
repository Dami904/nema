# Limitations

What Nema does not do yet, or does only partly. Each item says why.

## Not done

- **Testnet only.** Nothing has run on mainnet, and no real money has moved.
- **The contract account still has a full-access key.** Whoever holds it can
  redeploy the contract or change the enclave's secret lock, and with either can
  expose marks. Removing the key is permanent, so it waits for the final deploy.
  See [THREAT_MODEL.md](THREAT_MODEL.md).
- **The live rounds are test rounds.** Rounds 2, 3 and 4 ran in full with four
  funds, a lender and an auditor, and round 5 tested a fund removed before close,
  but all of them are accounts the author controls.
- **One OutLayer project, one master secret, no rotation.** A new secret means new
  round keys; old rounds stay tied to the old secret.
- **No limit on how many rounds a reader can combine.** Results from many rounds
  over a panel that barely changes could narrow down one fund's marks. Nema
  enforces a minimum of 4 per round, not across rounds.

## Partly done

- **Callback gas for a full round is measured in tests, not on chain.** Callbacks
  get 40 Tgas. On testnet, round 2's 4-fund tally callback burned 2.1 Tgas and its
  delivery 2.8 Tgas. A unit test with 64 funds and the largest marks measures the
  host-function gas at 5.4 Tgas for the tally and 8.8 Tgas for a delivery that
  credits all 64, so the budget has a wide margin, but no 64-fund round has run.
  If a callback ever ran out, the round would wait until settled.
- **The enclave fee is OutLayer's once it accepts the call.** If OutLayer refuses
  the call outright, the contract returns the fee to whoever paid it. If OutLayer
  runs it and the run fails, the read price comes back but the fee does not.
  OutLayer returns what a run doesn't use: on round 2 it sent back 0.00892 of each
  0.01 NEAR, so a run cost about 0.0011 NEAR. The fee forwarded is capped at 0.05
  NEAR and anything above goes straight back.
- **Stuck enclave calls are settled by a keeper someone has to run.** If OutLayer
  never calls back, anyone can settle the call 30 minutes later: the app shows a
  Settle button, and `pnpm live:close-rounds` closes due rounds and settles every
  stale round, read and audit in one pass (`--dry-run` to look first). Nothing
  runs it on a schedule, since that would need a signing key on a server. In
  every testnet run so far the callback did arrive.
- **Some failure paths have only run in tests.** Rounds 3 to 5 ran on the
  current build (`05e0b58e…`): storage deposits on marks, the tally, free and paid
  reads, equal shares to the funds, an audit, the refusals of a second free copy
  and of an audit by the wrong account, and (round 5, `pnpm live:smoke --drop`) a
  fund removed before close: its mark was dropped, the round failed with 3 of 4,
  and the closer's deposit came back. Settling a stuck call, a bounced payment
  and a refused enclave call can't be caused on demand and have never happened
  live; 117 contract tests cover them.
- **Enclave quotes are checked, revocation is not.** The browser checks the chain
  to Intel's root and the measurements, not Intel's TCB status or revocation
  lists.
- **Builds reproduce only on the author's setup.** The wasm embeds the Cargo
  registry path, so the pinned hashes reproduce on Windows with
  `CARGO_HOME=C:\Users\USER\.cargo` and Rust 1.96 (CI does this), not on Linux or
  macOS. Remapping paths would fix it but changes the enclave hash, which needs a
  new secret lock.
- **The enclave source is frozen.** Any edit changes the hash the secret is locked
  to. So it is not formatted with `rustfmt`, and lint exceptions live in
  `Cargo.toml`.
- **A lost wallet transaction is found through one indexer.** When a wallet times
  out or drops, the app looks for the transaction on chain through FastNEAR's
  transaction API before calling it failed. If that API is down or behind, the
  app says nothing was found; the 15-second refresh still shows one that landed,
  and the contract refuses a duplicate read or close.
- **Switching enclave hosts is manual.** The OutLayer project loads the enclave
  from FastFS, with the GitHub release as a standby copy of the same bytes. A
  version has one URL, so if FastFS stops serving, someone runs `pnpm
  live:enclave-source github`; until then enclave calls fail and reads refund
  their price.

## Out of scope

- **Proving funds are independent.** The owner admits funds; the panel is public.
- **Stopping a reader from sharing the result.**
- **Catching a plausible wrong mark.** Only out-of-range, copied and undecryptable
  marks are dropped. Track records and auditors show the rest over time.
- **Mobile wallets beyond Meteor, MyNearWallet and HERE.**
- **A server.** There is none: the app is static, and everything it shows comes
  from the chain or OutLayer's public API.
