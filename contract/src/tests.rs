use super::*;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::testing_env;

const NS: u64 = 1_000_000_000;
const DEPOSIT: u128 = MIN_OUTLAYER_DEPOSIT;
/// What a read or an audit attaches on top of any price: storage plus the enclave fee.
const READ: u128 = STORAGE_DEPOSIT + MIN_OUTLAYER_DEPOSIT;
/// 1 NEAR plus 3 yocto, so a five-way split leaves a remainder.
const PRICE: u128 = 1_000_000_000_000_000_000_000_003;

fn ctx(pred: &AccountId, deposit: u128, secs: u64) -> near_sdk::VMContext {
    VMContextBuilder::new()
        .predecessor_account_id(pred.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(secs * NS)
        .build()
}

fn owner() -> AccountId {
    accounts(0)
}

fn funds() -> Vec<AccountId> {
    (1..=5).map(accounts).collect()
}

fn buyer() -> AccountId {
    "lender.testnet".parse().unwrap()
}

fn pubkey() -> String {
    format!("02{}", "ab".repeat(32))
}

fn ct(seed: u8) -> String {
    format!("{:02x}", seed).repeat(40)
}

fn commitment() -> String {
    "c0".repeat(32)
}

fn sealed() -> String {
    "5e".repeat(220)
}

fn fresh() -> Nema {
    testing_env!(ctx(&owner(), 0, 100));
    Nema::new(
        owner(),
        "outlayer.testnet".parse().unwrap(),
        "nema-dev.testnet/nema-aggregator".into(),
        "nema-dev.testnet".parse().unwrap(),
        "default".into(),
        4,
        U128(PRICE),
    )
}

/// A contract with five funds and one open round (closes at t=1000s).
fn with_open_round() -> Nema {
    let mut c = fresh();
    for f in funds() {
        c.add_member(f);
    }
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round("Loan A".into(), U64(1000 * NS));
    c.apply_round_key(1, Ok(json!({ "ok": true, "pubkey": pubkey() })));
    c
}

fn submit_from(c: &mut Nema, who: &AccountId, seed: u8) {
    testing_env!(ctx(who, 0, 200));
    c.submit(1, ct(seed));
}

fn submit_all(c: &mut Nema) {
    for (i, f) in funds().iter().enumerate() {
        submit_from(c, f, i as u8 + 1);
    }
}

fn close(c: &mut Nema) {
    testing_env!(ctx(&accounts(1), DEPOSIT, 1001));
    let _ = c.close_round(1);
}

fn status(c: &Nema) -> RoundStatus {
    c.get_round(U64(1)).unwrap().status
}

fn set_hash(c: &Nema) -> String {
    c.get_round(U64(1)).unwrap().set_hash.unwrap()
}

fn good_tally(set_hash: &str) -> Value {
    json!({
        "ok": true, "count": 5, "rejected": [], "set_hash": set_hash, "commitment": commitment(),
    })
}

/// Five submissions, closed, and the enclave's tally applied.
fn published() -> Nema {
    let mut c = with_open_round();
    submit_all(&mut c);
    close(&mut c);
    let h = set_hash(&c);
    c.apply_tally(1, Ok(good_tally(&h)));
    assert_eq!(status(&c), RoundStatus::Published);
    c
}

fn buy(c: &mut Nema) -> u64 {
    testing_env!(ctx(&buyer(), PRICE + READ, 1100));
    let _ = c.buy_read(1, pubkey());
    c.get_purchases_of(buyer()).last().unwrap().id.0
}

fn good_delivery(set_hash: &str) -> Value {
    json!({"ok": true, "set_hash": set_hash, "commitment": commitment(), "sealed": sealed()})
}

fn purchase(c: &Nema, id: u64) -> Purchase {
    c.get_purchase(U64(id)).unwrap()
}

// ---- setup and access ----

#[test]
#[should_panic(expected = "at least 4")]
fn minimum_below_four_is_refused() {
    testing_env!(ctx(&owner(), 0, 100));
    Nema::new(
        owner(),
        "outlayer.testnet".parse().unwrap(),
        "p".into(),
        "s.testnet".parse().unwrap(),
        "default".into(),
        3,
        U128(PRICE),
    );
}

#[test]
#[should_panic(expected = "only the owner")]
fn only_the_owner_adds_members() {
    let mut c = fresh();
    testing_env!(ctx(&accounts(1), 0, 100));
    c.add_member(accounts(2));
}

#[test]
#[should_panic(expected = "only the owner")]
fn only_the_owner_sets_the_price() {
    let mut c = fresh();
    testing_env!(ctx(&accounts(1), 0, 100));
    c.set_read_price(U128(0));
}

#[test]
#[should_panic(expected = "attach at least")]
fn opening_a_round_needs_the_enclave_deposit() {
    let mut c = fresh();
    testing_env!(ctx(&owner(), 1, 100));
    let _ = c.open_round("Loan A".into(), U64(1000 * NS));
}

// ---- round key ----

#[test]
fn round_waits_for_its_key_then_opens() {
    let mut c = fresh();
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round("Loan A".into(), U64(1000 * NS));
    assert_eq!(status(&c), RoundStatus::AwaitingKey);
    c.apply_round_key(1, Ok(json!({ "ok": true, "pubkey": pubkey() })));
    assert_eq!(status(&c), RoundStatus::Open);
    assert_eq!(c.get_round(U64(1)).unwrap().pubkey, Some(pubkey()));
}

#[test]
fn malformed_key_fails_the_round() {
    let mut c = fresh();
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round("Loan A".into(), U64(1000 * NS));
    c.apply_round_key(1, Ok(json!({ "ok": true, "pubkey": "04deadbeef" })));
    assert_eq!(status(&c), RoundStatus::Failed);
}

#[test]
fn the_enclave_refusing_a_key_is_recorded() {
    let mut c = fresh();
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round("Loan A".into(), U64(1000 * NS));
    c.apply_round_key(1, Ok(json!({ "ok": false, "error": "only the round's contract may call this module" })));
    let r = c.get_round(U64(1)).unwrap();
    assert_eq!(r.status, RoundStatus::Failed);
    assert!(r.last_error.unwrap().contains("only the round's contract"));
}

#[test]
fn enclave_error_on_key_fails_the_round_without_panicking() {
    let mut c = fresh();
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round("Loan A".into(), U64(1000 * NS));
    c.apply_round_key(1, Err("boom".into()));
    let r = c.get_round(U64(1)).unwrap();
    assert_eq!(r.status, RoundStatus::Failed);
    assert_eq!(r.last_error.as_deref(), Some("boom"));
}

// ---- submissions ----

#[test]
#[should_panic(expected = "not a panel member")]
fn outsiders_cannot_submit() {
    let mut c = with_open_round();
    testing_env!(ctx(&"mallory.near".parse().unwrap(), 0, 200));
    c.submit(1, ct(9));
}

#[test]
#[should_panic(expected = "not open")]
fn cannot_submit_before_the_key_arrives() {
    let mut c = fresh();
    c.add_member(accounts(1));
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round("Loan A".into(), U64(1000 * NS));
    testing_env!(ctx(&accounts(1), 0, 200));
    c.submit(1, ct(1));
}

#[test]
#[should_panic(expected = "has closed")]
fn cannot_submit_after_the_deadline() {
    let mut c = with_open_round();
    testing_env!(ctx(&accounts(1), 0, 1000));
    c.submit(1, ct(1));
}

#[test]
#[should_panic(expected = "must be hex")]
fn ciphertext_must_be_hex() {
    let mut c = with_open_round();
    testing_env!(ctx(&accounts(1), 0, 200));
    c.submit(1, "zz".repeat(40));
}

#[test]
#[should_panic(expected = "even-length hex")]
fn ciphertext_must_be_long_enough() {
    let mut c = with_open_round();
    testing_env!(ctx(&accounts(1), 0, 200));
    c.submit(1, "ab".into());
}

#[test]
fn resubmitting_replaces_the_earlier_mark() {
    let mut c = with_open_round();
    submit_from(&mut c, &accounts(1), 1);
    submit_from(&mut c, &accounts(1), 7);
    let subs = c.get_submissions(U64(1));
    assert_eq!(subs.len(), 1);
    assert_eq!(subs[0].ciphertext_hex, ct(7));
}

// ---- the committed set ----

#[test]
fn set_hash_ignores_order_but_not_content() {
    let mk = |acct: AccountId, seed: u8| Submission {
        account: acct,
        ciphertext_hex: ct(seed),
        submitted_at: U64(1),
    };
    testing_env!(ctx(&owner(), 0, 100));
    let a = compute_set_hash(&[mk(accounts(1), 1), mk(accounts(2), 2)]);
    let b = compute_set_hash(&[mk(accounts(2), 2), mk(accounts(1), 1)]);
    let changed = compute_set_hash(&[mk(accounts(1), 1), mk(accounts(2), 3)]);
    let dropped = compute_set_hash(&[mk(accounts(1), 1)]);
    assert_eq!(a, b);
    assert_ne!(a, changed);
    assert_ne!(a, dropped);
    assert_eq!(a.len(), 64);
}

#[test]
fn set_hash_matches_the_enclaves_fixed_vector() {
    // The enclave's tests pin the same input to the same file.
    testing_env!(ctx(&owner(), 0, 100));
    let mk = |acct: &str, ct: String| Submission {
        account: acct.parse().unwrap(),
        ciphertext_hex: ct,
        submitted_at: U64(1),
    };
    let subs = [mk("alice.testnet", "ab".repeat(40)), mk("bob.testnet", "cd".repeat(40))];
    assert_eq!(compute_set_hash(&subs), include_str!("../../testdata/set_hash_vector.txt"));
}

// ---- closing ----

#[test]
#[should_panic(expected = "still open")]
fn cannot_close_before_the_deadline() {
    let mut c = with_open_round();
    submit_all(&mut c);
    testing_env!(ctx(&accounts(1), DEPOSIT, 999));
    let _ = c.close_round(1);
}

#[test]
fn too_few_submissions_fail_the_round_without_calling_the_enclave() {
    let mut c = with_open_round();
    for (i, f) in funds().iter().take(3).enumerate() {
        submit_from(&mut c, f, i as u8 + 1);
    }
    close(&mut c);
    let r = c.get_round(U64(1)).unwrap();
    assert_eq!(r.status, RoundStatus::Failed);
    assert!(r.last_error.unwrap().contains("only 3 of the required 4"));
    assert!(r.set_hash.is_none());
}

#[test]
fn closing_commits_the_set_and_waits_for_the_enclave() {
    let mut c = with_open_round();
    submit_all(&mut c);
    close(&mut c);
    let r = c.get_round(U64(1)).unwrap();
    assert_eq!(r.status, RoundStatus::Closing);
    assert_eq!(r.set_hash.unwrap().len(), 64);
}

// ---- the enclave's tally ----

#[test]
fn closing_records_who_asked_for_the_tally() {
    let mut c = with_open_round();
    submit_all(&mut c);
    close(&mut c);
    assert_eq!(c.get_round(U64(1)).unwrap().closed_by, Some(accounts(1)));
}

#[test]
fn a_valid_tally_publishes_a_listing_without_the_result() {
    let c = published();
    let r = c.get_round(U64(1)).unwrap();
    let listing = r.listing.unwrap();
    assert_eq!(listing.count, 5);
    assert_eq!(listing.commitment, commitment());
    assert_eq!(listing.set_hash, set_hash(&c));
    assert_eq!(listing.contributors, funds());
    let shown = serde_json::to_string(&c.get_round(U64(1)).unwrap()).unwrap();
    assert!(!shown.contains("mean") && !shown.contains("spread"));
}

#[test]
fn rejected_funds_are_not_contributors() {
    let mut c = with_open_round();
    submit_all(&mut c);
    close(&mut c);
    let h = set_hash(&c);
    let e = accounts(5).to_string();
    c.apply_tally(1, Ok(json!({
        "ok": true, "count": 4, "set_hash": h, "commitment": commitment(),
        "rejected": [{"account": e, "reason": "out of range"}],
    })));
    let listing = c.get_round(U64(1)).unwrap().listing.unwrap();
    assert_eq!(listing.contributors, funds()[..4].to_vec());
}

fn tally_is_refused(out: Value, expect: &str) {
    let mut c = with_open_round();
    submit_all(&mut c);
    close(&mut c);
    let h = set_hash(&c);
    let mut out = out;
    if out.get("set_hash") == Some(&json!("COMMITTED")) {
        out["set_hash"] = json!(h);
    }
    c.apply_tally(1, Ok(out));
    let r = c.get_round(U64(1)).unwrap();
    assert_eq!(r.status, RoundStatus::CloseFailed);
    assert!(r.listing.is_none());
    let err = r.last_error.unwrap();
    assert!(err.contains(expect), "{err}");
}

#[test]
fn a_tally_of_a_different_set_is_refused_and_the_close_can_be_retried() {
    let mut c = with_open_round();
    submit_all(&mut c);
    close(&mut c);
    c.apply_tally(1, Ok(good_tally(&"00".repeat(32))));
    let r = c.get_round(U64(1)).unwrap();
    assert_eq!(r.status, RoundStatus::CloseFailed);
    assert!(r.last_error.unwrap().contains("different submission set"));
    assert!(r.listing.is_none());
    testing_env!(ctx(&accounts(2), DEPOSIT, 1002));
    let _ = c.close_round(1);
    assert_eq!(status(&c), RoundStatus::Closing);
}

#[test]
fn a_count_below_the_minimum_is_not_published() {
    let rejected: Vec<Value> =
        funds()[3..].iter().map(|f| json!({"account": f, "reason": "cannot decrypt"})).collect();
    tally_is_refused(
        json!({"ok": true, "count": 3, "rejected": rejected, "set_hash": "COMMITTED", "commitment": commitment()}),
        "implausible contributor count",
    );
}

#[test]
fn a_count_that_does_not_add_up_is_not_published() {
    tally_is_refused(
        json!({"ok": true, "count": 4, "rejected": [], "set_hash": "COMMITTED", "commitment": commitment()}),
        "implausible contributor count",
    );
    tally_is_refused(
        json!({"ok": true, "count": 9, "rejected": [], "set_hash": "COMMITTED", "commitment": commitment()}),
        "implausible contributor count",
    );
}

#[test]
fn rejecting_an_unknown_account_is_not_published() {
    tally_is_refused(
        json!({"ok": true, "count": 4, "set_hash": "COMMITTED", "commitment": commitment(),
               "rejected": [{"account": "stranger.testnet", "reason": "x"}]}),
        "unknown or repeated",
    );
}

#[test]
fn rejecting_an_account_twice_is_not_published() {
    let e = accounts(5).to_string();
    tally_is_refused(
        json!({"ok": true, "count": 3, "set_hash": "COMMITTED", "commitment": commitment(),
               "rejected": [{"account": e, "reason": "x"}, {"account": e, "reason": "x"}]}),
        "unknown or repeated",
    );
}

#[test]
fn a_missing_or_malformed_commitment_is_not_published() {
    tally_is_refused(json!({"ok": true, "count": 5, "rejected": [], "set_hash": "COMMITTED"}), "missing commitment");
    tally_is_refused(
        json!({"ok": true, "count": 5, "rejected": [], "set_hash": "COMMITTED", "commitment": "zz"}),
        "malformed commitment",
    );
}

#[test]
fn the_enclave_declining_is_recorded_not_panicked() {
    tally_is_refused(json!({"ok": false, "error": "only 3 valid submissions, 4 required"}), "only 3 valid");
}

#[test]
fn a_failed_enclave_call_is_recorded_not_panicked() {
    let mut c = with_open_round();
    submit_all(&mut c);
    close(&mut c);
    c.apply_tally(1, Err("the enclave call failed".into()));
    assert_eq!(status(&c), RoundStatus::CloseFailed);
}

#[test]
fn a_late_duplicate_callback_cannot_change_a_published_round() {
    let mut c = published();
    let h = set_hash(&c);
    let mut other = good_tally(&h);
    other["commitment"] = json!("11".repeat(32));
    c.apply_tally(1, Ok(other));
    let r = c.get_round(U64(1)).unwrap();
    assert_eq!(r.status, RoundStatus::Published);
    assert_eq!(r.listing.unwrap().commitment, commitment());
}

#[test]
fn a_published_round_cannot_be_closed_again() {
    let mut c = published();
    testing_env!(ctx(&accounts(1), DEPOSIT, 1100));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.close_round(1);
    }));
    assert!(result.is_err());
    assert_eq!(status(&c), RoundStatus::Published);
}

