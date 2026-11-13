# Nema next to the NEAR governance and privacy stack

Nema's council (v2, `nema-v2.testnet`) solves a narrow problem: who may admit a
fund, remove one, set the read price and register a loan, without one key deciding
all of it. NEAR already has general tools for shared control. This page says where
Nema matches them, where it differs, and how they fit together.

## Sputnik DAO

[Sputnik DAO v2](https://github.com/near-daos/sputnik-dao-contract) is NEAR's
general DAO contract: roles, a policy per proposal kind, and a bond per proposal.

| | Sputnik DAO v2 (default policy) | Nema v2 council |
| --- | --- | --- |
| Passing rule | `Ratio(1, 2)`, which works out to `floor(n/2) + 1`: a strict majority | A strict majority, and never fewer than 2 |
| Can the rule be weakened by a vote? | Yes. A policy change can set any threshold, including one vote | No. Every change to the seats or the threshold is checked against "majority and at least 2", so a 3-seat council can't vote itself down to 1 |
| Proposal lifetime | 7 days (`proposal_period`) | 7 days, then lapsed and cleared |
| Spam control | A 1 NEAR bond per proposal | At most 4 open proposals per seat |
| What proposals can do | Anything: transfers, function calls, policy, upgrades | Only Nema's own actions: remove a fund, set the price, edit the council, register or remove a loan, heartbeat |
| If the council stops acting | Nothing built in | After a set silence, two thirds of the panel's funds can vote in a new council |
| Self-upgrade | `UpgradeSelf` proposal kind | Not yet (see [ROADMAP.md](ROADMAP.md)): the full-access key still exists |

**They compose.** A council seat is just a NEAR account, so a seat can itself be a
Sputnik DAO (or any multisig contract). The DAO votes internally, then one of its
proposals calls `nema-v2.testnet` to `propose`, `vote` or `approve`. Nema sees one
seat; the firm behind it can require several of its own signers. This needs no
change to Nema's contract. We have not staged it on testnet: a DAO seat held by our
own test accounts would look like independence without being it.

**What Nema keeps narrower on purpose.** A Sputnik council can do anything the DAO
contract can. Nema's council can't move funds' money, can't read a mark, and can't
redeploy the contract; it can only run the proposal kinds listed above. A
general DAO is the right tool for a treasury; a fixed list is easier to audit for a
pricing panel.

**What we'd take from it.** `UpgradeSelf` is the model for Nema's planned
self-upgrade by council vote (with a timelock), after which the account's
full-access key can be deleted.

## Trezu

[Trezu](https://github.com/NEAR-DevHub/trezu-docs) is a treasury app on NEAR
built for teams: multisig-style approvals, configurable thresholds and voting
periods, and confidential treasuries that keep balances and payments private.

- **Same goal, different object.** Trezu keeps a team's *money* private; Nema keeps
  each fund's *price* private while still producing a shared number.
- **Where they meet.** A fund could run its Nema seat, or its read payments, from a
  Trezu treasury, so the firm's own approval rules apply before it votes or pays.
  No change to Nema is needed for that.
- **Ideas we'd borrow later:** separate thresholds for routine and sensitive
  actions, and a voting period the council can set within limits. Both are
  contract changes and are on the roadmap, not in v2.

## NEAR AI

NEAR AI runs private inference in TEEs (Intel TDX with NVIDIA confidential GPUs)
and lets callers verify the attestation. Nema's enclave runs on OutLayer, also on
Intel TDX, so the trust model is the same family: hardware isolation plus a
measured, attested build.

Nema's enclave has no network access by design, so it can't call a hosted model.
Anything a model adds (a plain-language summary of a mark for a lender, say)
would sit on the lender's side, after the result is decrypted, and would need the
lender's own key. It is not part of Nema today.
