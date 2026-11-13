# Nema demo: recording guide

Site: https://nema-near.vercel.app (NEAR testnet). Record silently. The voice,
music and captions go on afterwards. Record each clip as its own file
(`1-apply.mp4`, `2-seal.mp4`, …), so a retake costs one clip, not the whole run.

The clips follow one real round, from four points of view:

| Clip | Who | Where it fits in the film |
| --- | --- | --- |
| 1–5 | **A fund** (`nemalender.testnet` joins the panel) | The live run, after problem/solution |
| 6 | **Its auditor** (`nemaauditor.testnet`) | Who can use it |
| 7 | **Anyone, no wallet** (the public verifier) | What stays private |
| 8 | **The council** (Sample mode) | Who can use it |
| — | **A lender** | Already recorded (purchase #10) |
| 9 | **Backup** (Sample mode) | Only if a live clip fails |

Steps marked **Claude** are mine. I sign them from the terminal with the
council seats' and the test funds' keys. You never handle those keys, and your wallets
never show them. Send me "go" at each **Claude** step, then wait for "done".

## Before you record

1. **Make `nemaauditor.testnet`** in your wallet, the same way you made
   `nemalender.testnet` (testnet). **Claude** funds it with 0.3 NEAR.
2. `nemalender.testnet` has about 0.38 NEAR, which is enough. The bond (0.05)
   comes back when you're admitted. The whole run costs it about 0.07 NEAR.
3. One browser window, one tab, full screen at 100% zoom, a full-width desktop
   window (a narrow one switches to the phone layout). Bookmarks bar hidden,
   notifications off, no other tabs.
4. **Recorder:** Windows Game Bar (Win + Alt + R) records only the browser. If you
   use OBS, capture the browser window, not the display: the last recording
   showed OBS itself at 0:00, 0:27, 0:33 and 1:30.
5. Never show a seed phrase or a private key. Wallet pop-ups are fine.
6. Nothing gets pushed to `main` while you record (every push redeploys the site).

## The fund (one real round, about 30 minutes in all)

Move the mouse slowly and pause 2 seconds on each screen. The waits get cut later.

**Clip 1. Apply (about 40 s).**
Connect `nemalender.testnet`. Go to **Panel**. Show the panel of four funds and
the read-only note. Under **Join the panel**, put `nemaauditor.testnet` in
**Auditor**, add a note (say "Credit fund, private loans"), and press
**Apply · 0.05 NEAR bond, returned**. Approve in the wallet. Stop on **Waiting on
the council**. Tell me "applied".

> **Claude:** `pnpm live:demo-round approve --account nemalender.testnet`
> then `pnpm live:demo-round open --minutes 20` (round 7, closes in 20 minutes).

**Clip 2. Admitted, and the round opens (about 20 s).**
Reload **Panel**: `nemalender` is now on the panel. Go to **Rounds**: round 07
(Harbor Freight Logistics, Senior term loan B) is **Open**.

**Clip 3. Seal a mark (about 40 s). The key moment of the fund clip.**
Open round 07, **Fund** view. Type `94.80` in **Price, in points of par**. Pause
on the line "Encrypted in your browser before it leaves". Tick **Keep my mark on
this device**. Press **Seal and submit**, approve. Then open your submit
transaction on NearBlocks (wallet pop-up link, or the account's history):
the argument is a long hex string, and 94.80 appears nowhere. Tell me "sealed".

> **Claude:** `pnpm live:demo-round marks --round 7` (fund1–4 seal and submit
> their marks, so the round has five).

**Clip 4. Close and read the result for free (about 60 s, after the deadline).**
When the 20 minutes are up, open round 07. Press **Close the round** and approve
(anyone can close; the 0.01 NEAR enclave fee mostly comes back). Wait for
**Published** (under a minute). Go to **Result**: "Your mark counted". Press
**Open your free copy · 0.03 NEAR**, approve, and back up the key when asked.
The mean and spread unseal. Pause on the result and on **Where your marks sat**
in **Vault** (your 94.80 next to the consensus). Tell me "read".

> **Claude:** `pnpm live:demo-round read --round 7` (the lender pays 0.1 NEAR for a read).

**Clip 5. Paid for contributing (about 30 s).**
Go to **Vault**. **Earnings to withdraw** shows 0.02 NEAR: the lender's 0.1 NEAR
split five ways. Press **Withdraw**, approve, and show the balance arrive in the
wallet.

## Clip 6. The auditor (about 60 s)

Disconnect, then connect `nemaauditor.testnet`. Open round 07, **Result**: "You
audit nemalender", press **Open your free copy**, approve, and the result
unseals. Go to **Audit**: "What your client sent, and what came back". Under
`nemalender`, press **Open what nemalender sent · 0.03 NEAR**, approve. It shows
**94.80**, exactly what the fund typed. Nobody else on the panel can do this.

## Clip 7. Anyone, no wallet: what stays private (about 60 s)

Disconnect the wallet. Open round 07, **Verify**:
- the set hash on chain and the one your browser recomputes: the same;
- **count 5** and the **commitment**, with no mean or spread anywhere on chain;
- scroll to the enclave runs and wait for each ✓ (up to 30 seconds).

Then open https://testnet.nearblocks.io/address/nema-dev.testnet?tab=contract:
the contract shows as verified (SourceScan). Leave out blank tabs and loading
screens. Pause on each page only once it has loaded.

## Clip 8. The council (Sample mode, about 40 s)

Press **Sample**, then **Viewing as → Council**. Go to **Panel**: the funds on
the panel, the applications with **Approve** / **Turn away**, the form to open a
round, the council's decisions and seats, the read price and the loan registry. Hover over the buttons, but don't press them: Sample
only answers "nothing was sent" for council actions. The caption will say "sample
data". Only council seats can do this live, and clip 2 already shows the real
result.

## Clip 9. Backup (Sample mode, about 90 s)

Only if a live clip goes wrong. Press **Sample** and play the same steps on round 08 with
**Viewing as** set to **Fund · fund1**, then **Lender**, then **Auditor**. A reload
starts the sample over.

## If something goes wrong

- **A wallet pop-up hangs.** Cancel and press the button again. The app checks
  the chain before saying anything failed.
- **The round shows "offline" or doesn't update.** It refreshes every 15 seconds.
  Wait, or reload.
- **You missed the deadline window to seal.** Tell me. I open a new round, and
  you retake clips 2–3.
- **The close fails** ("Retry the close"). Press it again. Each try attaches
  another 0.01 NEAR enclave fee. Tell me if it fails twice.

## Cost

You (nemalender): about 0.07 NEAR. You (nemaauditor): about 0.07 NEAR. Mine,
from `nema-dev.testnet` and its test funds: about 0.3 NEAR to fund the auditor,
0.01 to open the round, 0.12 for four marks and 0.13 for the lender's read.

## Send me

The clip file paths, and anything that went wrong or looked odd while you recorded.
