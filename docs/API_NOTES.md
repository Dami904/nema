# OutLayer and NEAR: what we observed

How the outside services Nema depends on actually behaved on testnet, as opposed
to what their docs led us to expect. Each entry says where it was seen. The
contract and the scripts are written against these notes.

## `request_execution` (outlayer.testnet)

**The callback gets the module's raw JSON, or `null`.**
The docs suggested an envelope like `{ success, output, error }`. The contract
first deserialized into that and every callback failed with
`missing field success`. In fact the callback's promise result is whatever the
module printed to stdout, parsed as JSON. When the run fails (module error,
limits hit, no worker), it is `null`. So the callbacks read the raw promise
result themselves (`enclave_answer()` in `contract/src/lib.rs`): `null` is a failed
run, and bytes that are not JSON are a failure too rather than a deserialization
panic, which would revert the callback and leave the call waiting. The test
`outcome_maps_enclave_responses` uses the exact bytes testnet returned.

**It is asynchronous, and success means "accepted".**
The transaction that calls `request_execution` succeeds as soon as OutLayer
queues the job. The result arrives later, in a callback receipt (yield/resume).
So nothing the contract does in the calling transaction can assume the run
happened. Every call that reaches the enclave leaves a record in a waiting state
(`AwaitingKey`, `Closing`, a `Pending` read or audit) that only the callback
moves on.

**A callback can, in principle, never arrive.**
In every run we made (jobs 16942 to 16956), the callback fired, success or
failure. The contract still does not rely on that: each waiting record has a
timestamp (`get_pending_since`), and 30 minutes later anyone can settle it with
`reconcile_round`, `reconcile_read` or `reconcile_audit`. Settling a read refunds
its price. A late callback for something already settled is ignored and logged
as a `callback_ignored` event.

**It is not idempotent.**
Calling it twice runs the module twice and charges twice. OutLayer has no
request key. Idempotency is the contract's job: a round can only be `Closing`
once at a time, and a second read for the same `(buyer, round, buyer key)`
that is not refunded is refused before any OutLayer call is made
(`retrying_a_read_with_the_same_key_does_not_pay_twice`).

**The deposit is a fee cap.**
The contract forwards the caller's enclave fee (0.01 NEAR from the app, at most
0.05 NEAR; any surplus goes straight back) and names the caller as `payer`, the
account OutLayer's interface returns unused deposit to. It does: on round 2's
tally and paid read, OutLayer sent 0.00892 NEAR of each 0.01 back to the payer, so
a run cost about 0.0011 NEAR. Whether a failed run is charged in full is not
measured.

**If OutLayer refuses the call itself, the fee comes back to the contract, not the
payer.** That is NEAR's rule: a failed receipt refunds its deposit to whoever sent
it, which is the Nema contract. The callback then sees a failed promise rather
than a value, so it passes the fee on to the payer (`enclave_fee_refunded`). A run
OutLayer accepted and then failed arrives as `null`, not as a failed promise, and
the fee is not returned by Nema.

**`NEAR_PREDECESSOR_ID` is the calling contract.**
The enclave's caller check (`req.contract() != predecessor`) rests on this. The
tally in job 16947 went through, and the module refuses any other caller, so the
module saw `nema-dev.testnet`.

## Secrets

**A secret's access lock is judged against the signer unless you say otherwise.**
The first lock whitelisted `nema-dev.testnet` as an account. A tally requested
by a fund through the contract was denied, because the account checked was the
fund that signed, not the contract that called. The lock now uses
`Predecessor`, which checks the calling account (both contracts, v1 and v2):

```json
{"Logic":{"operator":"And","conditions":[
  {"Predecessor":{"condition":{"Whitelist":{"accounts":["nema-dev.testnet","nema-v2.testnet"]}}}},
  {"WasmHash":{"hash":"f317370983fab3385e1f60c2c4958a4fccb935e030fcf06c35b9f6e9b0514bc8"}}
]}}
```

**A lock can accept two builds while the project switches.** `Logic` nests, and
`Or` works: moving to the v2.1 enclave, the lock first accepted
`Or[WasmHash(old), WasmHash(new)]`, so rounds kept working whichever version was
active, then was narrowed to the new hash once a live round passed on it. The
nested lock needed a larger storage deposit (0.00782 NEAR held in all; the call
said exactly how much was missing).

**`update_access` needs a storage deposit.**
Without one it fails. 0.0003 NEAR was enough.

**Runs are filed under the signer.**
OutLayer's job list for an account shows runs signed by that account, so the
site finds a round's runs under whoever opened it (key), the closer (tally) and the
reader (copies and audits).

**The job list can't be read from another site's page.**
By 2026-11-11 `/public/jobs` answered with no CORS header for any origin but
OutLayer's own dashboard, so the browser refused it and the Verify tab showed no
runs. `/attestations/<job>` still sends `access-control-allow-origin: *`. The
site now asks for the list through its own origin (`/outlayer/testnet/jobs`),
which the host forwards unchanged (`web/vercel.json`; `web/vite.config.ts` does
the same in development). The list only says which runs exist; each run is still
checked against its Intel quote in the browser.

## Builds