// ---- buying a read ----

#[test]
#[should_panic(expected = "no published result")]
fn an_unpublished_round_cannot_be_bought() {
    let mut c = with_open_round();
    submit_all(&mut c);
    testing_env!(ctx(&buyer(), PRICE + READ, 300));
    let _ = c.buy_read(1, pubkey());
}

#[test]
#[should_panic(expected = "attach the read price")]
fn a_read_needs_the_price_and_the_enclave_deposit() {
    let mut c = published();
    testing_env!(ctx(&buyer(), PRICE, 1100));
    let _ = c.buy_read(1, pubkey());
}

#[test]
#[should_panic(expected = "compressed secp256k1")]
fn a_read_needs_a_valid_buyer_key() {
    let mut c = published();
    testing_env!(ctx(&buyer(), PRICE + READ, 1100));
    let _ = c.buy_read(1, "04".to_string() + &"ab".repeat(64));
}

#[test]
fn buying_records_a_pending_purchase() {
    let mut c = published();
    let id = buy(&mut c);
    let p = purchase(&c, id);
    assert_eq!(p.status, PurchaseStatus::Pending);
    assert_eq!(p.buyer, buyer());
    assert_eq!(p.price, U128(PRICE));
    assert!(p.sealed.is_none());
}

#[test]
fn a_valid_delivery_stores_the_sealed_copy_and_pays_contributors() {
    let mut c = published();
    let id = buy(&mut c);
    let h = set_hash(&c);
    c.apply_delivery(id, Ok(good_delivery(&h)));
    let p = purchase(&c, id);
    assert_eq!(p.status, PurchaseStatus::Delivered);
    assert_eq!(p.sealed, Some(sealed()));
    let share = PRICE / 5;
    for f in funds() {
        assert_eq!(c.get_earnings(f).0, share);
    }
    assert_eq!(c.get_earnings(owner()).0, PRICE - share * 5);
    assert_eq!(c.get_earnings(buyer()).0, 0);
}

