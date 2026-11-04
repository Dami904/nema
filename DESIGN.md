# Nema design notes

Working notes, not marketing. Updated as decisions are made.

## Components

| Part | Where | State |
| --- | --- | --- |
| Enclave module (derive key, tally, sealed delivery, audit) | `aggregator/` | Done, 32 tests, builds to wasm32-wasip2 (461 KB, sha256 `3ed58517…50d6`), active on OutLayer from the `enclave-v2` release |
| NEAR contract (members, applications, rounds, submissions, listing, paid and free reads, audits, earnings) | `contract/` | Done, 97 unit tests. Live on testnet (sha256 `4056da77…3413`), migrated in place from each earlier build |
| Browser crypto check (eciesjs 0.5.0) | `interop/` | Done: both directions verified against the enclave code |
| Web UI (encrypt in browser, submit, buy or claim, open the sealed copy, audit) | `web/` | Done, sample data for every state; no live call sent yet |

## Round lifecycle

`open_round` (owner) -> enclave derives the round key -> `Open` ->
funds call `submit` with an ECIES ciphertext -> deadline passes ->
anyone calls `close_round` -> contract commits the submission set (hash) and
calls the enclave -> enclave returns the count, the rejected list and a
commitment -> `Published` (a listing, not the result).

A buyer calls `buy_read` with the read price and a public key -> the enclave
recomputes the result from the same committed set and encrypts it to that key ->
the contract stores the sealed copy and credits each contributing fund an equal
share, or refunds the buyer if anything fails. Funds collect with `withdraw`.

Round states: AwaitingKey, Open, Closing, CloseFailed (retry allowed), Published,
Failed (terminal: no key, or too few funds).
Purchase states: Pending, Delivered, Refunded.

## Enclave interface

```
derive_pubkey  in:  {"action":"derive_pubkey","contract":<id>,"round_id":<n>}
               out: {"ok":true,"pubkey":"<66 hex chars, compressed secp256k1>"}
tally          in:  {"action":"tally","contract":<id>,"round_id":<n>,
                     "min_contributors":<n>,"set_hash":"<hex>",
                     "submissions":[{"account":..,"ciphertext_hex":..}]}
               out: {"ok":true,"count":<n>,"rejected":[{"account":..,"reason":..}],
                     "set_hash":"<hex>","commitment":"<hex>"}
deliver        in:  tally's fields plus "commitment" and "buyer_pubkey"
               out: {"ok":true,"set_hash":..,"commitment":..,"sealed":"<hex>"}
audit          in:  {"action":"audit","contract":<id>,"round_id":<n>,"account":..,
                     "ciphertext_hex":..,"auditor_pubkey":"<hex>"}
               out: {"ok":true,"sealed":"<hex>"}   (opens to {"kind":"audit","account","round_id","mark"})
```

What a fund encrypts: `{"account":"<its own account>","mark":<hundredths>}`.
The account inside stops one fund resubmitting another's ciphertext to double
its weight.

What the buyer opens: `{"count":..,"mean":"94.10","spread":"1.6324","salt":"<hex>"}`.

## Keys and hashes

All derived from one master secret, `PROTECTED_NEMA_MASTER` (32 bytes, generated
inside the enclave by `outlayer secrets set --generate PROTECTED_NEMA_MASTER:hex32`,
never visible to anyone), with HKDF-SHA256 and info strings that name the
contract and round:

- round key: `nema/round-key/v1/<contract>/<round_id>`
- result salt: `nema/result-salt/v1/<contract>/<round_id>`

`set_hash` = sha256 over, for each submission sorted by account: u32 little-endian
account length, the account bytes, sha256 of the ciphertext hex string. The
contract computes it at close; the enclave recomputes it and refuses a different
set. A shared vector in `testdata/` is checked by the contract, the enclave and
the browser script.

`commitment` = sha256("nema/commit/v1" || u32 LE contract length || contract ||
u64 LE round id || salt || "count|mean|spread"). The salt keeps it hiding: the
space of plausible mean/spread pairs is small enough that an unsalted hash could
be brute-forced. The buyer receives the salt and checks the commitment against the
chain.

ECIES: secp256k1, uncompressed ephemeral key, HKDF-SHA256, AES-256-GCM with a
16-byte nonce. These are the defaults of both the Rust `ecies` crate and eciesjs.

## Decisions made

- Sealed delivery instead of a public result. On a public chain a paid read of
  public state is cosmetic, so the result is never stored in plain form.
