//! Nema: a panel of funds agrees on a price without showing each other their
//! numbers, and only paying readers learn the price.
//!
//! Funds submit their mark encrypted to a key that only an OutLayer enclave can
//! use. When the round closes the contract hands the ciphertexts to the enclave,
//! which decrypts them and computes the count, mean and spread. Only the count
//! and a commitment (a salted hash of the result) come back on chain. A buyer
//! pays, supplies a public key, and the enclave returns the result encrypted to
//! that key. The fee is shared among the funds that contributed.
//!
//! What is public on chain: who submitted, when, the ciphertexts, the hash of the
//! submission set, the count, the commitment, who bought, and each buyer's sealed
//! copy. What is not: any individual mark, or the mean and spread.
//!
//! Enclave interface (implemented in `aggregator/`):
//!   derive_pubkey  in:  {"action":"derive_pubkey","contract":<id>,"round_id":<n>}
//!                  out: {"ok":true,"pubkey":"<33-byte compressed secp256k1, hex>"}
//!   tally          in:  {"action":"tally","contract":<id>,"round_id":<n>,
//!                        "min_contributors":<n>,"set_hash":"<hex>",
//!                        "submissions":[{"account":..,"ciphertext_hex":..}]}
//!                  out: {"ok":true,"count":<n>,"rejected":[{"account":..,"reason":..}],
//!                        "set_hash":"<hex>","commitment":"<hex>"}
//!   deliver        in:  tally's fields plus "commitment" and "buyer_pubkey"
//!                  out: {"ok":true,"set_hash":..,"commitment":..,"sealed":"<hex>"}
//!   audit          in:  {"action":"audit","contract","round_id","account",
//!                        "ciphertext_hex","auditor_pubkey"}
//!                  out: {"ok":true,"sealed":"<hex>"}
//!
//! Funds whose marks counted, and the auditors those funds name, open the result
//! for free (once per round); everyone else pays the read price. An auditor reads
//! free only rounds that closed after the fund named it. A fund's auditor can also
//! have the enclave open that fund's own submission once the round stops taking
//! marks, and no one else's. Every read and audit leaves a 0.02 NEAR storage
//! deposit with the contract for the record it keeps.
//!
//! set_hash = sha256 over, for each submission sorted by account:
//!   u32 little-endian length of the account id || the account id bytes ||
//!   sha256(ciphertext_hex as utf-8 bytes).

use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{
    borsh, env, ext_contract, log, near, require, AccountId, BorshStorageKey, Gas, IntoStorageKey,
    NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};
use serde_json::{json, Value};
use std::collections::HashSet;

/// Least NEAR attached to an enclave request (0.01 NEAR). Unused deposit is refunded
/// to the payer by OutLayer.
const MIN_OUTLAYER_DEPOSIT: u128 = 10_000_000_000_000_000_000_000;
/// The most of a caller's deposit forwarded to OutLayer; any surplus goes straight
/// back. If OutLayer refuses the call itself, NEAR returns the fee to this contract,
/// which passes it on to the payer, so the cap bounds what that path can cost.
const MAX_OUTLAYER_DEPOSIT: u128 = 50_000_000_000_000_000_000_000;
const CALLBACK_GAS: Gas = Gas::from_tgas(40);
/// For the callback after a payment, which only puts the amount back on failure.
const PAY_GAS: Gas = Gas::from_tgas(8);
const MAX_MEMBERS: u32 = 64;
const MAX_COUNCIL: usize = 7;
/// The least a council may be allowed to stay silent before the panel can replace it.
const MIN_DORMANT_SECS: u64 = 24 * 3600;
/// How long a vote to replace the council stays open.
const TAKEOVER_TTL_NS: u64 = 14 * 24 * 3600 * 1_000_000_000;
/// The most of a read fee the council may be paid, in basis points (20%). It is set
/// when the contract is created and cannot be raised by a vote.
const MAX_COUNCIL_SHARE_BPS: u32 = 2_000;
/// The most loans the registry holds at once. The council removes old ones to make room.
const MAX_LOANS: u32 = 64;
/// A proposal that has not reached the threshold this long after it was made lapses.
const PROPOSAL_TTL_NS: u64 = 7 * 24 * 3600 * 1_000_000_000;
/// The longest a round can stay open, so no round can hold a loan forever.
const MAX_ROUND_NS: u64 = 30 * 24 * 3600 * 1_000_000_000;
/// How many open proposals one council member may have at a time, so one seat
/// can't fill storage or make `propose` too costly to run.
const MAX_OPEN_PROPOSALS_PER_MEMBER: usize = 4;
/// The most accounts the council can approve as readers.
const MAX_READERS: usize = 128;
const MAX_CIPHERTEXT_HEX: usize = 2048;
const MIN_CIPHERTEXT_HEX: usize = 64;
/// A sealed delivery is ECIES overhead (97 bytes) plus a short JSON result.
const MAX_SEALED_HEX: usize = 1600;
/// Held while an application is pending and returned whatever the outcome, so
/// nobody can fill the queue for free.
const APPLICATION_BOND: u128 = 50_000_000_000_000_000_000_000;
const MAX_APPLICATIONS: u32 = 32;
const MAX_NOTE: usize = 140;
/// Kept by the contract on every read and audit to pay for the record it stores
/// (up to about 2 KB with the sealed copy), so readers can't spend its balance.
const STORAGE_DEPOSIT: u128 = 20_000_000_000_000_000_000_000;
/// Enclave errors are stored on chain; longer ones are cut.
const MAX_ERROR: usize = 200;
/// How long an enclave call may stay unanswered before anyone can settle it as
/// failed. OutLayer answers or times out within minutes; this is the backstop for
/// a callback that never applied (for example one that ran out of gas).
const STALE_AFTER_NS: u64 = 30 * 60 * 1_000_000_000;

#[ext_contract(ext_outlayer)]
#[allow(dead_code)]
trait OutLayer {
    fn request_execution(
        &mut self,
        source: Value,
        resource_limits: Option<Value>,
        input_data: Option<String>,
        secrets_ref: Option<Value>,
        response_format: Option<String>,
        payer_account_id: Option<AccountId>,
    );
}

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    Members,
    Rounds,
    Purchases,
    Earnings,
    Applications,
    Auditors,
    Audits,
    PurchasesByBuyer,
    AuditsByAuditor,
    PendingSince,
    Proposals,
    Loans,
    LatestRound,
    /// The readers the council approved, one borsh `Vec<AccountId>`. Kept outside
    /// the contract's state struct, so adding it needed no state migration.
    Readers,
    /// Present (one byte) while paid reads are limited to approved readers.
    ReadersOnly,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RoundStatus {
    /// The enclave is deriving this round's public key.
    AwaitingKey,
    Open,
    /// Waiting for the enclave to return the tally.
    Closing,
    /// The enclave call failed or returned something unusable. Closing can be retried.
    CloseFailed,
    /// The count and commitment are on chain; the result can be bought.
    Published,
    /// Terminal: the key derivation failed, or too few funds submitted.
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Submission {
    pub account: AccountId,
    pub ciphertext_hex: String,
    pub submitted_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Rejected {
    pub account: String,
    pub reason: String,
}

/// What a published round shows everyone: how many funds counted, who was
/// dropped and why, and a commitment to the result. Not the result itself.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Listing {
    pub count: u32,
    pub rejected: Vec<Rejected>,
    pub set_hash: String,
    pub commitment: String,
    /// The funds whose marks counted. They share each read fee.
    pub contributors: Vec<AccountId>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Round {
    pub id: u64,
    pub loan_id: u64,
    pub loan: String,
    pub opened_by: AccountId,
    pub opened_at: u64,
    pub closes_at: u64,
    pub status: RoundStatus,
    pub pubkey: Option<String>,
    pub submissions: Vec<Submission>,
    pub set_hash: Option<String>,
    pub listing: Option<Listing>,
    pub last_error: Option<String>,
    /// Who last asked the enclave to tally. OutLayer files each run under the
    /// account that signed it, so this is how the site finds the tally's attestation.
    pub closed_by: Option<AccountId>,
}

/// A round without the ciphertexts, for views.
#[near(serializers = [json])]
pub struct RoundView {
    pub id: U64,
    pub loan_id: U64,
    pub loan: String,
    pub opened_by: AccountId,
    pub status: RoundStatus,
    pub opened_at: U64,
    pub closes_at: U64,
    pub pubkey: Option<String>,
    pub submitted: Vec<AccountId>,
    pub set_hash: Option<String>,
    pub listing: Option<Listing>,
    pub last_error: Option<String>,
    pub closed_by: Option<AccountId>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PurchaseStatus {
    /// Paid; waiting for the enclave to seal the result.
    Pending,
    /// The sealed result is stored; the fee went to the contributors.
    Delivered,
    /// The enclave failed; the fee went back to the buyer.
    Refunded,
}

/// How a reader came to hold a copy of a result.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Basis {
    /// Paid the read price.
    Purchased,
    /// Its mark counted in the round: free.
    Contributed,
    /// Auditor of a fund whose mark counted: free.
    Audit,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Purchase {
    pub id: U64,
    pub round_id: U64,
    pub buyer: AccountId,
    pub buyer_pubkey: String,
    pub price: U128,
    pub basis: Basis,
    pub status: PurchaseStatus,
    /// The result encrypted to `buyer_pubkey`. Only the buyer can open it.
    pub sealed: Option<String>,
    pub error: Option<String>,
}

/// A fund asking to join the panel. The council approves or rejects it.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Application {
    pub account: AccountId,
    /// Who the fund wants to audit its submissions, if anyone.
    pub auditor: Option<AccountId>,
    pub note: String,
    pub applied_at: U64,
    pub bond: U128,
    /// Council members who approved it. At the threshold the veto window starts.
    pub approvals: Vec<AccountId>,
    /// When the fund may be admitted (anyone can finalize), once the threshold is
    /// met. Any council member can still reject it before then.
    pub ready_at: Option<U64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AuditStatus {
    Pending,
    Delivered,
    Failed,
}

/// One fund's submission, opened by the enclave and sealed to that fund's auditor.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct AuditCopy {
    pub id: U64,
    pub round_id: U64,
    pub fund: AccountId,
    pub auditor: AccountId,
    pub auditor_pubkey: String,
    /// When the audited version of the submission was made.
    pub submitted_at: U64,
    pub status: AuditStatus,
    pub sealed: Option<String>,
    pub error: Option<String>,
}

/// The auditor a fund named, and when. An auditor reads for free only the rounds
/// that closed after it was named, so a fund can't name a lender after the fact
/// to hand it a free copy.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Appointment {
    pub auditor: AccountId,
    pub since: U64,
}

/// What the council can decide by vote.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum ProposalKind {
    SetReadPrice(U128),
    RemoveMember(AccountId),
    AddCouncil(AccountId),
    RemoveCouncil(AccountId),
    /// How many council members must agree. It stays a majority, and at least 2.
    SetThreshold(u32),
    /// Adds a loan, by label, that funds may open rounds on.
    RegisterLoan(String),
    /// Takes a loan off the registry, once no round on it is running. Rounds
    /// already run on it keep their label.
    RemoveLoan(U64),
    /// Changes nothing. It is how a council that has nothing else to decide shows
    /// the panel it is still there.
    Heartbeat,
    // New kinds go after the existing ones, so proposals already stored keep
    // their borsh tags.
    /// Approves an account to buy reads while reads are limited to readers.
    AddReader(AccountId),
    RemoveReader(AccountId),
    /// Limits paid reads to approved readers (true) or opens them to anyone (false,
    /// the default). Free copies for contributing funds and their auditors are
    /// never limited.
    SetReadersOnly(bool),
}