**GitHub builds are disabled on OutLayer testnet.**
The project source is a `WasmUrl` pointing at the file on FastFS
(`https://test.fastfs.io/nema-dev.testnet/outlayer.testnet/f317370983fab3385e1f60c2c4958a4fccb935e030fcf06c35b9f6e9b0514bc8.wasm`).
OutLayer refuses the file unless its bytes hash to the registered sha256. The
same bytes are the `enclave-v3` GitHub release asset, the standby. (Before
v2.1, the `enclave-v2` release held the earlier build and was the source until
2026-11-04.) A version has one URL, so there
is no automatic failover: if FastFS stops serving, `pnpm live:enclave-source
github` moves the project to the release (and `fastfs` moves it back).

**A FastFS upload can report a failed transaction and still land.**
`outlayer upload` sends the file as transaction arguments to `outlayer.testnet`.
The call itself ran out of gas both times, but FastFS indexes the arguments, so
the URL served the exact bytes right away. Check the URL's sha256, not the
transaction status.

**Versions are keyed by hash, so a new URL for the same build needs a swap.**
`add_version` refuses a hash the project already has. Moving the live build to
FastFS took `set_active_version` to an older build, `remove_version`, then
`add_version` with `set_active: true`. The secret lock checks the wasm hash, not
the URL, so the secret kept working; round 4 ran on it. `pnpm
live:enclave-source` does the same three calls, after checking that the target
host serves the right bytes.

**The wasm hash depends on the build machine, so the build runs in a container.**
Panic messages embed the Cargo registry path and the workspace path. The first
builds (`3ed58517…`) came from Windows and reproduce only with
`CARGO_HOME=C:\Users\USER\.cargo`. Path remapping is not enough to match a Linux
build, because Windows paths keep their backslashes. Since v2.1 the enclave is
built by `aggregator/build.sh` in a digest-pinned `rust:1.96.0-slim-bookworm`
container, with the source at `/nema`, so the paths are the same on every machine;
CI's `reproduce` job runs the same script on Ubuntu.

**Any change to the enclave source changes the hash.**
Even a reformat moves line numbers in panic messages. The enclave source is
frozen; lint exceptions go in `[lints]` in `aggregator/Cargo.toml`, which leaves
the hash unchanged (checked).

**The contract build reproduces on any host with Docker.**
`cargo near build reproducible-wasm` (cargo-near 0.21.1) builds inside the
`sourcescan/cargo-near:0.21.1-rust-1.96.0` image that `contract/Cargo.toml` pins
by digest. The wasm records the commit it came from (NEP-330
`contract_source_metadata`). SourceScan rebuilt `8475de8` and got the deployed
sha256 `248f6ca6…d24a` (v1), and rebuilt `d8f5b58` and got v2.1's `36e01373…`
(code hash `4hDBzqaW…tfUUj` on `nema-v2.testnet`). CI's `contract-reproduce` job runs the same build, and
it fails if the contract source has moved on from that commit without a new deploy.

## Contract callbacks (near-sdk 5.30.1)

**A callback reads at most 256 KiB of the enclave's answer.**
`env::promise_result_checked(0, MAX_ENCLAVE_ANSWER)` returns `TooLong` for a
longer answer instead of loading it. Nema treats `TooLong` as a failed run whose
fee OutLayer keeps, because the enclave did run. A read's price goes back to the
buyer, a close or an audit can be asked again, and a round whose key came back
too long fails (a new round is opened on the loan). Only `Failed` (the call itself
failed) refunds the fee. Real answers are a few KB. The gas needed to parse an
answer near the cap inside the 40 Tgas callback has not been measured (see
THREAT_MODEL, known weaknesses).

**A detached promise still runs.**
In 5.30, dropping a `Promise` schedules it. `.detach()` only marks that the
result is unused, so the refunds that call it are still sent.

## Attestations

**The API is evidence, not a verdict.**
OutLayer's attestation endpoint returns the quote and the run's fields. The app
recomputes the task hash and checks the quote itself (`web/src/lib/attest.ts`).
The request is found by its `EVENT_JSON` log with standard `near-outlayer` and
event `execution_requested`; Nema's own events share the transaction, so the
standard is checked too.

## NEAR RPC

**FastNEAR returns views as byte arrays.**
`result.result` is an array of bytes holding UTF-8 JSON. `web/src/lib/near.ts`
decodes it. Views are read-only and safe to retry; the app polls every 15
seconds.

**The ordinary RPC forgets transactions after a few days.**
A week after rounds 2 to 4, `rpc.testnet.fastnear.com` no longer knew their
transactions, so the attestation check couldn't read the request and dropped
every run. Transaction lookups for a run now ask the ordinary node and an
archival one (`archival-rpc.testnet.fastnear.com`) together and take the first
answer.

**A transaction that times out on the RPC may still land.**
When the wallet throws for any reason but a cancel, the app does not call it
failed straight away. A wallet doesn't hand back the hash of a transaction it
lost, so the app asks FastNEAR's transaction API (`tx.test.fastnear.com/v0/account`,
CORS open) for the account's recent transactions, newest first, and fetches each
one sent since the user confirmed. If one calls the same method on Nema, the app
reports how it ended. It looks four times over 20 seconds, then says nothing
was found. The scripts still report a timeout as a failure. Resending is safe
for reads and closes because the contract refuses the duplicate (same key, or a
round already `Closing`).
