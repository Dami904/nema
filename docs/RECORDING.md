# Nema demo: recording plan (v2.1)

The finished film must be **2:20 or shorter**. The hackathon wants the demo posted on
X, and X caps uploads from accounts without Premium at 140 seconds. With Premium it
can run longer; the optional extras at the end add about 15 seconds.

Site: https://nema-near.vercel.app (NEAR testnet, contract `nema-v2.testnet`).
Record the screen silently; the voice, music and captions go on afterwards. Record
each clip as its own file (`A-council.mp4`, `C-seal.mp4`, …), so a retake costs one
clip, not the whole run.

## What to keep from the 12 November cut

| Keep | Time in the old cut | Change |
| --- | --- | --- |
| Problem animation | 0:00–0:25 | Trim to about 17 s (script below) |
| How-it-works animation | 0:25–0:52 | Change the enclave label `3ed58517…50d6` to **`f3173709…4bc8`**; trim to about 14 s |
| Logo end card | 2:25–2:29 | None |

Everything recorded live (0:52–1:53) is v1 and is replaced: it shows round 7 on
`nema-dev.testnet`, an exact result (94.50 ± 1.57) and a fee split five ways. The
"160 automated tests" card is replaced by a new closing card. The "what stays
private" and "who it's for" cards are cut for time (they fit back in with Premium).

## The film, second by second

About 2:11 in all, so 9 seconds of slack under 2:20. Narration runs at about 2.2
words a second, the pace of the old cut.

| Time | Scene | Source | Narration |
| --- | --- | --- | --- |
| 0:00–0:17 | The problem | old animation, trimmed | "This loan is worth ninety-four cents on the dollar. Says who? The fund that owns it. Private loans don't trade, so a lender has to take one fund's word for it. Other funds know better, but nobody shows their number first." |
| 0:17–0:31 | How it works | old animation, new hash label | "Nema gets the answer without anyone showing their hand. Each fund seals its price in its own browser. Only an enclave, a sealed box inside Intel hardware, can open it. And NEAR keeps the receipt." |
| 0:31–0:41 | The council | **clip A** | "Live on NEAR testnet. No single owner: a council registers loans and admits funds by vote. Two of three seats, and it passes." |
| 0:41–0:53 | A fund seals | **clip C** | "Our fund types its price, ninety-four eighty, and seals it. The chain stores scrambled bytes. Four more funds seal theirs. Nobody sees anyone's number." |
| 0:53–1:01 | Close | **clip D** | "The deadline passes, anyone can close, and the enclave counts. Published, but still sealed." |
| 1:01–1:17 | The rounded result | **clip E** | "Our fund counted, so it reads free. Ninety-four seventy-five, from five funds. The enclave drops the highest and lowest and rounds to an eighth, so even funds comparing notes can't work out anyone else's price." |
| 1:17–1:29 | Verify | **clip F** | "Don't trust us. Check. The browser recomputes the fingerprint of the sealed prices and checks each enclave run against Intel's signature. Six of six." |
| 1:29–1:39 | A lender pays | **clip G** | "A lender pays a tenth of a NEAR to read it. The funds who priced it split the fee, and the council takes five percent." |
| 1:39–1:49 | The auditor | **clip H** | "And a fund's auditor sees exactly what that fund sent. Not a copy it could edit. Nobody else can." |
| 1:49–2:05 | Closing card | new card | "Every fund's price stays private. Two hundred and eighty automated tests. Verified source. An enclave anyone can rebuild. Next: the council takes over upgrades, and the deployer's key is deleted." |
| 2:05–2:11 | Logo | old end card | "Nema. Agree on a price. Reveal nothing." |

**New closing card text:** `280 automated tests · contract · enclave · browser` |
`Verified source · v2.1 on SourceScan` | `Reproducible enclave · same hash on any machine` |
`Next: council-run upgrades, deployer key deleted`.

## Before you record

1. **Accounts.** Your wallet `nemalender.testnet` is already a council seat on
   `nema-v2.testnet`. In this run it also joins the panel as a fund and becomes
   fund4's auditor, so it is the only wallet you need. It has about 0.37 NEAR, enough:
   the run costs it about 0.1 NEAR, and the 0.05 NEAR bond comes back when you're admitted.
2. **Browser.** One window, one tab, full screen at 100% zoom, full desktop width
   (a narrow window switches to the phone layout). Bookmarks bar hidden,
   notifications off.
3. **Recorder.** Windows Game Bar (Win + Alt + R) records only the browser. With
   OBS, capture the browser window, not the display: the old cut showed OBS itself
   at a few points.
4. Never show a seed phrase or a private key. Wallet pop-ups are fine.
5. Tell me before you start: I hold off pushing to `main` (each push redeploys the site).
6. Move the mouse slowly and pause 2 seconds on each screen. Waits get cut later.

Steps marked **Claude** are mine. I sign them from the terminal with the other
council seats', the test funds' and the lender's keys. You never handle those keys.
Send me the word in quotes at each **Claude** step, then wait for "done".

## The run (about 45 minutes, in this order)

The order you record in is not the order of the film: the admission has to
happen before the round opens.

### Step 1. Apply as a fund (off camera)

Connect `nemalender.testnet`. Go to **Panel** → **Join the panel**. Leave
**Auditor** empty, note "Credit fund, private loans", press **Apply · 0.05 NEAR
bond, returned**, approve. Tell me **"applied"**.

> **Claude:** `pnpm live:demo-round approve --account nemalender.testnet`: two
> other seats approve, then the 5-minute veto window runs and you're admitted.
> Carry on with step 2 meanwhile.