/// A vote by the panel's funds to replace a council that has made no decision for
/// too long. It dies if the council decides anything before it passes.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Takeover {
    pub council: Vec<AccountId>,
    pub threshold: u32,
    pub proposer: AccountId,
    pub votes: Vec<AccountId>,
    pub created_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Proposal {
    pub id: U64,
    pub kind: ProposalKind,
    pub proposer: AccountId,
    pub votes: Vec<AccountId>,
    pub created_at: U64,
}

#[near(serializers = [json])]
pub struct LoanView {
    pub id: U64,
    pub label: String,
}

#[near(serializers = [json])]
struct KeyOut {
    ok: Option<bool>,
    pubkey: Option<String>,
    error: Option<String>,
}

#[near(serializers = [json])]
struct TallyOut {
    ok: bool,
    count: Option<u32>,
    rejected: Option<Vec<Rejected>>,
    set_hash: Option<String>,
    commitment: Option<String>,
    error: Option<String>,
}

#[near(serializers = [json])]
struct AuditOut {
    ok: bool,
    sealed: Option<String>,
    error: Option<String>,
}

#[near(serializers = [json])]
struct DeliverOut {
    ok: bool,
    set_hash: Option<String>,
    commitment: Option<String>,
    sealed: Option<String>,
    error: Option<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Nema {
    /// Decides admissions, removals, the read price and the council itself.
    council: Vec<AccountId>,
    /// How many council members must agree.
    threshold: u32,
    /// How long after the threshold is met an admission waits, for a veto.
    admit_delay_ns: u64,
    /// The part of each paid read, in basis points, split equally among the council
    /// seats: the pay for keeping the panel running. Fixed at deploy.
    council_share_bps: u32,
    /// How long the council may make no decision before the panel can replace it.
    council_dormant_ns: u64,
    /// When the council last made a decision (a proposal passed, or an admission
    /// reached its threshold). One member acting alone does not count.
    last_council_action: u64,
    takeover: Option<Takeover>,
    outlayer_id: AccountId,
    /// e.g. "nema-dev.testnet/nema-aggregator"
    project_id: String,
    /// The account that stored the enclave-generated master secret, and its profile.
    secrets_account: AccountId,
    secrets_profile: String,
    /// A round publishes nothing below this many funds: with three or fewer, a mean
    /// and spread can reveal individual marks.
    min_contributors: u32,
    /// What a buyer pays to read one round's result, shared among its contributors.
    read_price: u128,
    members: IterableSet<AccountId>,
    rounds: IterableMap<u64, Round>,
    next_round_id: u64,
    purchases: IterableMap<u64, Purchase>,
    next_purchase_id: u64,
    /// Read fees owed to each account, paid out by `withdraw`.
    earnings: LookupMap<AccountId, u128>,
    applications: IterableMap<AccountId, Application>,
    /// fund -> the auditor it named. Only the fund can set or clear it.
    auditors: LookupMap<AccountId, Appointment>,
    audits: IterableMap<u64, AuditCopy>,
    next_audit_id: u64,
    purchases_by_buyer: LookupMap<AccountId, Vec<u64>>,
    audits_by_auditor: LookupMap<AccountId, Vec<u64>>,
    /// When the enclave call behind a Closing round ("r{id}"), a Pending read
    /// ("p{id}") or a Pending audit ("a{id}") went out. Cleared when it settles.
    pending_since: LookupMap<String, u64>,
    proposals: IterableMap<u64, Proposal>,
    next_proposal_id: u64,
    /// The loans a round can be opened on: id -> label.
    loans: IterableMap<u64, String>,
    next_loan_id: u64,
    /// The latest round opened on each loan: loan id -> round id. Only that round
    /// can still be running, since a loan holds one live round at a time.
    latest_round: LookupMap<u64, u64>,
}

#[near]
impl Nema {
    /// `council` and `threshold` replace a single owner: the council admits funds,
    /// removes them, sets the read price and edits itself, by vote. `initial_members`
    /// are the founding funds, named in public at deploy; later funds apply.
    /// `loans` are the loans a round can first be opened on.
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        council: Vec<AccountId>,
        threshold: u32,
        admit_delay_secs: u64,
        council_dormant_after_secs: u64,
        outlayer_id: AccountId,
        project_id: String,
        secrets_account: AccountId,
        secrets_profile: String,
        min_contributors: u32,
        read_price: U128,
        council_share_bps: u32,
        initial_members: Vec<AccountId>,
        loans: Vec<String>,
    ) -> Self {
        require!(
            min_contributors >= 4,
            "the minimum must be at least 4 funds"
        );
        require!(
            council_share_bps <= MAX_COUNCIL_SHARE_BPS,
            "the council's share of a read is at most 20%"
        );
        Self::assert_valid_council(&council, threshold);
        require!(
            council_dormant_after_secs >= MIN_DORMANT_SECS,
            "the council must be allowed at least a day of silence"
        );
        require!(
            initial_members.len() <= MAX_MEMBERS as usize,
            "too many founding funds"
        );
        let mut me = Self {
            council,
            threshold,
            admit_delay_ns: admit_delay_secs.saturating_mul(1_000_000_000),
            council_share_bps,
            council_dormant_ns: council_dormant_after_secs.saturating_mul(1_000_000_000),
            last_council_action: env::block_timestamp(),
            takeover: None,
            outlayer_id,
            project_id,
            secrets_account,
            secrets_profile,
            min_contributors,
            read_price: read_price.0,
            members: IterableSet::new(StorageKey::Members),
            rounds: IterableMap::new(StorageKey::Rounds),
            next_round_id: 1,
            purchases: IterableMap::new(StorageKey::Purchases),
            next_purchase_id: 1,
            earnings: LookupMap::new(StorageKey::Earnings),
            applications: IterableMap::new(StorageKey::Applications),
            auditors: LookupMap::new(StorageKey::Auditors),
            audits: IterableMap::new(StorageKey::Audits),
            next_audit_id: 1,
            purchases_by_buyer: LookupMap::new(StorageKey::PurchasesByBuyer),
            audits_by_auditor: LookupMap::new(StorageKey::AuditsByAuditor),
            pending_since: LookupMap::new(StorageKey::PendingSince),
            proposals: IterableMap::new(StorageKey::Proposals),
            next_proposal_id: 1,
            loans: IterableMap::new(StorageKey::Loans),
            next_loan_id: 1,
            latest_round: LookupMap::new(StorageKey::LatestRound),
        };
        for m in initial_members {
            me.members.insert(m);
        }
        for label in loans {
            me.add_loan(label);
        }
        me
    }

    // ---- council ----

    /// A council member's vote to admit an applicant. At the threshold the veto
    /// window opens: any council member can still `reject`, and once the window has
    /// passed anyone can call `finalize_admission`.
    pub fn approve(&mut self, account: AccountId) {
        self.assert_council();
        let who = env::predecessor_account_id();
        let mut app = self
            .applications
            .get(&account)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no such application"));
        require!(
            !app.approvals.contains(&who),
            "you already approved this application"
        );
        app.approvals.push(who);
        // Approvals from accounts since removed from the council do not count.
        let approvals = app
            .approvals
            .iter()
            .filter(|a| self.council.contains(a))
            .count() as u32;
        if app.ready_at.is_none() && approvals >= self.threshold {
            let ready = env::block_timestamp().saturating_add(self.admit_delay_ns);
            app.ready_at = Some(U64(ready));
            self.mark_council_active();
            emit(
                "admission_ready",
                json!({"account": account, "ready_at": U64(ready)}),
            );
        }
        self.applications.insert(account, app);
    }

