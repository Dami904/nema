# Limitations

What Nema does not do yet, or does only partly. Each item says why.

## Not done

- **Testnet only.** Nothing has run on mainnet, and no real money has moved.
- **The contract account still has a full-access key.** Whoever holds it can
  redeploy the contract or change the enclave's secret lock, and with either can
  expose marks. Removing the key is permanent, so it waits for the final deploy.
  See [THREAT_MODEL.md](THREAT_MODEL.md).
- **The live rounds are test rounds.** Round 2 ran in full with four funds, a
  lender and an auditor, but all of them are accounts the author controls.
- **One OutLayer project, one master secret, no rotation.** A new secret means new
  round keys; old rounds stay tied to the old secret.
- **No limit on how many rounds a reader can combine.** Results from many rounds
  over a panel that barely changes could narrow down one fund's marks. Nema
  enforces a minimum of 4 per round, not across rounds.

## Partly done

- **Round storage is paid by the contract.** Reads and audits carry a storage
  deposit; submissions do not. A full round (64 funds at up to 2 KB of
  ciphertext each) costs the contract about 1.3 NEAR of storage. If its balance
  ran that low, a tally could not be stored and the round would keep failing to
  close until the contract is topped up. Fine for a testnet panel of a few funds;
  a bond on `submit` would close it.
- **A late tally can fail a good retry.** Callbacks name the round, not which
  close they answer. If a first tally lands after the round was settled and closed
  again, and the set changed in between (a fund was removed), the stale answer is
  refused and the round returns to `CloseFailed`, so it must be closed once more.
  No mark is revealed and nothing is paid twice; a per-close counter would fix it.
- **Callback gas is estimated, not measured.** Callbacks get 40 Tgas. A tally for
  a full 64-fund round rewrites up to about 130 KB of state and credits 64
  accounts; that has not been measured on chain. If it ran out, the round would
  sit in `Closing` until settled after 30 minutes.
- **The enclave fee is OutLayer's once it accepts the call.** If OutLayer refuses
  the call outright, the contract returns the fee to whoever paid it. If OutLayer
  runs it and the run fails, the read price comes back but the fee does not; how
  much OutLayer itself returns has not been measured. The fee forwarded is capped
  at 0.05 NEAR and anything above goes straight back.

- **Stuck enclave calls are settled by hand, not automatically.** If OutLayer
  never calls back, the round, read or audit stays waiting until someone calls
  `reconcile_*` 30 minutes later (the app shows a Settle button). There is no
  keeper doing it. In every testnet run so far the callback did arrive.
- **The reliability features have not run live yet.** Settling stuck calls,
  dropping removed funds at close, refusing duplicate reads, re-checking the
  auditor on delivery and the NEP-297 events are deployed on testnet
  (`cf0c725e…`, round 2 intact through each upgrade) and covered by 111 contract
  tests, but no round has run on this build yet.
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
- **A timed-out wallet transaction is reported as failed.** The app does not look
  it up by hash. It refetches state every 15 seconds, so one that landed appears,
  and the contract refuses a duplicate read or close.

## Out of scope

- **Proving funds are independent.** The owner admits funds; the panel is public.
- **Stopping a reader from sharing the result.**
- **Catching a plausible wrong mark.** Only out-of-range, copied and undecryptable
  marks are dropped. Track records and auditors show the rest over time.
- **Mobile wallets beyond Meteor, MyNearWallet and HERE.**
- **A server.** There is none: the app is static, and everything it shows comes
  from the chain or OutLayer's public API.
