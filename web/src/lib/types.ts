export type RoundStatus = "AwaitingKey" | "Open" | "Closing" | "CloseFailed" | "Published" | "Failed";

export type Rejected = { account: string; reason: string };

export type Listing = {
  count: number;
  rejected: Rejected[];
  set_hash: string;
  commitment: string;
  contributors: string[];
};

/** `RoundView` from the contract. Timestamps are nanoseconds as decimal strings. */
export type Round = {
  id: string;
  /** The registered loan this round prices, and its label. */
  loan_id: string;
  loan: string;
  /** Who opened it. OutLayer files the key-derivation run under this account. */
  opened_by: string;
  status: RoundStatus;
  opened_at: string;
  closes_at: string;
  pubkey: string | null;
  submitted: string[];
  set_hash: string | null;
  listing: Listing | null;
  last_error: string | null;
  /** Who last asked the enclave to tally (absent on the first contract build). */
  closed_by?: string | null;
};

export type Submission = { account: string; ciphertext_hex: string; submitted_at: string };

export type PurchaseStatus = "Pending" | "Delivered" | "Refunded";

/** How a reader came by its copy: paid, or free because its mark (or its client's) counted. */
export type Basis = "Purchased" | "Contributed" | "Audit";

export type Purchase = {
  id: string;
  round_id: string;
  buyer: string;
  buyer_pubkey: string;
  price: string;
  basis: Basis;
  status: PurchaseStatus;
  sealed: string | null;
  error: string | null;
};

export type Config = {
  /** The accounts that decide admissions, removals, the price and the council itself. */
  council: string[];
  /** How many of them must agree. */
  threshold: number;
  /** Seconds an approved admission waits, so a council member can still veto it. */
  admit_delay_secs: number;
  /** The part of each paid read, in basis points, split among the council seats. Fixed at deploy. */
  council_share_bps: number;
  /** Seconds the council may go without a decision before the panel can replace it. */
  council_dormant_after_secs: number;
  /** When the council last made a decision (ns). */
  last_council_action: string;
  outlayer: string;
  project_id: string;
  min_contributors: number;
  read_price: string;
  application_bond: string;
  storage_deposit?: string;
  enclave_fee?: string;
  /** Paid reads limited to `readers` (v2.1 and later; absent before). */
  readers_only?: boolean;
  readers?: string[];
};

export type Application = {
  account: string;
  auditor: string | null;
  note: string;
  applied_at: string;
  bond: string;
  /** Council members who approved it. */
  approvals: string[];
  /** When anyone may admit it (set once enough have approved); null before. */
  ready_at: string | null;
};

/** What the council can put to a vote (the contract's `ProposalKind`, as JSON). */
export type ProposalKind =
  | { SetReadPrice: string }
  | { RemoveMember: string }
  | { AddCouncil: string }
  | { RemoveCouncil: string }
  /** How many council members must agree; the contract keeps it a majority. */
  | { SetThreshold: number }
  | { RegisterLoan: string }
  /** Takes a loan off the registry by id, once no round on it is running. */
  | { RemoveLoan: string }
  /** Changes nothing; it shows the panel the council is still there. */
  | "Heartbeat"
  /** Approves an account to buy reads while reads are limited to readers. */
  | { AddReader: string }
  | { RemoveReader: string }
  /** Limits paid reads to approved readers, or opens them to anyone again. */
  | { SetReadersOnly: boolean };

export type Proposal = { id: string; kind: ProposalKind; proposer: string; votes: string[]; created_at: string };

/** A vote by the panel's funds to replace a council that has gone quiet. */
export type Takeover = { council: string[]; threshold: number; proposer: string; votes: string[]; created_at: string };

/** A loan the council registered; rounds are opened on these. */
export type RegisteredLoan = { id: string; label: string };

export type AuditStatus = "Pending" | "Delivered" | "Failed";

/** One fund's submission, opened by the enclave and sealed to that fund's auditor. */
export type AuditCopy = {
  id: string;
  round_id: string;
  fund: string;
  auditor: string;
  auditor_pubkey: string;
  submitted_at: string;
  status: AuditStatus;
  sealed: string | null;
  error: string | null;
};

/** What the enclave seals for a buyer. */
/**
 * A buyer's opened result. `method` is "rounded" (a trimmed mean to an eighth of a
 * point, the spread to a quarter) for rounds tallied since rounding, "exact" for
 * earlier rounds, and absent from copies made before the enclave said which.
 */
export type Opened = { count: number; mean: string; spread: string; salt: string; method?: "rounded" | "exact" };

/** What the enclave seals for an auditor: the fund's own mark, in hundredths. */
export type AuditOpened = { kind: "audit"; account: string; round_id: number; mark: number };