    /// Admit an approved applicant once its veto window has passed. Anyone may call
    /// it. The applicant's bond is returned.
    pub fn finalize_admission(&mut self, account: AccountId) -> Promise {
        let app = self
            .applications
            .get(&account)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no such application"));
        let ready_at = app
            .ready_at
            .unwrap_or_else(|| env::panic_str("not approved by enough council members yet"));
        require!(
            env::block_timestamp() >= ready_at.0,
            "the veto window is still open"
        );
        require!(self.members.len() < MAX_MEMBERS, "the panel is full");
        self.applications.remove(&account);
        self.members.insert(account.clone());
        if let Some(auditor) = app.auditor {
            self.auditors.insert(
                account.clone(),
                Appointment {
                    auditor,
                    since: U64(env::block_timestamp()),
                },
            );
        }
        emit("member_admitted", json!({"account": account}));
        Self::pay(account, app.bond.0)
    }

    /// A council member turns an applicant away, or vetoes an approved one before
    /// it is finalized. Its bond is returned.
    pub fn reject(&mut self, account: AccountId) -> Promise {
        self.assert_council();
        let app = self
            .applications
            .remove(&account)
            .unwrap_or_else(|| env::panic_str("no such application"));
        emit(
            "application_rejected",
            json!({"account": account, "by": env::predecessor_account_id()}),
        );
        Self::pay(account, app.bond.0)
    }

    /// A council member puts a decision to the council. Their proposal counts as
    /// their vote; it runs at the threshold. Returns the proposal's id.
    pub fn propose(&mut self, kind: ProposalKind) -> U64 {
        self.assert_council();
        self.check_proposal(&kind);
        self.prune_lapsed_proposals();
        let proposer = env::predecessor_account_id();
        let open = self
            .proposals
            .values()
            .filter(|p| p.proposer == proposer)
            .count();
        require!(
            open < MAX_OPEN_PROPOSALS_PER_MEMBER,
            "you have 4 proposals open; let one pass or lapse first"
        );
        let id = self.next_proposal_id;
        self.next_proposal_id += 1;
        let proposal = Proposal {
            id: U64(id),
            kind,
            proposer: proposer.clone(),
            votes: vec![proposer],
            created_at: U64(env::block_timestamp()),
        };
        emit("proposal_made", json!({"id": id, "kind": proposal.kind}));
        self.proposals.insert(id, proposal);
        self.run_if_passed(id);
        U64(id)
    }

    /// A council member's vote for a proposal.
    pub fn vote(&mut self, proposal_id: U64) {
        self.assert_council();
        let who = env::predecessor_account_id();
        let proposal = self
            .proposals
            .get_mut(&proposal_id.0)
            .unwrap_or_else(|| env::panic_str("no such proposal"));
        require!(
            !proposal_lapsed(proposal, env::block_timestamp()),
            "this proposal has lapsed"
        );
        require!(!proposal.votes.contains(&who), "you already voted");
        proposal.votes.push(who);
        self.run_if_passed(proposal_id.0);
    }

    // ---- when the council goes quiet ----

    /// A panel fund asks the panel to replace the council. Allowed only once the
    /// council has made no decision for `council_dormant_after_secs`. The new
    /// council needs the same shape as the original (3 to 7 accounts, a majority
    /// threshold). It passes when two thirds of the panel's funds vote for it, and
    /// dies if the council decides anything first.
    pub fn propose_council_takeover(&mut self, council: Vec<AccountId>, threshold: u32) {
        let who = env::predecessor_account_id();
        require!(self.members.contains(&who), "only a panel fund can do this");
        let now = env::block_timestamp();
        require!(
            now >= self
                .last_council_action
                .saturating_add(self.council_dormant_ns),
            "the council has made a decision recently"
        );
        require!(
            !self.takeover_is_live(now),
            "a vote to replace the council is already running"
        );
        require!(
            self.members.len() >= self.min_contributors,
            "too few funds on the panel to replace the council"
        );
        Self::assert_valid_council(&council, threshold);
        emit(
            "council_takeover_proposed",
            json!({"proposer": who, "council": council, "threshold": threshold}),
        );
        self.takeover = Some(Takeover {
            council,
            threshold,
            proposer: who.clone(),
            votes: vec![who],
            created_at: U64(now),
        });
        self.run_takeover_if_passed();
    }

    /// A panel fund's vote for the running takeover.
    pub fn vote_council_takeover(&mut self) {
        let who = env::predecessor_account_id();
        require!(self.members.contains(&who), "only a panel fund can do this");
        require!(
            self.takeover_is_live(env::block_timestamp()),
            "no vote to replace the council is running: it lapsed, or the council acted"
        );
        let takeover = self
            .takeover
            .as_mut()
            .unwrap_or_else(|| env::panic_str("no takeover"));
        require!(!takeover.votes.contains(&who), "you already voted");
        takeover.votes.push(who);
        self.run_takeover_if_passed();
    }

    // ---- joining ----

    /// Ask to join the panel. Attach the 0.05 NEAR bond, returned when the
    /// application is approved, rejected or withdrawn.
    #[payable]
    pub fn apply(&mut self, auditor: Option<AccountId>, note: Option<String>) {
        let who = env::predecessor_account_id();
        let bond = env::attached_deposit().as_yoctonear();
        require!(
            bond >= APPLICATION_BOND,
            "attach the 0.05 NEAR application bond"
        );
        require!(!self.members.contains(&who), "already a panel member");
        require!(!self.applications.contains_key(&who), "already applied");
        require!(
            self.applications.len() < MAX_APPLICATIONS,
            "too many applications are waiting; try later"
        );
        require!(auditor.as_ref() != Some(&who), "a fund cannot audit itself");
        let note = note.unwrap_or_default();
        require!(
            note.len() <= MAX_NOTE,
            "the note must be at most 140 characters"
        );
        self.applications.insert(
            who.clone(),
            Application {
                account: who,
                auditor,
                note,
                applied_at: U64(env::block_timestamp()),
                bond: U128(bond),
                approvals: vec![],
                ready_at: None,
            },
        );
    }

    pub fn withdraw_application(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let app = self
            .applications
            .remove(&who)
            .unwrap_or_else(|| env::panic_str("no application to withdraw"));
        Self::pay(who, app.bond.0)
    }

    /// A panel fund names (or, with `null`, clears) the account allowed to audit
    /// its submissions and read its rounds' results for free.
    pub fn set_auditor(&mut self, auditor: Option<AccountId>) {
        let who = env::predecessor_account_id();
        require!(self.members.contains(&who), "not a panel member");
        match auditor {
            Some(a) => {
                require!(a != who, "a fund cannot audit itself");
                // Naming the same auditor again keeps its original date.
                if self.auditors.get(&who).map(|ap| &ap.auditor) != Some(&a) {
                    self.auditors.insert(
                        who,
                        Appointment {
                            auditor: a,
                            since: U64(env::block_timestamp()),
                        },
                    );
                }
            }
            None => {
                self.auditors.remove(&who);
            }
        }
    }

    // ---- rounds ----

    /// Open a round on a registered loan. Panel funds and council members can.
    /// The enclave derives this round's public key; funds can
    /// submit once the key arrives. Attach at least 0.01 NEAR for the enclave call.
    #[payable]
    pub fn open_round(&mut self, loan_id: U64, closes_at: U64) -> Promise {
        let opener = env::predecessor_account_id();
        require!(
            self.members.contains(&opener) || self.council.contains(&opener),
            "only panel funds and the council can open a round"
        );
        let loan = self
            .loans
            .get(&loan_id.0)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no such loan; the council registers loans"));
        require!(
            !self.has_active_round(loan_id.0),
            "a round on this loan is already running"
        );
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= MIN_OUTLAYER_DEPOSIT,
            "attach at least 0.01 NEAR for the enclave call"
        );
        require!(
            self.members.len() >= self.min_contributors,
            "too few funds on the panel to ever publish a result"
        );
        let now = env::block_timestamp();
        require!(closes_at.0 > now, "closes_at must be in the future");
        require!(
            closes_at.0 <= now.saturating_add(MAX_ROUND_NS),
            "a round can stay open at most 30 days"
        );

        let id = self.next_round_id;
        self.next_round_id += 1;
        self.rounds.insert(
            id,
            Round {
                id,
                loan_id: loan_id.0,
                loan,
                opened_by: opener,
                opened_at: now,
                closes_at: closes_at.0,
                status: RoundStatus::AwaitingKey,
                pubkey: None,
                submissions: vec![],
                set_hash: None,
                listing: None,
                last_error: None,
                closed_by: None,
            },
        );
        self.latest_round.insert(loan_id.0, id);