#[test]
fn a_rejected_fund_earns_nothing() {
    let mut c = with_open_round();
    submit_all(&mut c);
    close(&mut c);
    let h = set_hash(&c);
    let e = accounts(5);
    c.apply_tally(1, Ok(json!({
        "ok": true, "count": 4, "set_hash": h, "commitment": commitment(),
        "rejected": [{"account": e.to_string(), "reason": "out of range"}],
    })));
    let id = buy(&mut c);
    c.apply_delivery(id, Ok(good_delivery(&h)));
    assert_eq!(c.get_earnings(e).0, 0);
    assert_eq!(c.get_earnings(accounts(1)).0, PRICE / 4);
}

fn delivery_is_refunded(out: Result<Value, String>, expect: &str) {
    let mut c = published();
    let id = buy(&mut c);
    c.apply_delivery(id, out);
    let p = purchase(&c, id);
    assert_eq!(p.status, PurchaseStatus::Refunded);
    assert!(p.sealed.is_none());
    let err = p.error.unwrap();
    assert!(err.contains(expect), "{err}");
    for f in funds() {
        assert_eq!(c.get_earnings(f).0, 0);
    }
}

#[test]
fn a_delivery_for_another_commitment_is_refunded() {
    let mut out = good_delivery("x");
    out["commitment"] = json!("11".repeat(32));
    // set_hash is checked first, so give it the real one.
    let mut c = published();
    out["set_hash"] = json!(set_hash(&c));
    let id = buy(&mut c);
    c.apply_delivery(id, Ok(out));
    let p = purchase(&c, id);
    assert_eq!(p.status, PurchaseStatus::Refunded);
    assert!(p.error.unwrap().contains("does not match the commitment"));
}

