# Roadmap

What is live is in the [README](../README.md#deployed). This page lists what is
not, why, and in what order. Each item says which part it changes: the contract
(a redeploy and a new verification), the enclave (a new build hash and a new
secret lock), or neither.

## Next

| Item | Changes | Why |
| --- | --- | --- |
| **Rounded result** | enclave | Today a buyer gets the mean to a hundredth and the spread to 1e-4. Two funds that collude in a four-fund round can solve for the other two marks exactly from those, and a fund that leaves between two rounds can be read off the difference. Rounding the mean to an eighth of a point (how loans are quoted anyway) and the spread to a quarter turns an exact answer into a range of about a point. |
| **Trimmed mean** | enclave | Drop the highest and lowest marks before averaging once the panel is big enough (as LIBOR dropped its top and bottom quartiles), so one fund can't drag the consensus. It also removes the clean linear equation a differencing attack relies on. A secret-sharing design can only add numbers up; the enclave sees the marks, so it can sort them. |
| **Reader allowlist**, off by default | contract | Lets the council vet who can buy a mark (a lender, an LP) when a panel wants that. Off by default so the open market still works. |
| **Enclave build reproducible on Linux** | enclave | Today the enclave hash reproduces only on Windows with one specific Cargo path. A pinned container build lets anyone check the hash, and lets CI check it on every push. |

## v2.1: one contract redeploy

Batched, because each contract change needs a redeploy and a new verification.

- **Self-upgrade by council vote, with a timelock, then delete the full-access key.**
  The biggest step toward "runs without its authors". Deleting a key can't be
  undone, so it needs a rehearsal on a fresh account first. Sputnik's `UpgradeSelf`
  is the model ([PARTNERS.md](PARTNERS.md)).
- **Two thresholds and a configurable voting period**: routine actions (a loan, a
  heartbeat) at a majority, sensitive ones (seats, threshold) higher.
- **A proposal bond**, alongside the per-seat cap.
- **Any two panel funds can register a loan**, with a council veto, so the panel
  needs the council less as it grows.
- **Anomaly flags**: the enclave counts marks far from the median and says how many
  in the buyer's sealed copy, with no names.

## v3: needs outside parties or a process

- **Affiliation groups.** A round would need four distinct firms, not four accounts.
  It needs someone to attest who owns which fund; self-declared groups prove
  nothing.
- **A slashable bond held for the whole membership.** Slashing needs a dispute and
  evidence process. Slashing on a statistical outlier alone would punish an honest
  fund with an unpopular view.
- **The enclave project and its secret under the council's control.** Depends on
  what OutLayer supports, and only matters once self-upgrade exists.

## Not planned

- **Differential privacy (random noise).** Marks are bounded between 0 and 200, so
  one fund can move a four-fund mean by up to 50 points. Noise large enough to hide
  that would make the number useless. Rounding and trimming give a smaller,
  honest guarantee that a panel of four can live with.
- **Open admission.** Anyone could join with several accounts and outvote or
  out-mark the real funds.