        emit(
            "round_created",
            json!({"round_id": id, "closes_at": closes_at}),
        );
        let input = json!({
            "action": "derive_pubkey",
            "contract": env::current_account_id(),
            "round_id": id,
        });
        let payer = env::predecessor_account_id();
        let (call, fee) = self.request_enclave(input, attached, &payer);
        call.then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_round_key(id, payer, U128(fee)),
        )
    }

    /// Submit (or replace) a fund's encrypted mark. The latest submission before the
    /// round closes counts. The fund pays for the storage its mark adds: attach up
    /// to 0.03 NEAR (enough for the largest mark) and the unused part comes back.
    #[payable]
    pub fn submit(&mut self, round_id: u64, ciphertext_hex: String) -> PromiseOrValue<()> {
        let who = env::predecessor_account_id();
        let before = env::storage_usage();
        require!(self.members.contains(&who), "not a panel member");
        validate_ciphertext_hex(&ciphertext_hex);
        let now = env::block_timestamp();
        let round = self
            .rounds
            .get_mut(&round_id)
            .unwrap_or_else(|| env::panic_str("no such round"));
        require!(round.status == RoundStatus::Open, "the round is not open");
        require!(now < round.closes_at, "the round has closed");
        let sub = Submission {
            account: who.clone(),
            ciphertext_hex,
            submitted_at: U64(now),
        };
        match round.submissions.iter_mut().find(|s| s.account == who) {
            Some(existing) => *existing = sub,
            None => round.submissions.push(sub),
        }
        // Write the round now so the storage it grew by can be measured and charged.
        self.rounds.flush();
        let added = env::storage_usage().saturating_sub(before);
        let cost = added as u128 * env::storage_byte_cost().as_yoctonear();
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= cost,
            format!("attach at least {cost} yoctoNEAR for the storage this mark uses")
        );
        emit(
            "mark_submitted",
            json!({"round_id": round_id, "account": who, "storage_cost": U128(cost)}),
        );
        if attached > cost {
            PromiseOrValue::Promise(Self::pay(who, attached - cost))
        } else {
            PromiseOrValue::Value(())
        }
    }

    /// Anyone can close a round once its time is up. Attach at least 0.01 NEAR for the
    /// enclave call; a round with too few submissions fails without calling the
    /// enclave and the deposit is returned. A failed close can be retried.
    #[payable]
    pub fn close_round(&mut self, round_id: u64) -> PromiseOrValue<()> {
        let caller = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= MIN_OUTLAYER_DEPOSIT,
            "attach at least 0.01 NEAR for the enclave call"
        );
        let now = env::block_timestamp();
        let min = self.min_contributors as usize;

        let round = self
            .rounds
            .get_mut(&round_id)
            .unwrap_or_else(|| env::panic_str("no such round"));
        require!(
            matches!(
                round.status,
                RoundStatus::Open | RoundStatus::CloseFailed | RoundStatus::AwaitingKey
            ),
            "the round cannot be closed in its current state"
        );
        require!(now >= round.closes_at, "the round is still open");

        // A round whose key never arrived took no marks; past its deadline it is
        // simply ended, so it cannot sit in AwaitingKey forever.
        if round.status == RoundStatus::AwaitingKey {
            round.status = RoundStatus::Failed;
            round.last_error = Some("the round never received its key from the enclave".into());
            return PromiseOrValue::Promise(Self::pay(caller, attached));
        }

        // A fund removed from the panel before the round closed doesn't count: the
        // panel is checked when the set is committed, not only when the mark arrived.
        let members = &self.members;
        let before = round.submissions.len();
        round.submissions.retain(|s| members.contains(&s.account));
        if round.submissions.len() < before {
            emit(
                "marks_dropped",
                json!({"round_id": round_id, "reason": "no longer on the panel", "count": before - round.submissions.len()}),
            );
        }

        if round.submissions.len() < min {
            round.status = RoundStatus::Failed;
            round.last_error = Some(format!(
                "only {} of the required {} funds submitted",
                round.submissions.len(),
                min
            ));
            return PromiseOrValue::Promise(Self::pay(caller, attached));
        }

        let set_hash = compute_set_hash(&round.submissions);
        round.set_hash = Some(set_hash.clone());
        round.status = RoundStatus::Closing;
        round.closed_by = Some(caller.clone());
        round.last_error = None;
        let input = enclave_input("tally", round_id, min, round);
        self.pending_since.insert(format!("r{round_id}"), now);
        emit(
            "tally_requested",
            json!({"round_id": round_id, "set_hash": set_hash, "by": caller}),
        );

        let (call, fee) = self.request_enclave(input, attached, &caller);
        PromiseOrValue::Promise(
            call.then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_tally(round_id, caller, U128(fee), U64(now)),
            ),
        )
    }

    // ---- reading a published round ----

    /// Buy one round's result. `buyer_pubkey` is a compressed secp256k1 public key
    /// (hex) whose secret only the buyer holds; the enclave encrypts the result to
    /// it. Attach the read price, the 0.02 NEAR storage deposit and at least 0.01
    /// NEAR for the enclave call. If the enclave fails, the read price is refunded.
    #[payable]
    pub fn buy_read(&mut self, round_id: u64, buyer_pubkey: String) -> Promise {
        let buyer = env::predecessor_account_id();
        require!(
            !readers_only() || readers().contains(&buyer),
            "reads on this panel are limited to readers the council approved"
        );
        let attached = env::attached_deposit().as_yoctonear();
        let price = self.read_price;
        require!(
            attached >= price + STORAGE_DEPOSIT + MIN_OUTLAYER_DEPOSIT,
            "attach the read price, the 0.02 NEAR storage deposit and at least 0.01 NEAR for the enclave call"
        );
        self.start_read(
            round_id,
            buyer,
            buyer_pubkey,
            price,
            Basis::Purchased,
            attached - price - STORAGE_DEPOSIT,
        )
    }

    /// A free copy of the result for a fund whose mark counted, or for an auditor
    /// that fund named before the round closed. One copy per account per round
    /// (another can be claimed only if the last one failed). Attach the 0.02 NEAR
    /// storage deposit and at least 0.01 NEAR for the enclave call.
    #[payable]
    pub fn claim_read(&mut self, round_id: u64, buyer_pubkey: String) -> Promise {
        let who = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= STORAGE_DEPOSIT + MIN_OUTLAYER_DEPOSIT,
            "attach the 0.02 NEAR storage deposit and at least 0.01 NEAR for the enclave call"
        );
        let round = self
            .rounds
            .get(&round_id)
            .unwrap_or_else(|| env::panic_str("no such round"));
        require!(
            round.status == RoundStatus::Published,
            "the round has no published result"
        );
        let basis = self.free_basis(round, &who).unwrap_or_else(|| {
            env::panic_str("only funds whose marks counted, and their auditors, read for free")
        });
        let claimed = self
            .purchase_ids_of(&who)
            .iter()
            .filter_map(|id| self.purchases.get(id))
            .any(|p| {
                p.round_id.0 == round_id
                    && p.basis != Basis::Purchased
                    && p.status != PurchaseStatus::Refunded
            });
        require!(!claimed, "you already have a free copy of this round");
        self.start_read(
            round_id,
            who,
            buyer_pubkey,
            0,
            basis,
            attached - STORAGE_DEPOSIT,
        )
    }

    /// The auditor a fund named asks the enclave to open that fund's submission to
    /// a round and seal it to `auditor_pubkey`. Only once the round stops taking
    /// marks, so the copy is the one that counts. Attach the 0.02 NEAR storage
    /// deposit and at least 0.01 NEAR for the enclave call.
    #[payable]
    pub fn request_audit(
        &mut self,
        round_id: u64,
        fund: AccountId,
        auditor_pubkey: String,
    ) -> Promise {
        let auditor = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= STORAGE_DEPOSIT + MIN_OUTLAYER_DEPOSIT,
            "attach the 0.02 NEAR storage deposit and at least 0.01 NEAR for the enclave call"
        );
        require!(
            self.auditors.get(&fund).map(|ap| &ap.auditor) == Some(&auditor),
            "only the auditor this fund named can audit it"
        );
        require!(
            is_compressed_pubkey(&auditor_pubkey),
            "auditor_pubkey must be a compressed secp256k1 key in hex"
        );
        let round = self
            .rounds
            .get(&round_id)
            .unwrap_or_else(|| env::panic_str("no such round"));
        require!(
            !matches!(round.status, RoundStatus::AwaitingKey | RoundStatus::Open),
            "the round is still taking marks"
        );
        let sub = round
            .submissions
            .iter()
            .find(|s| s.account == fund)
            .unwrap_or_else(|| env::panic_str("this fund made no submission to the round"));
        let input = json!({
            "action": "audit",
            "contract": env::current_account_id(),
            "round_id": round_id,
            "account": fund,
            "ciphertext_hex": sub.ciphertext_hex,
            "auditor_pubkey": auditor_pubkey,
        });
        let submitted_at = sub.submitted_at;
        let id = self.next_audit_id;
        self.next_audit_id += 1;
        self.audits.insert(
            id,
            AuditCopy {
                id: U64(id),
                round_id: U64(round_id),
                fund,
                auditor: auditor.clone(),
                auditor_pubkey,
                submitted_at,
                status: AuditStatus::Pending,
                sealed: None,
                error: None,
            },
        );
        self.audits_by_auditor
            .entry(auditor.clone())
            .or_default()
            .push(id);
        self.pending_since
            .insert(format!("a{id}"), env::block_timestamp());
        emit(
            "audit_requested",
            json!({"audit_id": id, "round_id": round_id, "auditor": auditor}),
        );
        let (call, fee) = self.request_enclave(input, attached - STORAGE_DEPOSIT, &auditor);
        call.then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_audit(id, auditor, U128(fee)),
        )
    }

    /// Pay out the caller's share of read fees. If the transfer fails, the
    /// earnings are put back.
    pub fn withdraw(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let amount = self.earnings.remove(&who).unwrap_or(0);
        require!(amount > 0, "nothing to withdraw");
        Self::pay(who, amount)
    }

    /// After any payment: if it bounced (say the account was deleted), the amount
    /// is credited to the account's earnings instead of being lost.
    #[private]
    pub fn on_withdrawn(
        &mut self,
        account: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if result.is_err() {
            *self.earnings.entry(account.clone()).or_insert(0) += amount.0;
            emit(
                "payment_failed",
                json!({"account": account, "amount": amount}),
            );
        }
    }

    // ---- settling calls the enclave never answered ----

    /// A round stuck in Closing for over 30 minutes (its tally never applied) goes
    /// back to CloseFailed, so anyone can close it again. Anyone may call this.
    pub fn reconcile_round(&mut self, round_id: u64) {
        let key = format!("r{round_id}");
        let waiting = self
            .rounds
            .get(&round_id)
            .is_some_and(|r| r.status == RoundStatus::Closing);
        let since = self.stale_since(&key, waiting);
        let round = self.rounds.get_mut(&round_id).expect("checked above");
        round.status = RoundStatus::CloseFailed;
        round.last_error = Some("the enclave never answered; close the round again".into());
        self.pending_since.remove(&key);
        emit(
            "round_reconciled",
            json!({"round_id": round_id, "pending_since": U64(since)}),
        );
    }

    /// A read stuck in Pending for over 30 minutes is refunded to its buyer. A
    /// delivery that turns up later is ignored. Anyone may call this.
    pub fn reconcile_read(&mut self, purchase_id: u64) -> PromiseOrValue<()> {
        let key = format!("p{purchase_id}");
        let waiting = self
            .purchases
            .get(&purchase_id)
            .is_some_and(|p| p.status == PurchaseStatus::Pending);
        let since = self.stale_since(&key, waiting);
        let p = self.purchases.get_mut(&purchase_id).expect("checked above");
        p.status = PurchaseStatus::Refunded;
        p.error = Some("the enclave never answered; the read price was refunded".into());
        let (buyer, price) = (p.buyer.clone(), p.price.0);
        self.pending_since.remove(&key);
        emit(
            "read_reconciled",
            json!({"purchase_id": purchase_id, "pending_since": U64(since), "refund": U128(price)}),
        );
        if price > 0 {
            PromiseOrValue::Promise(Self::pay(buyer, price))
        } else {
            PromiseOrValue::Value(())
        }
    }

    /// An audit stuck in Pending for over 30 minutes is marked failed, so the
    /// auditor can ask again. Anyone may call this.
    pub fn reconcile_audit(&mut self, audit_id: u64) {
        let key = format!("a{audit_id}");
        let waiting = self
            .audits
            .get(&audit_id)
            .is_some_and(|a| a.status == AuditStatus::Pending);
        let since = self.stale_since(&key, waiting);
        let audit = self.audits.get_mut(&audit_id).expect("checked above");
        audit.status = AuditStatus::Failed;
        audit.error = Some("the enclave never answered; ask again".into());
        self.pending_since.remove(&key);
        emit(
            "audit_reconciled",
            json!({"audit_id": audit_id, "pending_since": U64(since)}),
        );
    }

    // ---- enclave callbacks (never panic: a panic would revert the state change and
    // leave the round or purchase stuck). They read the result themselves, so even
    // bytes that are not JSON become a recorded failure. ----

    #[private]
    pub fn on_round_key(&mut self, round_id: u64, payer: AccountId, fee: U128) {
        self.apply_round_key(round_id, enclave_answer(payer, fee));
    }

    #[private]
    /// `requested_at` names the close this answers. A round can be closed again
    /// after a failed or settled close, so an answer to an earlier one is ignored
    /// rather than taken as the answer to the retry.
    pub fn on_tally(&mut self, round_id: u64, payer: AccountId, fee: U128, requested_at: U64) {
        let answer = enclave_answer(payer, fee);
        if self.pending_since.get(&format!("r{round_id}")) != Some(&requested_at.0) {
            emit(
                "callback_ignored",
                json!({"kind": "tally", "id": round_id, "reason": "answers an earlier close"}),
            );
            return;
        }
        self.apply_tally(round_id, answer);
    }

    #[private]
    pub fn on_deliver(&mut self, purchase_id: u64, payer: AccountId, fee: U128) {
        self.apply_delivery(purchase_id, enclave_answer(payer, fee));
    }

    #[private]
    pub fn on_audit(&mut self, audit_id: u64, payer: AccountId, fee: U128) {
        self.apply_audit(audit_id, enclave_answer(payer, fee));
    }

    // ---- views ----

    /// When the enclave call behind a Closing round, a Pending read or a Pending
    /// audit went out (`kind` is "round", "read" or "audit"); null once it settled.
    /// Anyone can settle it with `reconcile_*` 30 minutes after this.
    pub fn get_pending_since(&self, kind: String, id: U64) -> Option<U64> {
        let prefix = match kind.as_str() {
            "round" => "r",
            "read" => "p",
            "audit" => "a",
            _ => env::panic_str("kind must be round, read or audit"),
        };
        self.pending_since
            .get(&format!("{prefix}{}", id.0))
            .map(|t| U64(*t))
    }

    pub fn get_round(&self, round_id: U64) -> Option<RoundView> {
        self.rounds.get(&round_id.0).map(view_of)
    }

    pub fn get_rounds(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<RoundView> {
        self.rounds
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(20).min(50) as usize)
            .map(|(_, r)| view_of(r))
            .collect()
    }

    /// The submissions exactly as stored (ciphertexts), for recomputing the set hash.
    pub fn get_submissions(&self, round_id: U64) -> Vec<Submission> {
        self.rounds
            .get(&round_id.0)
            .map(|r| r.submissions.clone())
            .unwrap_or_default()
    }

    pub fn get_purchase(&self, purchase_id: U64) -> Option<Purchase> {
        self.purchases.get(&purchase_id.0).cloned()
    }

    pub fn get_purchases_of(&self, buyer: AccountId) -> Vec<Purchase> {
        self.purchase_ids_of(&buyer)
            .iter()
            .filter_map(|id| self.purchases.get(id))
            .cloned()
            .collect()
    }

    pub fn get_earnings(&self, account: AccountId) -> U128 {
        U128(self.earnings.get(&account).copied().unwrap_or(0))
    }

    pub fn get_members(&self) -> Vec<AccountId> {
        self.members.iter().cloned().collect()
    }

    pub fn get_applications(&self) -> Vec<Application> {
        self.applications.values().cloned().collect()
    }

    pub fn get_council(&self) -> Vec<AccountId> {
        self.council.clone()
    }

    /// The running vote to replace the council, if there is one.
    pub fn get_takeover(&self) -> Option<Takeover> {
        if self.takeover_is_live(env::block_timestamp()) {
            self.takeover.clone()
        } else {
            None
        }
    }

    /// Proposals still open for votes. Lapsed ones are left out, and cleared from
    /// storage when the next proposal is made.
    pub fn get_proposals(&self) -> Vec<Proposal> {
        let now = env::block_timestamp();
        self.proposals
            .values()
            .filter(|p| !proposal_lapsed(p, now))
            .cloned()
            .collect()
    }

    pub fn get_loans(&self) -> Vec<LoanView> {
        self.loans
            .iter()
            .map(|(id, label)| LoanView {
                id: U64(*id),
                label: label.clone(),
            })
            .collect()
    }

    pub fn get_auditor(&self, fund: AccountId) -> Option<AccountId> {
        self.auditors.get(&fund).map(|ap| ap.auditor.clone())
    }

    pub fn get_appointment(&self, fund: AccountId) -> Option<Appointment> {
        self.auditors.get(&fund).cloned()
    }

    /// The panel funds that named `auditor`.
    pub fn get_clients_of(&self, auditor: AccountId) -> Vec<AccountId> {
        self.members
            .iter()
            .filter(|m| self.auditors.get(*m).map(|ap| &ap.auditor) == Some(&auditor))
            .cloned()
            .collect()
    }

    pub fn get_audit(&self, audit_id: U64) -> Option<AuditCopy> {
        self.audits.get(&audit_id.0).cloned()
    }

    pub fn get_audits_of(&self, auditor: AccountId) -> Vec<AuditCopy> {
        let ids = self
            .audits_by_auditor
            .get(&auditor)
            .cloned()
            .unwrap_or_default();
        ids.iter()
            .filter_map(|id| self.audits.get(id))
            .cloned()
            .collect()
    }

    /// Why `account` may read a published round for free, if it may.
    pub fn get_free_basis(&self, round_id: U64, account: AccountId) -> Option<Basis> {
        let round = self.rounds.get(&round_id.0)?;
        if round.status != RoundStatus::Published {
            return None;
        }
        self.free_basis(round, &account)
    }

    pub fn get_config(&self) -> Value {
        json!({
            "council": self.council,
            "threshold": self.threshold,
            "admit_delay_secs": self.admit_delay_ns / 1_000_000_000,
            "council_share_bps": self.council_share_bps,
            "council_dormant_after_secs": self.council_dormant_ns / 1_000_000_000,
            "last_council_action": U64(self.last_council_action),
            "outlayer": self.outlayer_id,
            "project_id": self.project_id,
            "min_contributors": self.min_contributors,
            "read_price": U128(self.read_price),
            "readers_only": readers_only(),
            "readers": readers(),
            "application_bond": U128(APPLICATION_BOND),
            "storage_deposit": U128(STORAGE_DEPOSIT),
            "enclave_fee": U128(MIN_OUTLAYER_DEPOSIT),
        })
    }
}