#[test]
fn a_delivery_for_another_set_is_refunded() {
    delivery_is_refunded(Ok(good_delivery(&"00".repeat(32))), "different submission set");
}

/// The set hash depends only on the submissions, which every test makes the same way.
fn standard_set_hash() -> String {
    let mut c = with_open_round();
    submit_all(&mut c);
    testing_env!(ctx(&owner(), 0, 300));
    compute_set_hash(&c.get_submissions(U64(1)))
}

#[test]
fn a_non_hex_sealed_copy_is_refunded() {
    let mut out = good_delivery(&standard_set_hash());
    out["sealed"] = json!("zz".repeat(120));
    delivery_is_refunded(Ok(out), "malformed sealed result");
}

#[test]
fn an_oversized_sealed_copy_is_refunded() {
    let mut out = good_delivery(&standard_set_hash());
    out["sealed"] = json!("ab".repeat(1000));
    delivery_is_refunded(Ok(out), "malformed sealed result");
}

#[test]
fn a_failed_enclave_call_on_delivery_is_refunded() {
    delivery_is_refunded(Err("the enclave call failed".into()), "the enclave call failed");
}

#[test]
fn the_enclave_declining_a_delivery_is_refunded() {
    delivery_is_refunded(Ok(json!({"ok": false, "error": "invalid buyer key"})), "invalid buyer key");
}

