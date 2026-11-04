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
    env, ext_contract, log, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue, PromiseResult,
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
    pub loan: String,
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
    pub loan: String,
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

/// A fund asking to join the panel. The owner approves or rejects it.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Application {
    pub account: AccountId,
    /// Who the fund wants to audit its submissions, if anyone.
    pub auditor: Option<AccountId>,
    pub note: String,
    pub applied_at: U64,
    pub bond: U128,
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
    owner: AccountId,
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
}

/// The state before `pending_since`, for `migrate`.
#[near(serializers = [borsh])]
pub struct NemaV2 {
    owner: AccountId,
    outlayer_id: AccountId,
    project_id: String,
    secrets_account: AccountId,
    secrets_profile: String,
    min_contributors: u32,
    read_price: u128,
    members: IterableSet<AccountId>,
    rounds: IterableMap<u64, Round>,
    next_round_id: u64,
    purchases: IterableMap<u64, Purchase>,
    next_purchase_id: u64,
    earnings: LookupMap<AccountId, u128>,
    applications: IterableMap<AccountId, Application>,
    auditors: LookupMap<AccountId, Appointment>,
    audits: IterableMap<u64, AuditCopy>,
    next_audit_id: u64,
    purchases_by_buyer: LookupMap<AccountId, Vec<u64>>,
    audits_by_auditor: LookupMap<AccountId, Vec<u64>>,
}

#[near]
impl Nema {
    #[init]
    pub fn new(
        owner: AccountId,
        outlayer_id: AccountId,
        project_id: String,
        secrets_account: AccountId,
        secrets_profile: String,
        min_contributors: u32,
        read_price: U128,
    ) -> Self {
        require!(
            min_contributors >= 4,
            "the minimum must be at least 4 funds"
        );
        Self {
            owner,
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
        }
    }

    /// Upgrade state written by the previous build, which had no `pending_since`.
    /// Rounds, reads and audits keep their layout and carry over as they are.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: NemaV2 =
            env::state_read().unwrap_or_else(|| env::panic_str("no state to migrate"));
        Self {
            owner: old.owner,
            outlayer_id: old.outlayer_id,
            project_id: old.project_id,
            secrets_account: old.secrets_account,
            secrets_profile: old.secrets_profile,
            min_contributors: old.min_contributors,
            read_price: old.read_price,
            members: old.members,
            rounds: old.rounds,
            next_round_id: old.next_round_id,
            purchases: old.purchases,
            next_purchase_id: old.next_purchase_id,
            earnings: old.earnings,
            applications: old.applications,
            auditors: old.auditors,
            audits: old.audits,
            next_audit_id: old.next_audit_id,
            purchases_by_buyer: old.purchases_by_buyer,
            audits_by_auditor: old.audits_by_auditor,
            pending_since: LookupMap::new(StorageKey::PendingSince),
        }
    }

    // ---- owner ----

    pub fn add_member(&mut self, account: AccountId) {
        self.assert_owner();
        require!(self.members.len() < MAX_MEMBERS, "the panel is full");
        self.members.insert(account);
    }

    pub fn remove_member(&mut self, account: AccountId) {
        self.assert_owner();
        self.members.remove(&account);
    }

    /// Admit an applicant, with the auditor it asked for. Its bond is returned.
    pub fn approve(&mut self, account: AccountId) -> Promise {
        self.assert_owner();
        require!(self.members.len() < MAX_MEMBERS, "the panel is full");
        let app = self
            .applications
            .remove(&account)
            .unwrap_or_else(|| env::panic_str("no such application"));
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
        Self::pay(account, app.bond.0)
    }

    /// Turn an applicant away. Its bond is returned.
    pub fn reject(&mut self, account: AccountId) -> Promise {
        self.assert_owner();
        let app = self
            .applications
            .remove(&account)
            .unwrap_or_else(|| env::panic_str("no such application"));
        Self::pay(account, app.bond.0)
    }

    /// Applies to purchases made after the change.
    pub fn set_read_price(&mut self, read_price: U128) {
        self.assert_owner();
        self.read_price = read_price.0;
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

    /// Open a round. The enclave derives this round's public key; funds can
    /// submit once the key arrives. Attach at least 0.01 NEAR for the enclave call.
    #[payable]
    pub fn open_round(&mut self, loan: String, closes_at: U64) -> Promise {
        self.assert_owner();
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= MIN_OUTLAYER_DEPOSIT,
            "attach at least 0.01 NEAR for the enclave call"
        );
        require!(
            loan.len() <= 120 && !loan.is_empty(),
            "loan label must be 1 to 120 characters"
        );
        let now = env::block_timestamp();
        require!(closes_at.0 > now, "closes_at must be in the future");

        let id = self.next_round_id;
        self.next_round_id += 1;
        self.rounds.insert(
            id,
            Round {
                id,
                loan,
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
    /// round closes counts.
    pub fn submit(&mut self, round_id: u64, ciphertext_hex: String) {
        let who = env::predecessor_account_id();
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
        emit(
            "mark_submitted",
            json!({"round_id": round_id, "account": who}),
        );
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
                    .on_tally(round_id, caller, U128(fee)),
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
    pub fn on_tally(&mut self, round_id: u64, payer: AccountId, fee: U128) {
        self.apply_tally(round_id, enclave_answer(payer, fee));
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
            "owner": self.owner,
            "outlayer": self.outlayer_id,
            "project_id": self.project_id,
            "min_contributors": self.min_contributors,
            "read_price": U128(self.read_price),
            "application_bond": U128(APPLICATION_BOND),
            "storage_deposit": U128(STORAGE_DEPOSIT),
            "enclave_fee": U128(MIN_OUTLAYER_DEPOSIT),
        })
    }
}

impl Nema {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner can do this"
        );
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
            Self::pay(payer.clone(), deposit - fee);
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
                    Self::pay(purchase.buyer.clone(), purchase.price.0);
                }
                emit(
                    "read_refunded",
                    json!({"purchase_id": purchase_id, "error": p.error}),
                );
            }
        }
    }

    /// Equal shares to each contributor; the indivisible remainder goes to the owner.
    fn credit_contributors(&mut self, contributors: &[AccountId], amount: u128) {
        if contributors.is_empty() || amount == 0 {
            return;
        }
        let share = amount / contributors.len() as u128;
        let remainder = amount - share * contributors.len() as u128;
        for c in contributors {
            *self.earnings.entry(c.clone()).or_insert(0) += share;
        }
        if remainder > 0 {
            *self.earnings.entry(self.owner.clone()).or_insert(0) += remainder;
        }
    }
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

/// The enclave's answer to the call this callback follows. If OutLayer refused the
/// call itself, NEAR returned its fee here, so it goes back to the payer. Bytes that
/// are not JSON are a failure, not a panic.
fn enclave_answer(payer: AccountId, fee: U128) -> Result<Value, String> {
    match env::promise_result(0) {
        PromiseResult::Successful(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) => outcome(Ok(v)),
            Err(_) => Err("the enclave returned something that is not JSON".into()),
        },
        PromiseResult::Failed => {
            if fee.0 > 0 {
                Nema::pay(payer.clone(), fee.0);
                emit(
                    "enclave_fee_refunded",
                    json!({"account": payer, "amount": fee}),
                );
            }
            outcome(Err(PromiseError::Failed))
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
        loan: r.loan.clone(),
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

#[cfg(test)]
mod tests;