impl Nema {
    /// The shape every council has, at creation and when the panel replaces it.
    fn assert_valid_council(council: &[AccountId], threshold: u32) {
        if let Some(reason) = council_shape_problem(council, threshold) {
            env::panic_str(reason);
        }
    }

    fn mark_council_active(&mut self) {
        self.last_council_action = env::block_timestamp();
    }

    /// A takeover is live while it is younger than its time limit and the council
    /// has not decided anything since it was made.
    fn takeover_is_live(&self, now: u64) -> bool {
        self.takeover.as_ref().is_some_and(|t| {
            t.created_at.0 > self.last_council_action
                && now <= t.created_at.0.saturating_add(TAKEOVER_TTL_NS)
        })
    }

    fn run_takeover_if_passed(&mut self) {
        let Some(t) = &self.takeover else {
            return;
        };
        // A panel this small can't speak for itself (funds may have been removed).
        if self.members.len() < self.min_contributors {
            return;
        }
        // Votes from accounts since removed from the panel do not count.
        let votes = t.votes.iter().filter(|v| self.members.contains(*v)).count() as u64;
        if votes * 3 < self.members.len() as u64 * 2 {
            return;
        }
        let Some(t) = self.takeover.take() else {
            return;
        };
        emit(
            "council_replaced",
            json!({"council": t.council, "threshold": t.threshold}),
        );
        self.council = t.council;
        self.threshold = t.threshold;
        self.mark_council_active();
        // The new council starts clean: the old council's open proposals and its
        // approvals of applicants don't carry over.
        let ids: Vec<u64> = self.proposals.keys().copied().collect();
        for id in ids {
            self.proposals.remove(&id);
        }
        let applicants: Vec<AccountId> = self.applications.keys().cloned().collect();
        for a in applicants {
            if let Some(app) = self.applications.get_mut(&a) {
                app.approvals.clear();
                app.ready_at = None;
            }
        }
    }

