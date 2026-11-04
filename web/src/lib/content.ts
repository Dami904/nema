// Copy shared by Home and Docs.

export const WHO_SEES_WHAT = [
  { party: "A fund", sees: "Its own mark, and the result for free if its mark counted.", not: "Any other fund's mark." },
  { party: "A lender", sees: "The mean, spread and count it paid for.", not: "Any single fund's mark." },
  { party: "The owner", sees: "Who is on the panel and who submitted.", not: "Marks, or the result without paying." },
  { party: "A fund's auditor", sees: "That fund's own marks, opened by the enclave, and results it counted in.", not: "Any other fund's mark." },
  { party: "The public", sees: "Who submitted, the count, and a commitment.", not: "Marks or the result." },
  { party: "The enclave", sees: "Every mark in a round, for the moment it runs.", not: "Anything outside the round it was called for." },
  { party: "The chain", sees: "Ciphertexts, hashes, sealed copies, payments.", not: "Any number in the clear." },
];

export const TRUST = [
  "Privacy rests on the enclave hardware (Intel TDX, run by OutLayer) and its operator, not on a group of independent nodes.",
  "Only the round's contract can ask the enclave to tally or deliver, and only for the set of submissions it froze at the deadline.",
  "The enclave trusts the contract's account, not its code. While that account still holds a full-access key, whoever has the key could deploy different code and have the enclave tally a hand-picked set, which could expose marks. The Verify section shows if the code changes; removing the key closes this for good.",
  "A buyer who opens the result can share it. Nothing stops that.",
  "The owner picks the panel. That's a stated assumption, not something the code removes.",
  "A fund can shade its mark inside the valid range. Only out-of-range marks are caught.",
  "Your reading key lives in this browser's storage. Anything that can read the page's storage can open your reads, so keep the backup file private.",
  "A mark you choose to keep on this device is stored there in plain form, so you can see where it sat. Leave the box unticked on a shared computer.",
];

export const FAQ = [
  {
    q: "Can the owner of the contract read the marks?",
    a: "Not with the code that's deployed. Marks are encrypted in each fund's browser to a key that exists only inside the enclave, and the owner holds no key that opens one. But the enclave trusts the contract's account, and while that account keeps a full-access key it could be given different code. The Verify section shows the deployed code's hash so a change can't go unseen, and removing the key rules it out.",
  },
  {
    q: "Why does a round need at least four funds?",
    a: "With three or fewer, a mean and spread can give away individual prices. Below four valid marks a round publishes nothing, and the enclave enforces that floor whatever the contract asks.",
  },
  {
    q: "What stops a fund from submitting a silly number?",
    a: "Out-of-range marks are dropped and named, so one bad fund can't spoil a round. A fund can still shade its price inside the valid range; Nema doesn't claim to catch that.",
  },
  {
    q: "What happens if the enclave fails?",
    a: "Nothing gets stuck. A failed close can be retried by anyone, and a failed read refunds the buyer automatically. If the enclave never answers, anyone can settle the call after 30 minutes: the close is retried, the read refunded, the audit asked again.",
  },
  {
    q: "Can a lender share the result after buying it?",
    a: "Yes. Once opened, it's just numbers. Nema keeps the result private from everyone who hasn't paid, not from people a buyer chooses to tell.",
  },
  {
    q: "I bought a read on another computer. How do I open it here?",
    a: "Restore your key backup from the Vault. The result was sealed to that key, so without the backup it can't be opened anywhere else.",
  },
  {
    q: "Do funds pay to see the result?",
    a: "No. A fund whose mark counted gets one free copy per round, paying only the 0.01 NEAR enclave fee and a 0.02 NEAR storage deposit. Lenders pay the read price, and that fee is shared among the funds.",
  },
  {
    q: "What can a fund's auditor see?",
    a: "Only that fund's own marks, which the enclave opens from the ciphertext on chain once the round stops taking marks, and seals to the auditor, so the fund can't hand over a different number. It reads free only rounds that closed after it was named. The fund names or removes its auditor; the owner can't.",
  },
  {
    q: "Can a fund change its mark?",
    a: "Yes, until the deadline. The latest submission counts and replaces the earlier one.",
  },
];