- Only the round's contract may call the enclave. The module compares the
  `contract` in the request with `NEAR_PREDECESSOR_ID`. Without this, anyone
  could ask the enclave to tally a hand-picked set (one real ciphertext next to
  three of their own) and read that fund's mark off the mean.
- The contract only ever sends the committed set, frozen at the deadline.
- Callbacks never panic. A panic would revert the state change and strand the
  round or the buyer's payment. Failures are recorded; a close can be retried, a
  purchase is refunded.
- Fees are credited, then withdrawn. Paying up to 64 funds inside one callback
  could run out of gas.
- The contract checks the tally adds up: every submission is counted or rejected
  exactly once, and rejected accounts must be submitters.
- A round publishes nothing below 4 funds. The enclave enforces this floor too,
  whatever the contract asks for.
- Out-of-range, undecryptable and copied submissions are dropped and named, so
  one bad fund cannot veto a round.
- The latest submission before the deadline counts.
- Membership is an owner-managed allowlist (a stated trust assumption). Funds
  apply with a 0.05 NEAR bond, returned on approval, rejection or withdrawal, so
  the queue (capped at 32) can't be filled for free. The owner can still add a
  fund directly.
- Funds whose marks counted, and the auditors they named no later than the
  round's deadline, read the result for free (`claim_read`), once per round
  unless the last copy failed. A dropped fund pays like anyone else. The
  deadline rule stops a fund naming a lender as its "auditor" after the fact to
  hand it a free copy.
- Every read and audit leaves a 0.02 NEAR storage deposit with the contract
  (about 2 KB of storage), so readers pay for the records they create instead
  of spending the contract's balance. Stored enclave errors are cut to 200
  characters.
- An auditor can have a mark opened only once the round stops taking marks, so
  the copy is the one that counts.
- `withdraw` puts the earnings back if the transfer fails. Purchases and audits
  are indexed by account, so the per-account views don't scan every record.
- A fund names its own auditor; the owner cannot. The auditor's copy of a mark is
  made by the enclave from the ciphertext on chain, not by the fund, so a fund
  can't show its auditor a different number from the one it submitted. The
  enclave checks the plaintext names that fund. Clearing the auditor ends access
  at once.
- `migrate` upgrades the first deployment's state in place. It refuses if any
  purchase exists, because the purchase layout gained a `basis` field.
- The enclave trusts the contract's account, not its code. While
  `nema-dev.testnet` holds a full-access key, whoever has that key could deploy
  different code and have the enclave tally a hand-picked set, which could
  expose marks. The site shows the deployed code hash so a change is visible;
  removing the account's full-access key after the final deploy closes this.
  That step is permanent and not yet taken.
- Rounds record `closed_by`. OutLayer files each run under the account that
  signed the transaction, so the site finds a round's runs under the owner (key),
  the closer (tally) and the viewer (their copies and audits). `migrate` now also
  refuses if any round exists, since rounds gained this field.
- Enclave proofs are checked in the browser, not taken from OutLayer's API: the
  quote's chain must end at Intel's SGX root key (pinned), the report data must
  equal the task hash recomputed from the run's fields (OutLayer's V1 layout), the
  five measurements must be approved on `worker.outlayer.*`, the code hash must be
  Nema's build, the request must come from the Nema contract with the attested
  input, and the attested output must match what the contract stored. Intel TCB
  status and revocation are not checked in the browser.
- The master secret is bound to the enclave build hash (`--build`), so the new
  enclave build needs the secret generated again. No round has run, so no key or
  result is lost.

## What is not verified

Round 2 ran in full on testnet (see the README), so the OutLayer calls, the
caller check, sealed delivery and the attestation checks have all run for real.
What OutLayer actually did is in [docs/API_NOTES.md](docs/API_NOTES.md). Still
open:

- OutLayer's input size limit for a round with many submissions.
- The 30-minute settle path (`reconcile_*`) has only run in unit tests: no
  enclave call has yet failed to answer on testnet.
- Everything else not done is in [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

## Trust model

- Privacy of individual marks and of the result rests on the enclave hardware
  and its operator, not on a threshold of independent nodes.
- Public on chain: who submitted, when, the ciphertexts, the set hash, the
  count, who was rejected and why, the commitment, who bought, and each sealed
  copy.
- A buyer who opens the result can share it. Nothing stops that.
- The owner cannot read marks or the result without buying, but chooses the panel.
- A fund can still lie inside the valid range; only out-of-range values are
  caught.