    /// A seat that leaves the council takes its votes and approvals with it, so they
    /// can't count again if it is seated later.
    fn forget_seat(&mut self, seat: &AccountId) {
        let ids: Vec<u64> = self.proposals.keys().copied().collect();
        for id in ids {
            if let Some(p) = self.proposals.get_mut(&id) {
                p.votes.retain(|v| v != seat);
            }
        }
        let applicants: Vec<AccountId> = self.applications.keys().cloned().collect();
        for a in applicants {
            if let Some(app) = self.applications.get_mut(&a) {
                app.approvals.retain(|v| v != seat);
            }
        }
    }

    fn assert_council(&self) {
        require!(
            self.council.contains(&env::predecessor_account_id()),
            "only a council member can do this"
        );
    }

    fn add_loan(&mut self, label: String) {
        require!(
            !label.is_empty() && label.len() <= 120,
            "loan label must be 1 to 120 characters"
        );
        require!(self.loans.len() < MAX_LOANS, "the loan registry is full");
        require!(
            !self.loans.values().any(|l| l == &label),
            "this loan is already registered"
        );
        self.loans.insert(self.next_loan_id, label);
        self.next_loan_id += 1;
    }

    /// Clears proposals that can no longer pass, so storage holds only live ones.
    fn prune_lapsed_proposals(&mut self) {
        let now = env::block_timestamp();
        let lapsed: Vec<u64> = self
            .proposals
            .iter()
            .filter(|(_, p)| proposal_lapsed(p, now))
            .map(|(id, _)| *id)
            .collect();
        for id in lapsed {
            self.proposals.remove(&id);
            emit("proposal_lapsed", json!({"id": id}));
        }
    }

    /// Whether a round on this loan is still going (waiting for its key, open,
    /// closing, or awaiting a retried close). Only the loan's latest round can be.
    fn has_active_round(&self, loan_id: u64) -> bool {
        self.latest_round
            .get(&loan_id)
            .and_then(|id| self.rounds.get(id))
            .is_some_and(|r| {
                matches!(
                    r.status,
                    RoundStatus::AwaitingKey
                        | RoundStatus::Open
                        | RoundStatus::Closing
                        | RoundStatus::CloseFailed
                )
            })
    }

    /// Reject a proposal that could never run, so it fails when made, not when
    /// the last vote comes in.
    fn check_proposal(&self, kind: &ProposalKind) {
        if let Some(reason) = self.proposal_problem(kind) {
            env::panic_str(reason);
        }
    }