### Step 2. Clip A: the council registers a loan (about 30 s raw)

Still on **Panel**, find **Register a loan**. Type exactly:
- **Borrower:** `Calder Logistics`
- **Facility:** `Senior term loan B`
- **Maturity:** `2030-06-30`

Press **Propose this loan**, approve. Pause on the proposal under the council's
decisions with **1 of 2** votes. Tell me **"proposed"**.

> **Claude:** `pnpm live:demo-round vote`: the second seat votes.

Reload **Panel**: the proposal has passed and **Calder Logistics** is in the loan
registry. Stop the clip.

> **Claude** (after "admitted" comes back): `pnpm live:demo-round open --borrower "Calder Logistics" --facility "Senior term loan B" --maturity 2030-06-30 --minutes 15`.
> Round 04 opens and closes in 15 minutes.

### Step 3. Clip C: seal a mark (about 40 s raw)

**Rounds** → round 04 → **Fund**. Type `94.80` in **Price, in points of par**.
Pause on "Encrypted in your browser before it leaves". Tick **Keep my mark on this
device**. Press **Seal and submit**, approve. Pause on the confirmation. (In the edit, add
the caption "94.80 appears nowhere on chain".) Tell me **"sealed"**.

> **Claude:** `pnpm live:demo-round marks --round 4` (fund1–4 seal theirs) and
> `pnpm live:demo-round auditor --fund fund4.nema-dev.testnet --auditor nemalender.testnet`
> (fund4 names you its auditor, for clip H).

Reload: the panel ring shows **5**. Stop the clip.

### Step 4. Clip D: close (about 30 s raw, after the 15 minutes)

Open round 04. Press **Close the round**, approve (anyone can close; most of the
0.01 NEAR enclave fee comes back). Wait for **Published** (about a minute; cut the
wait). Pause on the **Published** badge: count 5, and no mean or spread anywhere.

### Step 5. Clip E: the rounded result (about 40 s raw)

**Result** → "Your mark counted" → **Open your free copy · 0.03 NEAR**, approve,
and back up the key when asked (cut that part). The result unseals:
**94.75 ± 1.50 from 5 funds**. Pause on the line under it: "The mean of the middle
3 of 5 marks (the highest and lowest are left out), to the nearest eighth…". Then
**Vault** → **Where your marks sat**: your 94.80 next to the consensus. Tell me **"read"**.

> **Claude:** `pnpm live:demo-round read --round 4` (the lender pays 0.1 NEAR).

### Step 6. Clip F: verify (about 40 s raw)

Round 04 → **Verify**: the set hash on chain and the one your browser recomputed
match. Scroll to the enclave runs and wait for each ✓ (up to 30 s; cut the wait).
Pause on a run's **6 of 6 checks**.

### Step 7. Clip G: the fee is split (about 20 s raw)

**Vault** → **Earnings to withdraw**: about **0.0254 NEAR**. That is your fund's
share (0.02375) plus your council seat's (0.0016667) of the lender's 0.1 NEAR.
Optional: **Withdraw**, approve, and show it arrive in the wallet.

### Step 8. Clip H: the auditor (about 30 s raw)

**Audit** → "What your client sent, and what came back". Under `fund4`, press
**Open what fund4 sent · 0.03 NEAR**, approve. It shows fund4's mark exactly as
fund4 sealed it (**96.55**). Stop the clip. Tell me **"audited"**.

> **Claude:** `pnpm live:demo-round auditor --fund fund4.nema-dev.testnet --auditor none`
> (fund4 clears its auditor again).

### Step 9. Edit

1. Replace the hash label in the how-it-works animation and make the new closing card.
2. Cut the clips into the timeline above; cut every wait, wallet spinner and key backup.
3. Record the narration (or regenerate it) from the table; captions from the same text.
4. Export 1080p H.264 MP4, **2:20 or shorter**. For the README to play it inline,
   GitHub wants it under 10 MB on a free account; otherwise link it from the X post.
5. Don't put it in the repo: `media/` is ignored. You add it to the README yourself.

## If something goes wrong

- **A wallet pop-up hangs.** Cancel and press the button again. The app checks the
  chain before saying anything failed.
- **The page shows "offline" or doesn't update.** It refreshes every 15 seconds. Wait, or reload.
- **You're not admitted when the round opens.** Fine: you only need to be on the
  panel before you seal (step 3), not when the round opens.
- **You missed the deadline to seal.** Tell me. I open round 05, and you retake clips C–E.
- **The close fails** ("Retry the close"). Press it again; each try attaches another
  0.01 NEAR enclave fee. Tell me if it fails twice. (On v2 round 1, OutLayer was
  slow and it took three tries; the marks were kept each time.)
- **Clip G shows a different amount.** The council's share splits three ways, and
  the leftover yocto go to the first seat, so the last digits can differ.

## Optional extras (only with X Premium, about 15 s)

- **Who it's for** cards from the old cut (funds, lenders, auditors), after clip H.
- **The reader allowlist:** on **Panel**, the council's **Readers** card. "A panel can
  sell only to lenders its council vetted." This needs a council vote to switch on,
  and switching it on stops the lender's read, so record it after clip G and switch it off again.

## Cost

You (`nemalender.testnet`): about 0.1 NEAR, the bond comes back. Mine, from
`nema-dev.testnet` and its test accounts: about 0.01 to open, 0.12 for four marks,
0.13 for the lender's read, and gas for votes and approvals.

## Send me

The clip file names, and anything that went wrong or looked odd while you recorded.
