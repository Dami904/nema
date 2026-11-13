# Roadmap

What is live is in the [README](../README.md#deployed). This page lists what is
not, why, and in what order. Each item says which part it changes: the contract
(a redeploy and a new verification), the enclave (a new build hash and a new
secret lock), or neither.

## Shipped in v2.1 (2026-11-13)

| Item | Changed | What it does |
| --- | --- | --- |
| **Rounded result** | enclave | The mean is rounded to an eighth of a point (how loans are quoted anyway) and the spread to a quarter. Before, two funds colluding in a four-fund round could solve for the other two marks exactly, and a fund that left between rounds could be read off the difference; now each answer is a range about a point wide. |
| **Trimmed mean** | enclave | From five funds up, the highest and lowest marks are left out of the mean (two of each from nine), as LIBOR dropped its top and bottom quartiles, so one fund can't drag the consensus. A secret-sharing design can only add numbers up; the enclave sees the marks, so it can sort them. |
| **Reader allowlist**, off by default | contract | The council can limit paid reads to readers it approves (a vetted lender, an LP). Off by default so the open market still works. |
| **Enclave build reproducible on Linux** | enclave | Built in a digest-pinned container (`aggregator/build.sh`), so anyone with Docker gets the same hash; CI checks it on every push. |

## v2.2: one contract redeploy

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