#[test]
fn a_late_duplicate_delivery_cannot_pay_twice() {
    let mut c = published();
    let id = buy(&mut c);
    let h = set_hash(&c);
    c.apply_delivery(id, Ok(good_delivery(&h)));
    c.apply_delivery(id, Ok(good_delivery(&h)));
    assert_eq!(c.get_earnings(accounts(1)).0, PRICE / 5);
}

#[test]
fn a_refunded_purchase_cannot_later_be_delivered() {
    let mut c = published();
    let id = buy(&mut c);
    let h = set_hash(&c);
    c.apply_delivery(id, Err("timeout".into()));
    c.apply_delivery(id, Ok(good_delivery(&h)));
    assert_eq!(purchase(&c, id).status, PurchaseStatus::Refunded);
    assert_eq!(c.get_earnings(accounts(1)).0, 0);
}

// ---- withdrawing ----

#[test]
fn withdrawing_clears_the_balance() {
    let mut c = published();
    let id = buy(&mut c);
    let h = set_hash(&c);
    c.apply_delivery(id, Ok(good_delivery(&h)));
    testing_env!(ctx(&accounts(1), 0, 1200));
    let _ = c.withdraw();
    assert_eq!(c.get_earnings(accounts(1)).0, 0);
    assert_eq!(c.get_earnings(accounts(2)).0, PRICE / 5);
}

#[test]
#[should_panic(expected = "nothing to withdraw")]
fn withdrawing_nothing_is_refused() {
    let mut c = fresh();
    testing_env!(ctx(&accounts(1), 0, 100));
    let _ = c.withdraw();
}

// ---- helpers ----

#[test]
fn outcome_maps_enclave_responses() {
    let ok = OutLayerResponse { success: true, result: json!({"a": 1}), error: None };
    assert_eq!(outcome(Ok(Some(ok))).unwrap(), json!({"a": 1}));
    let bad = OutLayerResponse { success: false, result: Value::Null, error: Some("nope".into()) };
    assert_eq!(outcome(Ok(Some(bad))).unwrap_err(), "nope");
    assert!(outcome(Ok(None)).is_err());
    assert!(outcome(Err(PromiseError::Failed)).is_err());
}

// ---- free copies for contributors and their auditors ----

fn auditor() -> AccountId {
    "auditor.testnet".parse().unwrap()
}

