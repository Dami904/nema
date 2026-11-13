# Nema v2: council governance

Status: design, on the `v2-council` branch. Nothing here is deployed. v1 stays live
on `nema-dev.testnet`; v2 deploys to `nema-v2.testnet` with fresh state, so no
migration touches v1's rounds.

## The problem v1 leaves open

One account (the owner) admits funds, removes them, sets the read price and opens
every round. Three consequences:

1. **One key decides who is on the panel.** A fund that controls the owner key, or
   a stolen owner key, can pad a round with funds it controls and subtract their
   marks from the published mean to isolate one real fund's mark.
2. **Only the owner can start a round.** The panel can't use Nema without the owner.
3. **Removing the owner key would freeze the app**, so the full-access key stays,
   and the key can also redeploy the contract.

## What changes

### Council replaces the owner

- `council`: 3 to 7 accounts, and `threshold`, which must be a majority and at
  least 2 (2 for a council of 3).
- Every other owner-only action becomes a **proposal**: remove a fund, set the
  read price, add or remove a council member, change the threshold, register or
  remove a loan, or a heartbeat that changes nothing.
- A council member proposes (their vote counts) and the others vote. At
  `threshold` votes from current members the action runs. A proposal lapses after
  7 days; lapsed ones are hidden and cleared when the next one is made. One seat
  holds at most 4 open proposals. A proposal overtaken by another (say, the same
  loan registered twice) fails on its last vote with a `proposal_failed` event,
  rather than reverting the vote. A seat that leaves takes its votes and approvals
  with it.
- **The threshold stays a majority.** Adding a seat raises it if needed; changing it
  by vote is checked the same way.
- **Admission is a vote with a veto window.** Council members `approve` an
  application; once approvals from current members reach the threshold, the fund
  joins only after `admit_delay`, and any council member can veto in that time.
  After it, anyone calls `finalize_admission`.
- Applications stay public with a bond, as in v1.

### Any panel fund can open a round

- `open_round(loan_id, closes_at)` is open to panel funds and council members.
- `loan_id` must be in the **loan registry**, a council-approved list of labels
  (the site encodes borrower, facility and maturity in the label). A fund can't
  invent a loan, and every fund prices the same instrument. It holds 64 loans at a
  time; the council removes old ones (not while a round on them runs) to make room.
- One active round per loan, so rounds can't be spammed.
- Whoever opens the round pays the enclave fee, as in v1.
- A round can stay open at most 30 days, so no round holds a loan forever.

### The council is paid, and can be replaced

- **Pay.** A fixed share of each paid read (set at deploy, capped at 20%, not
  changeable by a vote) is split equally among the council seats. It gives the
  people who keep the panel running a reason to show up. A free read pays the
  council nothing. The funds split the rest, and nothing is lost or made.
- **If the council goes quiet.** If it makes no decision for a set time (90 days
  planned), any panel fund can propose a new council, and two thirds of the panel's
  funds can vote it in. A "decision" is a proposal that passed or an admission that
  reached its threshold. One member acting alone doesn't count, so a single absent
  seat can't keep a dead council alive, and a healthy council with nothing to
  decide shows life with a `Heartbeat` proposal that changes nothing. If the council
  decides anything while a takeover vote is running, the takeover dies. A new council
  can't be replaced again straight away, and starts without the old council's open
  proposals or approvals. A takeover needs a panel at the minimum size (so a few
  funds left behind can't seize it). The vote lapses after 14 days.
- **A round can't open on a panel too small to publish** (fewer funds than the
  minimum), so a round that is certain to fail is never created.

### Smaller fixes from the v1 audit

- Lower the enclave answer cap from 256 KiB to 64 KiB, so a callback can't run out
  of gas parsing it.
- Emit an event when a round-key callback fails.

### Deferred (needs the enclave rebuild)

- Rounded result and trimmed median, against the subtraction attack. **Shipped in v2.1** as a trimmed mean (see [ROADMAP.md](ROADMAP.md)).
- Affiliation groups, so a round needs 4 distinct groups, not 4 accounts.
- Anomaly flags on marks, computed inside the enclave.
- A slashable bond held for the whole membership, not only while applying.
- Self-upgrade by council vote with a timelock, then deleting the account's
  full-access key.
- An optional allowlist of readers (off by default), so lenders can be vetted. **Shipped in v2.1.**
- Moving the enclave project and its secret under the council's control.
- Letting any two panel funds register a loan, with a council veto, so growth needs
  the council less.

## Trust after v2 (contract part only)

| Party | Can | Cannot |
| --- | --- | --- |
| One council member | propose, vote, veto an admission | admit, remove or reprice alone |
| Threshold of the council | admit and remove funds, set the price, edit the council | read any mark, redeploy the contract |
| A panel fund | open rounds on registered loans, seal marks | admit anyone, open an unregistered loan |
| Two thirds of the panel's funds | replace a council that has made no decision for the set time | replace a council that is still deciding |
| The full-access key | still redeploy and relock, until it is deleted | (v2 does not delete it; see Deferred) |

The last row is the honest gap: until self-upgrade exists, the account key can still
replace the code. v2's contract changes remove the single admin, not that key.

## Will it run without the author?

Partly, and only with real people on the council. Rounds, marks, reads, closing and
settling need no one in particular. Admitting funds, registering loans and changing
the price need the council. On testnet the council seats are the author's own
accounts, so a testnet deployment is not independent of its author. What v2 adds is a
way out: if the council stops, two thirds of the panel can replace it. What it does
not fix: the OutLayer project and secret are owned by `nema-dev.testnet`, and the
website is hosted on the author's account. For a production launch the seats need
independent parties, and the enclave project needs to sit under the council.

## Testing

Each guard has a test that fails when the guard is removed, and each was removed
once to check: see [CLAIMS.md](CLAIMS.md) for the claim-to-test table and the
guard-removal results (43). Money is covered by property tests that a read fee is paid
out in full with or without the council's share, and the site's fee breakdown is
checked against the same vector as the contract.