    /// Why a proposal can't run now, if it can't.
    fn proposal_problem(&self, kind: &ProposalKind) -> Option<&'static str> {
        let fail = |bad: bool, reason: &'static str| bad.then_some(reason);
        match kind {
            ProposalKind::SetReadPrice(_) | ProposalKind::Heartbeat => None,
            ProposalKind::RemoveMember(a) => fail(!self.members.contains(a), "not a panel member"),
            ProposalKind::AddCouncil(a) => fail(self.council.contains(a), "already on the council")
                .or(fail(
                    self.council.len() >= MAX_COUNCIL,
                    "the council is full",
                )),
            // The threshold was a majority of the larger council, so it stays one.
            ProposalKind::RemoveCouncil(a) => fail(!self.council.contains(a), "not on the council")
                .or(fail(
                    self.council.len() <= self.threshold as usize || self.council.len() <= 3,
                    "the council would fall below its threshold or 3 members",
                )),
            ProposalKind::SetThreshold(t) => council_shape_problem(&self.council, *t),
            ProposalKind::RegisterLoan(label) => fail(
                label.is_empty() || label.len() > 120,
                "loan label must be 1 to 120 characters",
            )
            .or(fail(
                self.loans.len() >= MAX_LOANS,
                "the loan registry is full",
            ))
            .or(fail(
                self.loans.values().any(|l| l == label),
                "this loan is already registered",
            )),
            ProposalKind::RemoveLoan(id) => fail(self.loans.get(&id.0).is_none(), "no such loan")
                .or(fail(
                    self.has_active_round(id.0),
                    "a round on this loan is still running",
                )),
            ProposalKind::AddReader(a) => {
                let r = readers();
                fail(r.contains(a), "already a reader")
                    .or(fail(r.len() >= MAX_READERS, "the reader list is full"))
            }
            ProposalKind::RemoveReader(a) => fail(!readers().contains(a), "not a reader"),
            ProposalKind::SetReadersOnly(on) => fail(
                *on == readers_only(),
                if *on {
                    "reads are already limited to readers"
                } else {
                    "reads are already open to anyone"
                },
            ),
        }
    }

    fn run_if_passed(&mut self, id: u64) {
        let Some(p) = self.proposals.get(&id) else {
            return;
        };
        // Votes from accounts since removed from the council do not count.
        let votes = p.votes.iter().filter(|v| self.council.contains(v)).count();
        if (votes as u32) < self.threshold {
            return;
        }
        let kind = p.kind.clone();
        self.proposals.remove(&id);
        // Something changed since it was made (another proposal ran first): it fails
        // cleanly, and the vote that reached the threshold still lands.
        if let Some(reason) = self.proposal_problem(&kind) {
            emit("proposal_failed", json!({"id": id, "reason": reason}));
            return;
        }
        self.mark_council_active();
        match kind.clone() {
            ProposalKind::SetReadPrice(price) => self.read_price = price.0,
            ProposalKind::RemoveMember(a) => {
                self.members.remove(&a);
            }
            ProposalKind::AddCouncil(a) => {
                self.council.push(a);
                // A bigger council needs more votes, or a minority could decide.
                let majority = self.council.len() as u32 / 2 + 1;
                self.threshold = self.threshold.max(majority);
            }
            ProposalKind::RemoveCouncil(a) => {
                self.council.retain(|c| c != &a);
                self.forget_seat(&a);
            }
            ProposalKind::SetThreshold(t) => self.threshold = t,
            ProposalKind::RegisterLoan(label) => self.add_loan(label),
            ProposalKind::RemoveLoan(id) => {
                self.loans.remove(&id.0);
            }
            ProposalKind::Heartbeat => {}
            ProposalKind::AddReader(a) => {
                let mut r = readers();
                r.push(a);
                set_readers(&r);
            }
            ProposalKind::RemoveReader(a) => {
                let mut r = readers();
                r.retain(|x| x != &a);
                set_readers(&r);
            }
            ProposalKind::SetReadersOnly(on) => {
                let key = StorageKey::ReadersOnly.into_storage_key();
                if on {
                    env::storage_write(&key, &[1]);
                } else {
                    env::storage_remove(&key);
                }
            }
        }
        emit("proposal_passed", json!({"id": id, "kind": kind}));
    }

    fn purchase_ids_of(&self, buyer: &AccountId) -> Vec<u64> {
        self.purchases_by_buyer
            .get(buyer)
            .cloned()
            .unwrap_or_default()
    }

    /// A fund whose mark counted reads free; so does an auditor a counted fund
    /// named no later than the round's deadline.
    fn free_basis(&self, round: &Round, who: &AccountId) -> Option<Basis> {
        let contributors = round
            .listing
            .as_ref()
            .map(|l| l.contributors.as_slice())
            .unwrap_or_default();
        if contributors.contains(who) {
            return Some(Basis::Contributed);
        }
        let audits = contributors.iter().any(|c| {
            self.auditors
                .get(c)
                .is_some_and(|ap| &ap.auditor == who && ap.since.0 <= round.closes_at)
        });
        audits.then_some(Basis::Audit)
    }

    /// When the call behind `key` went out, if it is old enough to settle. Fails
    /// closed: nothing waiting, or too recent, means it can't be settled. A call made
    /// before this record existed (an earlier build) has none and counts as old.
    fn stale_since(&self, key: &str, waiting: bool) -> u64 {
        require!(waiting, "nothing is waiting on the enclave here");
        let since = self.pending_since.get(key).copied().unwrap_or(0);
        require!(
            env::block_timestamp() >= since.saturating_add(STALE_AFTER_NS),
            "the enclave may still answer; try again 30 minutes after the request"
        );
        since
    }

    /// Sends `input` to the enclave with at most MAX_OUTLAYER_DEPOSIT of `deposit`
    /// (the rest goes back to `payer`), and returns the call and the fee it carries.
    fn request_enclave(&self, input: Value, deposit: u128, payer: &AccountId) -> (Promise, u128) {
        let fee = deposit.min(MAX_OUTLAYER_DEPOSIT);
        if deposit > fee {
            Self::pay(payer.clone(), deposit - fee).detach();
        }
        let source = json!({"Project": {"project_id": self.project_id, "version_key": null}});
        let limits = json!({
            "max_instructions": 10_000_000_000u64,
            "max_memory_mb": 128u32,
            "max_execution_seconds": 60u64,
        });
        let secrets_ref = json!({
            "profile": self.secrets_profile,
            "account_id": self.secrets_account,
        });
        let call = ext_outlayer::ext(self.outlayer_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(fee))
            .with_unused_gas_weight(1)
            .request_execution(
                source,
                Some(limits),
                Some(input.to_string()),
                Some(secrets_ref),
                Some("Json".to_string()),
                Some(payer.clone()),
            );
        (call, fee)
    }

    /// Pays `amount` to `to`; if the transfer fails, `on_withdrawn` credits it to
    /// their earnings, so a refund or bond is never lost.
    fn pay(to: AccountId, amount: u128) -> Promise {
        Promise::new(to.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(PAY_GAS)
                    .on_withdrawn(to, U128(amount)),
            )
    }

    fn start_read(
        &mut self,
        round_id: u64,
        buyer: AccountId,
        buyer_pubkey: String,
        price: u128,
        basis: Basis,
        enclave_deposit: u128,
    ) -> Promise {
        require!(
            is_compressed_pubkey(&buyer_pubkey),
            "buyer_pubkey must be a compressed secp256k1 key in hex"
        );
        let min = self.min_contributors as usize;
        let round = self
            .rounds
            .get(&round_id)
            .unwrap_or_else(|| env::panic_str("no such round"));
        require!(
            round.status == RoundStatus::Published,
            "the round has no published result"
        );
        let listing = round
            .listing
            .as_ref()
            .expect("a published round has a listing");
        // The reading key is made and saved in the browser before the wallet signs, so
        // it doubles as the idempotency key: a retry after a wallet timeout finds the
        // first read instead of paying twice.
        let duplicate = self
            .purchase_ids_of(&buyer)
            .iter()
            .filter_map(|id| self.purchases.get(id))
            .any(|p| {
                p.round_id.0 == round_id
                    && p.buyer_pubkey == buyer_pubkey
                    && p.status != PurchaseStatus::Refunded
            });
        require!(
            !duplicate,
            "this key already has a copy of this round, delivered or on its way"
        );

        let mut input = enclave_input("deliver", round_id, min, round);
        input["commitment"] = json!(listing.commitment);
        input["buyer_pubkey"] = json!(buyer_pubkey);

        let id = self.next_purchase_id;
        self.next_purchase_id += 1;
        self.purchases.insert(
            id,
            Purchase {
                id: U64(id),
                round_id: U64(round_id),
                buyer: buyer.clone(),
                buyer_pubkey,
                price: U128(price),
                basis,
                status: PurchaseStatus::Pending,
                sealed: None,
                error: None,
            },
        );
        self.purchases_by_buyer
            .entry(buyer.clone())
            .or_default()
            .push(id);
        self.pending_since
            .insert(format!("p{id}"), env::block_timestamp());
        emit(
            "read_requested",
            json!({"purchase_id": id, "round_id": round_id, "buyer": buyer, "basis": basis}),
        );

        let (call, fee) = self.request_enclave(input, enclave_deposit, &buyer);
        call.then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_deliver(id, buyer, U128(fee)),
        )
    }

    fn apply_audit(&mut self, audit_id: u64, result: Result<Value, String>) {
        let Some(current) = self.audits.get(&audit_id) else {
            return;
        };
        if current.status != AuditStatus::Pending {
            emit(
                "callback_ignored",
                json!({"kind": "audit", "id": audit_id, "status": current.status}),
            );
            return;
        }
        // The fund may have cleared or changed its auditor while the enclave ran; the
        // copy goes only to the auditor the fund names when it lands.
        let still_named = self
            .auditors
            .get(&current.fund)
            .is_some_and(|ap| ap.auditor == current.auditor);
        self.pending_since.remove(&format!("a{audit_id}"));
        let audit = self.audits.get_mut(&audit_id).expect("checked above");
        let result = if still_named {
            result
        } else {
            Err("the fund changed its auditor while the audit ran".into())
        };
        let checked = result
            .and_then(|v| {
                serde_json::from_value::<AuditOut>(v)
                    .map_err(|e| format!("bad audit response: {e}"))
            })
            .and_then(|out| {
                if !out.ok {
                    return Err(out
                        .error
                        .unwrap_or_else(|| "the enclave declined to open the submission".into()));
                }
                let sealed = out.sealed.ok_or("missing sealed submission")?;
                if is_sealed_hex(&sealed) {
                    Ok(sealed)
                } else {
                    Err("malformed sealed submission".into())
                }
            });
        match checked {
            Ok(sealed) => {
                audit.sealed = Some(sealed);
                audit.status = AuditStatus::Delivered;
                emit("audit_delivered", json!({"audit_id": audit_id}));
            }
            Err(reason) => {
                audit.status = AuditStatus::Failed;
                audit.error = Some(clip(reason));
                emit(
                    "audit_failed",
                    json!({"audit_id": audit_id, "error": audit.error}),
                );
            }
        }
    }

    fn apply_round_key(&mut self, round_id: u64, result: Result<Value, String>) {
        let Some(round) = self.rounds.get_mut(&round_id) else {
            return;
        };
        if round.status != RoundStatus::AwaitingKey {
            emit(
                "callback_ignored",
                json!({"kind": "round_key", "id": round_id, "status": round.status}),
            );
            return;
        }
        let parsed = result.and_then(|v| {
            serde_json::from_value::<KeyOut>(v).map_err(|e| format!("bad key response: {e}"))
        });
        match parsed {
            Ok(KeyOut {
                ok: Some(false),
                error,
                ..
            }) => {
                round.status = RoundStatus::Failed;
                round.last_error =
                    Some(clip(error.unwrap_or_else(|| {
                        "the enclave declined to derive a key".into()
                    })));
            }
            Ok(KeyOut {
                pubkey: Some(pk), ..
            }) if is_compressed_pubkey(&pk) => {
                round.pubkey = Some(pk);
                round.status = RoundStatus::Open;
                emit("round_opened", json!({"round_id": round_id}));
            }
            Ok(_) => {
                round.status = RoundStatus::Failed;
                round.last_error = Some("the enclave returned a malformed public key".into());
            }
            Err(e) => {
                round.status = RoundStatus::Failed;
                round.last_error = Some(clip(e));
            }
        }
        if round.status == RoundStatus::Failed {
            emit(
                "round_key_failed",
                json!({"round_id": round_id, "error": round.last_error}),
            );
        }
    }

    fn apply_tally(&mut self, round_id: u64, result: Result<Value, String>) {
        let min = self.min_contributors;
        let Some(round) = self.rounds.get_mut(&round_id) else {
            return;
        };
        if round.status != RoundStatus::Closing {
            emit(
                "callback_ignored",
                json!({"kind": "tally", "id": round_id, "status": round.status}),
            );
            return;
        }
        self.pending_since.remove(&format!("r{round_id}"));
        match validate_tally(round, min, result) {
            Ok(listing) => {
                round.listing = Some(listing);
                round.status = RoundStatus::Published;
                round.last_error = None;
                emit(
                    "round_published",
                    json!({"round_id": round_id, "count": round.listing.as_ref().map(|l| l.count)}),
                );
            }
            Err(reason) => {
                round.status = RoundStatus::CloseFailed;
                round.last_error = Some(clip(reason));
                emit(
                    "close_failed",
                    json!({"round_id": round_id, "error": round.last_error}),
                );
            }
        }
    }

    fn apply_delivery(&mut self, purchase_id: u64, result: Result<Value, String>) {
        let Some(purchase) = self.purchases.get(&purchase_id).cloned() else {
            return;
        };
        if purchase.status != PurchaseStatus::Pending {
            emit(
                "callback_ignored",
                json!({"kind": "read", "id": purchase_id, "status": purchase.status}),
            );
            return;
        }
        self.pending_since.remove(&format!("p{purchase_id}"));
        let listing = self
            .rounds
            .get(&purchase.round_id.0)
            .and_then(|r| r.listing.clone());
        let checked = match listing {
            Some(l) => validate_delivery(&l, result).map(|sealed| (sealed, l.contributors)),
            None => Err("the round has no listing".into()),
        };
        let p = self.purchases.get_mut(&purchase_id).expect("checked above");
        match checked {
            Ok((sealed, contributors)) => {
                p.sealed = Some(sealed);
                p.status = PurchaseStatus::Delivered;
                self.credit_contributors(&contributors, purchase.price.0);
                emit(
                    "read_delivered",
                    json!({"purchase_id": purchase_id, "price": U128(purchase.price.0)}),
                );
            }
            Err(reason) => {
                p.status = PurchaseStatus::Refunded;
                p.error = Some(clip(reason));
                if purchase.price.0 > 0 {
                    Self::pay(purchase.buyer.clone(), purchase.price.0).detach();
                }
                emit(
                    "read_refunded",
                    json!({"purchase_id": purchase_id, "error": p.error}),
                );
            }
        }
    }

    /// A read fee is paid out in full: the council's share first (equal among its
    /// seats), then equal shares to each contributor; whatever does not divide goes
    /// to the first council seat.
    fn credit_contributors(&mut self, contributors: &[AccountId], amount: u128) {
        if contributors.is_empty() || amount == 0 {
            return;
        }
        let bps = self.council_share_bps as u128;
        // amount * bps / 10_000 without overflowing for any amount that exists.
        let cut = amount / 10_000 * bps + (amount % 10_000) * bps / 10_000;
        let seats = self.council.len() as u128;
        let per_seat = cut / seats;
        if per_seat > 0 {
            for seat in &self.council {
                *self.earnings.entry(seat.clone()).or_insert(0) += per_seat;
            }
        }
        let pool = amount - per_seat * seats;
        let share = pool / contributors.len() as u128;
        let remainder = pool - share * contributors.len() as u128;
        for c in contributors {
            *self.earnings.entry(c.clone()).or_insert(0) += share;
        }
        if remainder > 0 {
            *self.earnings.entry(self.council[0].clone()).or_insert(0) += remainder;
        }
    }
}