fn name_auditor(c: &mut Nema, fund: &AccountId) {
    testing_env!(ctx(fund, 0, 150));
    c.set_auditor(Some(auditor()));
}

#[test]
fn a_contributing_fund_reads_for_free_and_nobody_is_paid() {
    let mut c = published();
    let f = funds()[0].clone();
    testing_env!(ctx(&f, READ, 1100));
    let _ = c.claim_read(1, pubkey());
    let p = c.get_purchases_of(f.clone()).pop().unwrap();
    assert_eq!((p.basis, p.price.0, p.status), (Basis::Contributed, 0, PurchaseStatus::Pending));
    let h = set_hash(&c);
    c.apply_delivery(p.id.0, Ok(good_delivery(&h)));
    assert_eq!(purchase(&c, p.id.0).status, PurchaseStatus::Delivered);
    for other in funds() {
        assert_eq!(c.get_earnings(other).0, 0);
    }
}

#[test]
fn a_contributors_auditor_reads_for_free() {
    let mut c = with_open_round();
    name_auditor(&mut c, &funds()[2]);
    submit_all(&mut c);
    close(&mut c);
    let h = set_hash(&c);
    c.apply_tally(1, Ok(good_tally(&h)));
    testing_env!(ctx(&auditor(), READ, 1100));
    let _ = c.claim_read(1, pubkey());
    assert_eq!(c.get_purchases_of(auditor())[0].basis, Basis::Audit);
}

#[test]
#[should_panic(expected = "read for free")]
fn an_outsider_cannot_claim_a_free_copy() {
    let mut c = published();
    testing_env!(ctx(&buyer(), READ, 1100));
    let _ = c.claim_read(1, pubkey());
}

#[test]
#[should_panic(expected = "read for free")]
fn a_fund_whose_mark_was_dropped_cannot_claim_a_free_copy() {
    let mut c = with_open_round();
    submit_all(&mut c);
    close(&mut c);
    let h = set_hash(&c);
    let dropped = funds()[4].to_string();
    c.apply_tally(1, Ok(json!({
        "ok": true, "count": 4, "rejected": [{"account": dropped, "reason": "out of range"}],
        "set_hash": h, "commitment": commitment(),
    })));
    testing_env!(ctx(&funds()[4], READ, 1100));
    let _ = c.claim_read(1, pubkey());
}

#[test]
#[should_panic(expected = "no published result")]
fn a_free_copy_needs_a_published_round() {
    let mut c = with_open_round();
    submit_all(&mut c);
    testing_env!(ctx(&funds()[0], READ, 300));
    let _ = c.claim_read(1, pubkey());
}

#[test]
fn a_paid_read_records_its_basis() {
    let mut c = published();
    let id = buy(&mut c);
    assert_eq!(purchase(&c, id).basis, Basis::Purchased);
}

// ---- applications ----

const BOND: u128 = APPLICATION_BOND;

fn applicant() -> AccountId {
    "newfund.testnet".parse().unwrap()
}

fn apply_now(c: &mut Nema) {
    testing_env!(ctx(&applicant(), BOND, 120));
    c.apply(Some(auditor()), Some("Mid-market credit, 40 loans".into()));
}

#[test]
fn an_approved_applicant_joins_with_its_auditor() {
    let mut c = fresh();
    apply_now(&mut c);
    assert_eq!(c.get_applications().len(), 1);
    testing_env!(ctx(&owner(), 0, 130));
    let _ = c.approve(applicant());
    assert!(c.get_members().contains(&applicant()));
    assert!(c.get_applications().is_empty());
    assert_eq!(c.get_auditor(applicant()), Some(auditor()));
    assert_eq!(c.get_clients_of(auditor()), vec![applicant()]);
}

#[test]
fn a_rejected_or_withdrawn_application_is_removed() {
    let mut c = fresh();
    apply_now(&mut c);
    testing_env!(ctx(&owner(), 0, 130));
    let _ = c.reject(applicant());
    assert!(c.get_applications().is_empty() && !c.get_members().contains(&applicant()));
    apply_now(&mut c);
    testing_env!(ctx(&applicant(), 0, 140));
    let _ = c.withdraw_application();
    assert!(c.get_applications().is_empty());
}

#[test]
#[should_panic(expected = "application bond")]
fn applying_needs_the_bond() {
    let mut c = fresh();
    testing_env!(ctx(&applicant(), BOND - 1, 120));
    c.apply(None, None);
}

#[test]
#[should_panic(expected = "already applied")]
fn applying_twice_is_refused() {
    let mut c = fresh();
    apply_now(&mut c);
    apply_now(&mut c);
}

#[test]
#[should_panic(expected = "already a panel member")]
fn a_member_cannot_apply() {
    let mut c = with_open_round();
    testing_env!(ctx(&funds()[0], BOND, 120));
    c.apply(None, None);
}

