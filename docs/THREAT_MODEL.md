# Threat model

What Nema protects, whom it trusts to do so, what happens when each key or party
goes bad, and what it does not defend against at all.

## What is protected

1. **Each fund's mark.** Nobody, including the council, the deployer and the other funds, should
   learn a single fund's price.
2. **The consensus.** Only readers who paid (or who read free because their mark
   counted or they audit a counted fund) should learn the mean and spread.
3. **The money.** A read price goes to the funds whose marks counted, or back to
   the buyer. It is never kept by a failed run or paid twice.

## Who is trusted, and for what

| Party | Trusted to | Not trusted to |
| --- | --- | --- |
| Intel TDX and OutLayer's worker | Run the pinned enclave build without leaking its memory | Anything checkable: the app verifies each run's quote, build hash and caller |
| OutLayer's keystore | Release the master secret only under the lock (contract caller + build hash) | — |
| The council (3 to 7 accounts, a majority decides; on testnet every seat is the author's) | Admit real, independent funds; remove funds; set the read price; register loans | Read marks or the result (they must buy like anyone); act alone: one member can only propose, vote or veto an admission |
| The panel's funds, two thirds of them | Replace a council that has made no decision for the set time (90 days planned) | Anything else about the council: a council that decides anything stops the vote |
| Funds | Submit honest marks | Anything else: out-of-range, copied and undecryptable marks are dropped |
| Readers | Keep their reading key | Not share the result (nothing stops them) |
| The browser | Generate and hold reading keys | — |

## If a key or party is compromised

### The contract account's full-access key

This is the most dangerous key in the system. The account is the contract
(`nema-v2.testnet`; v1 is `nema-dev.testnet`), and `nema-dev.testnet` also owns
the OutLayer secret. The council governs the
contract's state, but cannot stop whoever holds this key from replacing the code.

- **Deploy different contract code.** The enclave trusts the contract *account*,
  not its code. New code could ask the enclave to tally a hand-picked set, one
  real fund's ciphertext next to three marks the attacker chose, and read that
  fund's mark off the mean. **This breaks mark privacy.**
- **Change the secret lock** (with `nema-dev.testnet`'s key, which owns the secret) to admit a different enclave build that simply
  prints the master secret. **This breaks everything, past rounds included.**
- Admit sock-puppet funds so a round reaches the minimum of 4 with one real fund.
- Set the read price.

Mitigation today: the site shows the deployed contract hash, and CI checks it
against the build. A redeploy is public on chain. Removing the account's
full-access key after the final deploy closes the first two; that step is
permanent and has not been taken.

### A council majority

- Admit sock-puppet funds, after the veto window, if no honest member vetoes.
- Remove honest funds, set the read price, register or remove loans, and seat or
  unseat council members (the threshold stays a majority).
- Not: read any mark or redeploy the contract. And a lone member acting can't stop
  a takeover: only decisions that pass reset the silence clock.

### One council member

- Propose, vote, and veto any admission before it is finalized. Repeated vetoes
  can stall admissions until a majority removes that member.

### A fund's key

- Submit or replace that fund's mark until the deadline.
- Read that fund's free copy of each round it counted in, and withdraw its
  earnings.
- Name or clear that fund's auditor, letting a new auditor open that fund's own
  past marks. It cannot open other funds' marks.

### A reader's browser storage

Anything that can read the page's storage (an extension, malware, someone at the
machine) can open that reader's sealed copies. It cannot buy reads as them
(that needs their wallet).

### An auditor's key and browser

Can open the marks of the funds that named it, for as long as they keep it
named. A fund clearing its auditor stops new audits at once; an audit already in
flight when the fund changes auditor is refused on delivery
(`an_audit_landing_after_the_fund_changed_auditor_is_not_delivered`).

### OutLayer's operator

Could withhold runs (rounds stall, then settle as failed after 30 minutes, and
reads are refunded). Could not, without breaking TDX, read the master secret.
Could serve a run on non-TDX hardware, which the app's quote check would flag.

### The master secret

Opens every round's marks and every result, past and future. It exists only
inside OutLayer's TEE. There is no rotation: a new secret means new round keys,
and old rounds stay readable by whoever holds the old one.

## Not defended, explicitly

- **A compromised contract account key** (`nema-v2.testnet`, or `nema-dev.testnet`, which also owns the secret) while it still has full access. See above.
- **A broken TEE.** Privacy rests on one hardware vendor and one operator, not
  on a threshold of independent nodes.
- **Readers sharing the result.** Nema controls who can open it, not what they
  do afterwards.
- **Colluding funds narrowing the other marks.** Two funds that share their own
  marks and read a four-fund result learn the other two marks to within about a
  point, not exactly: the mean is rounded to an eighth and the spread to a
  quarter. Rounds tallied before rounding (`3ed58517…` enclave) keep their exact
  results, and those can be solved exactly.
- **A plausible lie.** A fund can submit a wrong mark inside the valid range.
  Only its track record and its auditor show this over time.
- **The council admitting sock puppets.** A majority must approve and any member
  can veto in the waiting window, and the panel is public, but the contract does
  not prove funds, or council members, are independent.
- **Intel TCB status and revocation.** The browser checks the quote's chain to
  Intel's root, not whether that platform has since been revoked.
- **Metadata.** Who took part, when, and who bought are public on chain.
- **Front-end integrity.** A changed site could seal marks to a different key.
  The site is static and open source; there is no signed release.

## Known weaknesses worth attacking first

1. **Redeploy the contract with the account's full-access key** and tally a crafted set. One
   transaction, no hardware attack needed, until the full-access key is removed.
2. **Re-lock the secret** to a build that exports it. Same key, same fix.
3. **Fill a round with sock puppets** so the "minimum of 4" protects nobody.
4. **Steal a reader's key from browser storage** with a malicious extension.
5. **Average out a fund's mark across rounds.** A fund that leaves and rejoins,
   or a panel that barely changes between rounds, lets a reader of many results
   narrow down individual marks. Rounding makes each difference a range about a
   point wide; many rounds can still narrow it. Not otherwise limited.
6. **An enclave answer big enough to exhaust the callback's gas.** The contract
   reads up to 256 KiB, and the gas needed to parse that much inside 40 Tgas has
   not been measured. If a callback ran out of gas, the round, read or audit
   would stay pending until anyone calls `reconcile_round`, `reconcile_read` or
   `reconcile_audit` 30 minutes later. If every close of a round got such an
   answer, each retry would cost another fee. The answer's size depends on the
   enclave build, not on any caller, so this needs a faulty enclave build.
   A lower cap would mean a redeploy.