/// What is wrong with a council and threshold, if anything: 3 to 7 different
/// accounts, and a threshold that is a majority and at least 2.
fn council_shape_problem(council: &[AccountId], threshold: u32) -> Option<&'static str> {
    let unique: HashSet<&AccountId> = council.iter().collect();
    if unique.len() != council.len() || !(3..=MAX_COUNCIL).contains(&council.len()) {
        return Some("the council needs 3 to 7 different accounts");
    }
    let t = threshold as usize;
    if threshold < 2 || t > council.len() || t * 2 <= council.len() {
        return Some("the threshold must be a majority of the council, and at least 2");
    }
    None
}

/// A proposal that did not reach the threshold within a week can no longer pass.
fn proposal_lapsed(p: &Proposal, now: u64) -> bool {
    now > p.created_at.0.saturating_add(PROPOSAL_TTL_NS)
}

/// A NEP-297 event, so indexers and the site can follow every state change.
fn emit(event: &str, data: Value) {
    log!(
        "EVENT_JSON:{}",
        json!({"standard": "nema", "version": "1.0.0", "event": event, "data": [data]})
    );
}

/// The input shared by `tally` and `deliver`: the committed set, sorted by account.
fn enclave_input(action: &str, round_id: u64, min: usize, round: &Round) -> Value {
    let mut sorted = round.submissions.clone();
    sorted.sort_by(|a, b| a.account.as_str().cmp(b.account.as_str()));
    json!({
        "action": action,
        "contract": env::current_account_id(),
        "round_id": round_id,
        "min_contributors": min,
        "set_hash": round.set_hash,
        "submissions": sorted
            .iter()
            .map(|s| json!({"account": s.account, "ciphertext_hex": s.ciphertext_hex}))
            .collect::<Vec<_>>(),
    })
}

/// Check the enclave's tally against what this contract knows before trusting it.
fn validate_tally(
    round: &Round,
    min: u32,
    result: Result<Value, String>,
) -> Result<Listing, String> {
    let out: TallyOut =
        serde_json::from_value(result?).map_err(|e| format!("bad tally response: {e}"))?;
    if !out.ok {
        return Err(out
            .error
            .unwrap_or_else(|| "the enclave declined to publish".into()));
    }
    let count = out.count.ok_or("missing count")?;
    let echoed = out.set_hash.ok_or("missing set_hash")?;
    let commitment = out.commitment.ok_or("missing commitment")?;
    let rejected = out.rejected.unwrap_or_default();
    let expected = round.set_hash.clone().ok_or("round has no committed set")?;
    if echoed != expected {
        return Err("the enclave tallied a different submission set than the one committed".into());
    }
    if !is_hex_of_len(&commitment, 64) {
        return Err("malformed commitment".into());
    }
    // Every submission is either counted or rejected, exactly once.
    let submitters: HashSet<&str> = round
        .submissions
        .iter()
        .map(|s| s.account.as_str())
        .collect();
    let mut dropped = HashSet::new();
    for r in &rejected {
        if !submitters.contains(r.account.as_str()) || !dropped.insert(r.account.as_str()) {
            return Err(format!(
                "the enclave rejected an unknown or repeated account {}",
                r.account
            ));
        }
    }
    if count < min || count as usize + rejected.len() != round.submissions.len() {
        return Err(format!("implausible contributor count {count}"));
    }
    let contributors = round
        .submissions
        .iter()
        .filter(|s| !dropped.contains(s.account.as_str()))
        .map(|s| s.account.clone())
        .collect();
    Ok(Listing {
        count,
        rejected,
        set_hash: echoed,
        commitment,
        contributors,
    })
}

/// Check a delivery is for this round's committed set and result.
fn validate_delivery(listing: &Listing, result: Result<Value, String>) -> Result<String, String> {
    let out: DeliverOut =
        serde_json::from_value(result?).map_err(|e| format!("bad delivery response: {e}"))?;
    if !out.ok {
        return Err(out
            .error
            .unwrap_or_else(|| "the enclave declined to deliver".into()));
    }
    if out.set_hash.as_deref() != Some(listing.set_hash.as_str()) {
        return Err("the enclave delivered for a different submission set".into());
    }
    if out.commitment.as_deref() != Some(listing.commitment.as_str()) {
        return Err("the enclave delivered a result that does not match the commitment".into());
    }
    let sealed = out.sealed.ok_or("missing sealed result")?;
    if !is_sealed_hex(&sealed) {
        return Err("malformed sealed result".into());
    }
    Ok(sealed)
}

/// ECIES overhead is 97 bytes, so anything shorter cannot hold a payload.
fn is_sealed_hex(s: &str) -> bool {
    s.len() <= MAX_SEALED_HEX && s.len() >= 2 * 98 && is_hex_of_len(s, s.len())
}

fn clip(mut s: String) -> String {
    if s.len() > MAX_ERROR {
        let mut end = MAX_ERROR;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
        s.push('…');
    }
    s
}

/// The longest enclave answer the callback reads. A tally, a sealed read or an
/// audit is a few kilobytes; reading more would only spend the callback's gas.
pub const MAX_ENCLAVE_ANSWER: usize = 64 * 1024;

/// The enclave's answer to the call this callback follows. If OutLayer refused the
/// call itself, NEAR returned its fee here, so it goes back to the payer. Bytes that
/// are not JSON, or more of them than the callback reads, are a failure, not a panic.
fn enclave_answer(payer: AccountId, fee: U128) -> Result<Value, String> {
    match env::promise_result_checked(0, MAX_ENCLAVE_ANSWER) {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) => outcome(Ok(v)),
            Err(_) => Err("the enclave returned something that is not JSON".into()),
        },
        Err(PromiseError::TooLong(n)) => Err(format!(
            "the enclave returned {n} bytes, more than the {MAX_ENCLAVE_ANSWER} the contract reads"
        )),
        Err(e) => {
            if fee.0 > 0 {
                Nema::pay(payer.clone(), fee.0).detach();
                emit(
                    "enclave_fee_refunded",
                    json!({"account": payer, "amount": fee}),
                );
            }
            outcome(Err(e))
        }
    }
}

/// OutLayer hands back the enclave's own JSON output, or `null` when the run
/// failed or produced nothing.
fn outcome(r: Result<Value, PromiseError>) -> Result<Value, String> {
    match r {
        Ok(Value::Null) => Err("the enclave run failed or returned nothing".into()),
        Ok(v) => Ok(v),
        Err(e) => Err(format!("the enclave call failed: {e:?}")),
    }
}

fn view_of(r: &Round) -> RoundView {
    RoundView {
        id: U64(r.id),
        loan_id: U64(r.loan_id),
        loan: r.loan.clone(),
        opened_by: r.opened_by.clone(),
        status: r.status,
        opened_at: U64(r.opened_at),
        closes_at: U64(r.closes_at),
        pubkey: r.pubkey.clone(),
        submitted: r.submissions.iter().map(|s| s.account.clone()).collect(),
        set_hash: r.set_hash.clone(),
        listing: r.listing.clone(),
        last_error: r.last_error.clone(),
        closed_by: r.closed_by.clone(),
    }
}

/// See the module docs for the exact byte layout; the enclave recomputes this.
pub fn compute_set_hash(subs: &[Submission]) -> String {
    let mut sorted: Vec<&Submission> = subs.iter().collect();
    sorted.sort_by(|a, b| a.account.as_str().cmp(b.account.as_str()));
    let mut buf: Vec<u8> = Vec::new();
    for s in sorted {
        let a = s.account.as_str().as_bytes();
        buf.extend_from_slice(&(a.len() as u32).to_le_bytes());
        buf.extend_from_slice(a);
        buf.extend_from_slice(&env::sha256(s.ciphertext_hex.as_bytes()));
    }
    hex::encode(env::sha256(&buf))
}

fn validate_ciphertext_hex(s: &str) {
    require!(
        s.len() >= MIN_CIPHERTEXT_HEX && s.len() <= MAX_CIPHERTEXT_HEX && s.len().is_multiple_of(2),
        "ciphertext must be even-length hex of 64 to 2048 characters"
    );
    require!(
        s.chars().all(|c| c.is_ascii_hexdigit()),
        "ciphertext must be hex"
    );
}

/// Lowercase only, so one key has one spelling and the duplicate-read check can
/// compare strings.
fn is_compressed_pubkey(s: &str) -> bool {
    s.len() == 66
        && (s.starts_with("02") || s.starts_with("03"))
        && s.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

fn is_hex_of_len(s: &str, len: usize) -> bool {
    s.len() == len && len.is_multiple_of(2) && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// The readers the council approved, in the order it approved them.
fn readers() -> Vec<AccountId> {
    env::storage_read(&StorageKey::Readers.into_storage_key())
        .map(|b| {
            borsh::from_slice(&b)
                .unwrap_or_else(|_| env::panic_str("the reader list is unreadable"))
        })
        .unwrap_or_default()
}

fn set_readers(r: &[AccountId]) {
    let key = StorageKey::Readers.into_storage_key();
    if r.is_empty() {
        env::storage_remove(&key);
    } else {
        env::storage_write(
            &key,
            &borsh::to_vec(r).unwrap_or_else(|_| env::panic_str("cannot store readers")),
        );
    }
}

/// Whether paid reads are limited to approved readers. Off unless the council
/// turned it on.
fn readers_only() -> bool {
    env::storage_has_key(&StorageKey::ReadersOnly.into_storage_key())
}

#[cfg(test)]
mod tests;