#[test]
#[should_panic(expected = "only the owner")]
fn only_the_owner_approves() {
    let mut c = fresh();
    apply_now(&mut c);
    testing_env!(ctx(&applicant(), 0, 130));
    let _ = c.approve(applicant());
}

#[test]
#[should_panic(expected = "at most 140")]
fn a_long_note_is_refused() {
    let mut c = fresh();
    testing_env!(ctx(&applicant(), BOND, 120));
    c.apply(None, Some("x".repeat(141)));
}

// ---- auditors ----

#[test]
#[should_panic(expected = "not a panel member")]
fn only_a_member_names_an_auditor() {
    let mut c = fresh();
    testing_env!(ctx(&applicant(), 0, 120));
    c.set_auditor(Some(auditor()));
}

#[test]
#[should_panic(expected = "cannot audit itself")]
fn a_fund_cannot_audit_itself() {
    let mut c = with_open_round();
    let f = funds()[0].clone();
    testing_env!(ctx(&f, 0, 120));
    c.set_auditor(Some(f));
}

#[test]
fn the_named_auditor_gets_the_funds_own_submission_sealed() {
    let mut c = with_open_round();
    let f = funds()[1].clone();
    name_auditor(&mut c, &f);
    submit_from(&mut c, &f, 9);
    close(&mut c);
    testing_env!(ctx(&auditor(), READ, 1100));
    let _ = c.request_audit(1, f.clone(), pubkey());
    let a = c.get_audits_of(auditor()).pop().unwrap();
    assert_eq!((a.fund, a.status, a.submitted_at.0), (f, AuditStatus::Pending, 200 * NS));
    c.apply_audit(a.id.0, Ok(json!({"ok": true, "sealed": sealed()})));
    let a = c.get_audits_of(auditor()).pop().unwrap();
    assert_eq!((a.status, a.sealed), (AuditStatus::Delivered, Some(sealed())));
}

#[test]
fn a_failed_audit_is_recorded_not_panicked() {
    let mut c = with_open_round();
    let f = funds()[1].clone();
    name_auditor(&mut c, &f);
    submit_from(&mut c, &f, 9);
    close(&mut c);
    testing_env!(ctx(&auditor(), READ, 1100));
    let _ = c.request_audit(1, f, pubkey());
    c.apply_audit(1, Ok(json!({"ok": false, "error": "encrypted for another account"})));
    let a = c.get_audits_of(auditor()).pop().unwrap();
    assert_eq!(a.status, AuditStatus::Failed);
    assert_eq!(a.error.as_deref(), Some("encrypted for another account"));
    c.apply_audit(1, Ok(json!({"ok": true, "sealed": sealed()})));
    assert_eq!(c.get_audits_of(auditor())[0].status, AuditStatus::Failed, "a settled audit stays settled");
}

#[test]
#[should_panic(expected = "only the auditor this fund named")]
fn nobody_else_can_audit_a_fund() {
    let mut c = with_open_round();
    let f = funds()[1].clone();
    name_auditor(&mut c, &f);
    submit_from(&mut c, &f, 9);
    testing_env!(ctx(&owner(), READ, 300));
    let _ = c.request_audit(1, f, pubkey());
}

#[test]
#[should_panic(expected = "only the auditor this fund named")]
fn a_cleared_auditor_loses_access() {
    let mut c = with_open_round();
    let f = funds()[1].clone();
    name_auditor(&mut c, &f);
    submit_from(&mut c, &f, 9);
    testing_env!(ctx(&f, 0, 250));
    c.set_auditor(None);
    testing_env!(ctx(&auditor(), READ, 300));
    let _ = c.request_audit(1, f, pubkey());
}

#[test]
#[should_panic(expected = "no submission")]
fn an_audit_needs_a_submission() {
    let mut c = with_open_round();
    let f = funds()[1].clone();
    name_auditor(&mut c, &f);
    close(&mut c);
    testing_env!(ctx(&auditor(), READ, 1100));
    let _ = c.request_audit(1, f, pubkey());
}

#[test]
#[should_panic(expected = "still taking marks")]
fn an_audit_waits_for_the_round_to_stop_taking_marks() {
    let mut c = with_open_round();
    let f = funds()[1].clone();
    name_auditor(&mut c, &f);
    submit_from(&mut c, &f, 9);
    testing_env!(ctx(&auditor(), READ, 300));
    let _ = c.request_audit(1, f, pubkey());
}

#[test]
fn an_auditor_named_after_the_deadline_pays_like_anyone() {
    let mut c = published();
    let f = funds()[2].clone();
    testing_env!(ctx(&f, 0, 1050));
    c.set_auditor(Some(auditor()));
    testing_env!(ctx(&owner(), 0, 1100));
    assert_eq!(c.get_free_basis(U64(1), auditor()), None);
    assert_eq!(c.get_free_basis(U64(1), f), Some(Basis::Contributed));
}

