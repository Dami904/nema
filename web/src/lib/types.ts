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
  loan: string;
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
  owner: string;
  outlayer: string;
  project_id: string;
  min_contributors: number;
  read_price: string;
  application_bond: string;
  storage_deposit?: string;
  enclave_fee?: string;
};

export type Application = { account: string; auditor: string | null; note: string; applied_at: string; bond: string };

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
export type Opened = { count: number; mean: string; spread: string; salt: string };

/** What the enclave seals for an auditor: the fund's own mark, in hundredths. */
export type AuditOpened = { kind: "audit"; account: string; round_id: number; mark: number };