#[test]
#[should_panic(expected = "read for free")]
fn a_late_auditor_cannot_claim_a_free_copy() {
    let mut c = published();
    let f = funds()[2].clone();
    testing_env!(ctx(&f, 0, 1050));
    c.set_auditor(Some(auditor()));
    testing_env!(ctx(&auditor(), READ, 1100));
    let _ = c.claim_read(1, pubkey());
}

#[test]
fn naming_the_same_auditor_again_keeps_its_date() {
    let mut c = with_open_round();
    let f = funds()[0].clone();
    name_auditor(&mut c, &f);
    testing_env!(ctx(&f, 0, 5000));
    c.set_auditor(Some(auditor()));
    assert_eq!(c.get_appointment(f).unwrap().since.0, 150 * NS);
}

// ---- storage, one free copy, withdrawals ----

#[test]
#[should_panic(expected = "storage deposit")]
fn a_read_needs_the_storage_deposit() {
    let mut c = published();
    testing_env!(ctx(&buyer(), PRICE + DEPOSIT, 1100));
    let _ = c.buy_read(1, pubkey());
}

#[test]
#[should_panic(expected = "already have a free copy")]
fn a_fund_gets_one_free_copy_per_round() {
    let mut c = published();
    let f = funds()[0].clone();
    testing_env!(ctx(&f, READ, 1100));
    let _ = c.claim_read(1, pubkey());
    let _ = c.claim_read(1, pubkey());
}

#[test]
fn a_fund_can_claim_again_after_a_failed_copy() {
    let mut c = published();
    let f = funds()[0].clone();
    testing_env!(ctx(&f, READ, 1100));
    let _ = c.claim_read(1, pubkey());
    c.apply_delivery(1, Err("timeout".into()));
    testing_env!(ctx(&f, READ, 1110));
    let _ = c.claim_read(1, pubkey());
    assert_eq!(c.get_purchases_of(f).len(), 2);
}

#[test]
fn purchases_are_listed_per_buyer() {
    let mut c = published();
    buy(&mut c);
    testing_env!(ctx(&funds()[0], READ, 1100));
    let _ = c.claim_read(1, pubkey());
    assert_eq!(c.get_purchases_of(buyer()).len(), 1);
    assert_eq!(c.get_purchases_of(funds()[0].clone()).len(), 1);
    assert!(c.get_purchases_of(funds()[1].clone()).is_empty());
}

#[test]
fn a_failed_withdrawal_restores_the_earnings() {
    let mut c = published();
    let id = buy(&mut c);
    let h = set_hash(&c);
    c.apply_delivery(id, Ok(good_delivery(&h)));
    let f = accounts(1);
    testing_env!(ctx(&f, 0, 1200));
    let _ = c.withdraw();
    assert_eq!(c.get_earnings(f.clone()).0, 0);
    // The callback runs as the contract itself (accounts(0) in these tests).
    testing_env!(ctx(&owner(), 0, 1201));
    c.on_withdrawn(f.clone(), U128(PRICE / 5), Err(PromiseError::Failed));
    assert_eq!(c.get_earnings(f.clone()).0, PRICE / 5);
    c.on_withdrawn(f.clone(), U128(PRICE / 5), Ok(()));
    assert_eq!(c.get_earnings(f).0, PRICE / 5, "a successful transfer changes nothing");
}

#[test]
fn long_enclave_errors_are_cut() {
    let mut c = published();
    let id = buy(&mut c);
    c.apply_delivery(id, Err("é".repeat(400)));
    let err = purchase(&c, id).error.unwrap();
    assert!(err.len() <= MAX_ERROR + '…'.len_utf8() && err.ends_with('…'), "{}", err.len());
}

// ---- upgrade ----

#[test]
fn migrate_keeps_the_first_deployments_state() {
    testing_env!(ctx(&owner(), 0, 100));
    let mut members = IterableSet::new(StorageKey::Members);
    for f in funds().into_iter().take(4) {
        members.insert(f);
    }
    let old = NemaV1 {
        owner: owner(),
        outlayer_id: "outlayer.testnet".parse().unwrap(),
        project_id: "nema-dev.testnet/nema-aggregator".into(),
        secrets_account: "nema-dev.testnet".parse().unwrap(),
        secrets_profile: "default".into(),
        min_contributors: 4,
        read_price: PRICE,
        members,
        rounds: IterableMap::new(StorageKey::Rounds),
        next_round_id: 1,
        purchases: IterableMap::new(StorageKey::Purchases),
        next_purchase_id: 1,
        earnings: LookupMap::new(StorageKey::Earnings),
    };
    env::state_write(&old);
    drop(old);
    let c = Nema::migrate();
    assert_eq!(c.get_members().len(), 4);
    assert_eq!(c.get_config()["read_price"], json!(U128(PRICE)));
    assert!(c.get_applications().is_empty());
}
