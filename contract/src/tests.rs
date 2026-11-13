use super::*;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::testing_env;
use near_sdk::PromiseResult;

const NS: u64 = 1_000_000_000;
/// How long a test council may stay silent before the panel can replace it.
const DORMANT_SECS: u64 = 90 * 24 * 3600;
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

/// The first council seat. It also holds the indivisible remainder of a read fee.
fn owner() -> AccountId {
    accounts(0)
}

fn council2() -> AccountId {
    "council2.testnet".parse().unwrap()
}

fn council3() -> AccountId {
    "council3.testnet".parse().unwrap()
}

fn council() -> Vec<AccountId> {
    vec![owner(), council2(), council3()]
}

fn build(threshold: u32, delay_secs: u64, min: u32) -> Nema {
    Nema::new(
        council(),
        threshold,
        delay_secs,
        DORMANT_SECS,
        "outlayer.testnet".parse().unwrap(),
        "nema-dev.testnet/nema-aggregator".into(),
        "nema-dev.testnet".parse().unwrap(),
        "default".into(),
        min,
        U128(PRICE),
        0,
        vec![],
        vec!["Loan A".into(), "Loan B".into()],
    )
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

/// A council of three and a panel of four funds, enough to open a round.
fn fresh() -> Nema {
    // The mock keeps storage between contracts built in one test; start clean.
    near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
    testing_env!(ctx(&owner(), 0, 100));
    let mut c = build(2, 0, 4);
    for f in funds().into_iter().take(4) {
        c.members.insert(f);
    }
    c
}

/// A contract with five funds and one open round (closes at t=1000s).
fn with_open_round() -> Nema {
    let mut c = fresh();
    for f in funds() {
        c.members.insert(f);
    }
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round(U64(1), U64(1000 * NS));
    c.apply_round_key(1, Ok(json!({ "ok": true, "pubkey": pubkey() })));
    c
}

/// What the app attaches to a submission; the unused part comes back.
const SUB: u128 = 30_000_000_000_000_000_000_000;

fn submit_from(c: &mut Nema, who: &AccountId, seed: u8) {
    testing_env!(ctx(who, SUB, 200));
    let _ = c.submit(1, ct(seed));
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
    build(2, 0, 3);
}

#[test]
#[should_panic(expected = "attach at least")]
fn opening_a_round_needs_the_enclave_deposit() {
    let mut c = fresh();
    testing_env!(ctx(&owner(), 1, 100));
    let _ = c.open_round(U64(1), U64(1000 * NS));
}

// ---- round key ----

#[test]
fn round_waits_for_its_key_then_opens() {
    let mut c = fresh();
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round(U64(1), U64(1000 * NS));
    assert_eq!(status(&c), RoundStatus::AwaitingKey);
    c.apply_round_key(1, Ok(json!({ "ok": true, "pubkey": pubkey() })));
    assert_eq!(status(&c), RoundStatus::Open);
    assert_eq!(c.get_round(U64(1)).unwrap().pubkey, Some(pubkey()));
}

#[test]
fn a_round_that_never_got_its_key_can_be_ended_after_its_deadline() {
    let mut c = fresh();
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round(U64(1), U64(1000 * NS));
    close(&mut c);
    assert_eq!(status(&c), RoundStatus::Failed);
    assert!(c
        .get_round(U64(1))
        .unwrap()
        .last_error
        .unwrap()
        .contains("never received its key"));
}

#[test]
#[should_panic(expected = "still open")]
fn a_keyless_round_cannot_be_ended_early() {
    let mut c = fresh();
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round(U64(1), U64(1000 * NS));
    testing_env!(ctx(&accounts(1), DEPOSIT, 500));
    let _ = c.close_round(1);
}

#[test]
fn malformed_key_fails_the_round() {
    let mut c = fresh();
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round(U64(1), U64(1000 * NS));
    c.apply_round_key(1, Ok(json!({ "ok": true, "pubkey": "04deadbeef" })));
    assert_eq!(status(&c), RoundStatus::Failed);
}

#[test]
fn the_enclave_refusing_a_key_is_recorded() {
    let mut c = fresh();
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round(U64(1), U64(1000 * NS));
    c.apply_round_key(
        1,
        Ok(json!({ "ok": false, "error": "only the round's contract may call this module" })),
    );
    let r = c.get_round(U64(1)).unwrap();
    assert_eq!(r.status, RoundStatus::Failed);
    assert!(r.last_error.unwrap().contains("only the round's contract"));
}

#[test]
fn enclave_error_on_key_fails_the_round_without_panicking() {
    let mut c = fresh();
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round(U64(1), U64(1000 * NS));
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
    let _ = c.submit(1, ct(9));
}

#[test]
#[should_panic(expected = "not open")]
fn cannot_submit_before_the_key_arrives() {
    let mut c = fresh();
    c.members.insert(accounts(1));
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round(U64(1), U64(1000 * NS));
    testing_env!(ctx(&accounts(1), 0, 200));
    let _ = c.submit(1, ct(1));
}

#[test]
#[should_panic(expected = "has closed")]
fn cannot_submit_after_the_deadline() {
    let mut c = with_open_round();
    testing_env!(ctx(&accounts(1), 0, 1000));
    let _ = c.submit(1, ct(1));
}

#[test]
#[should_panic(expected = "must be hex")]
fn ciphertext_must_be_hex() {
    let mut c = with_open_round();
    testing_env!(ctx(&accounts(1), 0, 200));
    let _ = c.submit(1, "zz".repeat(40));
}

#[test]
#[should_panic(expected = "even-length hex")]
fn ciphertext_must_be_long_enough() {
    let mut c = with_open_round();
    testing_env!(ctx(&accounts(1), 0, 200));
    let _ = c.submit(1, "ab".into());
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
    let subs = [
        mk("alice.testnet", "ab".repeat(40)),
        mk("bob.testnet", "cd".repeat(40)),
    ];
    assert_eq!(
        compute_set_hash(&subs),
        include_str!("../../testdata/set_hash_vector.txt")
    );
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
    c.apply_tally(
        1,
        Ok(json!({
            "ok": true, "count": 4, "set_hash": h, "commitment": commitment(),
            "rejected": [{"account": e, "reason": "out of range"}],
        })),
    );
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
    let rejected: Vec<Value> = funds()[3..]
        .iter()
        .map(|f| json!({"account": f, "reason": "cannot decrypt"}))
        .collect();
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
    tally_is_refused(
        json!({"ok": true, "count": 5, "rejected": [], "set_hash": "COMMITTED"}),
        "missing commitment",
    );
    tally_is_refused(
        json!({"ok": true, "count": 5, "rejected": [], "set_hash": "COMMITTED", "commitment": "zz"}),
        "malformed commitment",
    );
}

#[test]
fn the_enclave_declining_is_recorded_not_panicked() {
    tally_is_refused(
        json!({"ok": false, "error": "only 3 valid submissions, 4 required"}),
        "only 3 valid",
    );
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
    c.apply_tally(
        1,
        Ok(json!({
            "ok": true, "count": 4, "set_hash": h, "commitment": commitment(),
            "rejected": [{"account": e.to_string(), "reason": "out of range"}],
        })),
    );
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
    delivery_is_refunded(
        Ok(good_delivery(&"00".repeat(32))),
        "different submission set",
    );
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
    delivery_is_refunded(
        Err("the enclave call failed".into()),
        "the enclave call failed",
    );
}

#[test]
fn the_enclave_declining_a_delivery_is_refunded() {
    delivery_is_refunded(
        Ok(json!({"ok": false, "error": "invalid buyer key"})),
        "invalid buyer key",
    );
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
    // What OutLayer returned for a real derive_pubkey run on testnet.
    let raw = br#"{"ok":true,"pubkey":"02b1c1743d18209603217ed407c1320dc3948cfb163339a1d3f0f374da3b651a3f"}"#;
    let v: Value = serde_json::from_slice(raw).unwrap();
    assert_eq!(outcome(Ok(v.clone())).unwrap(), v);
    let failed: Value = serde_json::from_slice(b"null").unwrap();
    assert!(outcome(Ok(failed)).is_err());
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
    assert_eq!(
        (p.basis, p.price.0, p.status),
        (Basis::Contributed, 0, PurchaseStatus::Pending)
    );
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
    c.apply_tally(
        1,
        Ok(json!({
            "ok": true, "count": 4, "rejected": [{"account": dropped, "reason": "out of range"}],
            "set_hash": h, "commitment": commitment(),
        })),
    );
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

/// Two council votes (the threshold), then the admission is finalized.
fn admit(c: &mut Nema) {
    testing_env!(ctx(&owner(), 0, 130));
    c.approve(applicant());
    testing_env!(ctx(&council2(), 0, 130));
    c.approve(applicant());
    testing_env!(ctx(&accounts(4), 0, 131));
    let _ = c.finalize_admission(applicant());
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
    admit(&mut c);
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
#[should_panic(expected = "only a council member")]
fn only_the_council_approves() {
    let mut c = fresh();
    apply_now(&mut c);
    testing_env!(ctx(&applicant(), 0, 130));
    c.approve(applicant());
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
    assert_eq!(
        (a.fund, a.status, a.submitted_at.0),
        (f, AuditStatus::Pending, 200 * NS)
    );
    c.apply_audit(a.id.0, Ok(json!({"ok": true, "sealed": sealed()})));
    let a = c.get_audits_of(auditor()).pop().unwrap();
    assert_eq!(
        (a.status, a.sealed),
        (AuditStatus::Delivered, Some(sealed()))
    );
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
    c.apply_audit(
        1,
        Ok(json!({"ok": false, "error": "encrypted for another account"})),
    );
    let a = c.get_audits_of(auditor()).pop().unwrap();
    assert_eq!(a.status, AuditStatus::Failed);
    assert_eq!(a.error.as_deref(), Some("encrypted for another account"));
    c.apply_audit(1, Ok(json!({"ok": true, "sealed": sealed()})));
    assert_eq!(
        c.get_audits_of(auditor())[0].status,
        AuditStatus::Failed,
        "a settled audit stays settled"
    );
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
    assert_eq!(
        c.get_earnings(f).0,
        PRICE / 5,
        "a successful transfer changes nothing"
    );
}

#[test]
fn long_enclave_errors_are_cut() {
    let mut c = published();
    let id = buy(&mut c);
    c.apply_delivery(id, Err("é".repeat(400)));
    let err = purchase(&c, id).error.unwrap();
    assert!(
        err.len() <= MAX_ERROR + '…'.len_utf8() && err.ends_with('…'),
        "{}",
        err.len()
    );
}

// ---- reliability: idempotent reads, settling unanswered calls ----

/// Seconds after `close` (t=1001s) at which the tally is old enough to settle.
const STALE: u64 = 1001 + 30 * 60;

#[test]
#[should_panic(expected = "this key already has a copy")]
fn retrying_a_read_with_the_same_key_does_not_pay_twice() {
    let mut c = published();
    buy(&mut c);
    buy(&mut c);
}

#[test]
fn a_new_key_or_a_refunded_read_can_buy_again() {
    let mut c = published();
    let first = buy(&mut c);
    c.apply_delivery(first, Err("enclave down".into()));
    assert_eq!(purchase(&c, first).status, PurchaseStatus::Refunded);
    let again = buy(&mut c);
    assert_ne!(again, first, "a refunded read doesn't block a retry");
    testing_env!(ctx(&buyer(), PRICE + READ, 1100));
    let _ = c.buy_read(1, format!("03{}", "cd".repeat(32)));
    assert_eq!(c.get_purchases_of(buyer()).len(), 3);
}

#[test]
fn a_tally_that_never_answers_can_be_settled_and_closed_again() {
    let mut c = with_open_round();
    submit_all(&mut c);
    close(&mut c);
    assert_eq!(status(&c), RoundStatus::Closing);
    testing_env!(ctx(&accounts(2), 0, STALE));
    c.reconcile_round(1);
    assert_eq!(status(&c), RoundStatus::CloseFailed);
    // The lost answer turning up late changes nothing.
    let h = set_hash(&c);
    c.apply_tally(1, Ok(good_tally(&h)));
    assert_eq!(status(&c), RoundStatus::CloseFailed);
    testing_env!(ctx(&accounts(2), DEPOSIT, STALE));
    let _ = c.close_round(1);
    assert_eq!(status(&c), RoundStatus::Closing);
}

#[test]
#[should_panic(expected = "the enclave may still answer")]
fn a_tally_cannot_be_settled_early() {
    let mut c = with_open_round();
    submit_all(&mut c);
    close(&mut c);
    testing_env!(ctx(&accounts(2), 0, STALE - 1));
    c.reconcile_round(1);
}

#[test]
#[should_panic(expected = "nothing is waiting on the enclave here")]
fn settling_needs_something_waiting() {
    let mut c = published();
    testing_env!(ctx(&accounts(2), 0, 100_000));
    c.reconcile_round(1);
}

#[test]
fn a_read_that_never_answers_is_refunded_and_pays_nobody() {
    let mut c = published();
    let id = buy(&mut c);
    testing_env!(ctx(&accounts(2), 0, 1100 + 30 * 60));
    let _ = c.reconcile_read(id);
    let p = purchase(&c, id);
    assert_eq!(p.status, PurchaseStatus::Refunded);
    let h = set_hash(&c);
    c.apply_delivery(id, Ok(good_delivery(&h)));
    assert_eq!(
        purchase(&c, id).status,
        PurchaseStatus::Refunded,
        "a late delivery is ignored"
    );
    for f in funds() {
        assert_eq!(c.get_earnings(f).0, 0, "nobody is paid for a refunded read");
    }
}

#[test]
fn an_audit_that_never_answers_can_be_settled() {
    let mut c = with_open_round();
    let f = funds()[1].clone();
    name_auditor(&mut c, &f);
    submit_from(&mut c, &f, 9);
    close(&mut c);
    testing_env!(ctx(&auditor(), READ, 1100));
    let _ = c.request_audit(1, f, pubkey());
    testing_env!(ctx(&accounts(2), 0, 1100 + 30 * 60));
    c.reconcile_audit(1);
    assert_eq!(c.get_audits_of(auditor())[0].status, AuditStatus::Failed);
}

// ---- access control: checked again when the enclave's answer lands ----

#[test]
fn an_audit_landing_after_the_fund_changed_auditor_is_not_delivered() {
    let mut c = with_open_round();
    let f = funds()[1].clone();
    name_auditor(&mut c, &f);
    submit_from(&mut c, &f, 9);
    close(&mut c);
    testing_env!(ctx(&auditor(), READ, 1100));
    let _ = c.request_audit(1, f.clone(), pubkey());
    testing_env!(ctx(&f, 0, 1101));
    c.set_auditor(None);
    c.apply_audit(1, Ok(json!({"ok": true, "sealed": sealed()})));
    let a = c.get_audits_of(auditor()).pop().unwrap();
    assert_eq!((a.status, a.sealed), (AuditStatus::Failed, None));
    assert!(a.error.unwrap().contains("changed its auditor"));
}

#[test]
fn a_fund_removed_before_the_close_does_not_count() {
    let mut c = with_open_round();
    submit_all(&mut c);
    testing_env!(ctx(&owner(), 0, 300));
    c.members.remove(&funds()[0].clone());
    close(&mut c);
    let r = c.get_round(U64(1)).unwrap();
    assert_eq!(r.status, RoundStatus::Closing);
    assert!(
        !r.submitted.contains(&funds()[0]),
        "its mark left the committed set"
    );
    assert_eq!(r.submitted.len(), 4);
}

#[test]
fn removing_enough_funds_fails_the_round_at_close() {
    let mut c = with_open_round();
    submit_all(&mut c);
    testing_env!(ctx(&owner(), 0, 300));
    c.members.remove(&funds()[0].clone());
    c.members.remove(&funds()[1].clone());
    close(&mut c);
    assert_eq!(status(&c), RoundStatus::Failed);
}

// ---- invariants ----

#[test]
fn every_read_price_splits_exactly_with_nothing_lost_or_made() {
    // Every price and panel size: shares plus remainder equal what was paid.
    for n in 4..=12usize {
        let contributors: Vec<AccountId> = (0..n)
            .map(|i| format!("f{i}.testnet").parse().unwrap())
            .collect();
        for price in [
            1u128,
            3,
            7,
            99,
            1_000,
            PRICE,
            PRICE * 7 + 11,
            u64::MAX as u128,
        ] {
            let mut c = fresh();
            let held = |c: &Nema| -> Vec<u128> {
                contributors
                    .iter()
                    .chain([&owner()])
                    .map(|a| c.get_earnings(a.clone()).0)
                    .collect()
            };
            let before = held(&c);
            c.credit_contributors(&contributors, price);
            let gained: Vec<u128> = held(&c).iter().zip(&before).map(|(a, b)| a - b).collect();
            assert_eq!(gained.iter().sum::<u128>(), price, "n={n} price={price}");
            assert!(
                gained[..n].windows(2).all(|w| w[0] == w[1]),
                "equal shares for n={n}"
            );
            assert!(
                gained[n] < n as u128,
                "the remainder is less than one yocto per fund"
            );
        }
    }
}

#[test]
fn state_changes_are_emitted_as_events() {
    let _c = published(); // open, key, submissions, close and tally
    let logs = near_sdk::test_utils::get_logs();
    let events: Vec<String> = logs
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<Value>(j).unwrap())
        .filter(|e| e["standard"] == "nema")
        .map(|e| e["event"].as_str().unwrap().to_string())
        .collect();
    for want in ["tally_requested", "round_published"] {
        assert!(
            events.iter().any(|e| e == want),
            "missing {want} in {events:?}"
        );
    }
}

/// NEAR sent back to `to` by the receipts this call created.
fn refunded_to(to: &AccountId) -> u128 {
    near_sdk::test_utils::get_created_receipts()
        .iter()
        .filter(|r| &r.receiver_id == to)
        .flat_map(|r| r.actions.iter())
        .filter_map(|a| match a {
            near_sdk::mock::MockAction::Transfer { deposit, .. } => Some(deposit.as_yoctonear()),
            _ => None,
        })
        .sum()
}

#[test]
fn a_refused_delivery_sends_the_price_back() {
    let mut c = published();
    let id = buy(&mut c);
    c.apply_delivery(id, Err("enclave down".into()));
    assert_eq!(refunded_to(&buyer()), PRICE);
}

#[test]
fn a_read_answer_too_long_to_read_returns_the_price_not_the_fee() {
    let mut c = published();
    let id = buy(&mut c);
    answered(
        PromiseResult::Successful(vec![b' '; MAX_ENCLAVE_ANSWER + 1]),
        1101,
    );
    c.on_deliver(id, buyer(), U128(MIN_OUTLAYER_DEPOSIT));
    assert_eq!(purchase(&c, id).status, PurchaseStatus::Refunded);
    assert_eq!(
        refunded_to(&buyer()),
        PRICE,
        "the enclave ran, so OutLayer keeps its fee; only the price comes back"
    );
}

#[test]
fn settling_an_unanswered_read_sends_the_price_back() {
    let mut c = published();
    let id = buy(&mut c);
    testing_env!(ctx(&accounts(2), 0, 1100 + 30 * 60));
    let _ = c.reconcile_read(id);
    assert_eq!(refunded_to(&buyer()), PRICE);
}

#[test]
fn the_wait_is_visible_until_the_call_settles() {
    let mut c = with_open_round();
    submit_all(&mut c);
    close(&mut c);
    assert_eq!(
        c.get_pending_since("round".into(), U64(1)),
        Some(U64(1001 * NS))
    );
    let h = set_hash(&c);
    c.apply_tally(1, Ok(good_tally(&h)));
    assert_eq!(c.get_pending_since("round".into(), U64(1)), None);
}

// ---- money never strands: fees, refunds and payments that bounce ----

/// The callback context: the contract calling itself, with `result` as the
/// answer to the enclave call it follows. (The macro form needs near-parameters,
/// which this crate doesn't depend on.)
#[allow(deprecated)]
fn answered(result: PromiseResult, secs: u64) {
    near_sdk::test_utils::testing_env_with_promise_results(
        ctx(&near_sdk::test_utils::accounts(0), 0, secs),
        result,
    );
}

fn events() -> Vec<String> {
    near_sdk::test_utils::get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<Value>(j).unwrap())
        .filter(|e| e["standard"] == "nema")
        .map(|e| e["event"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn a_fee_above_the_cap_goes_straight_back() {
    let mut c = published();
    let extra = 3 * MAX_OUTLAYER_DEPOSIT;
    testing_env!(ctx(&buyer(), PRICE + STORAGE_DEPOSIT + extra, 1100));
    let _ = c.buy_read(1, pubkey());
    assert_eq!(refunded_to(&buyer()), extra - MAX_OUTLAYER_DEPOSIT);
}

#[test]
fn a_refused_enclave_call_returns_the_fee_and_the_price() {
    let mut c = published();
    let id = buy(&mut c);
    answered(PromiseResult::Failed, 1101);
    c.on_deliver(id, buyer(), U128(MIN_OUTLAYER_DEPOSIT));
    assert_eq!(purchase(&c, id).status, PurchaseStatus::Refunded);
    assert_eq!(refunded_to(&buyer()), PRICE + MIN_OUTLAYER_DEPOSIT);
    assert!(events().contains(&"enclave_fee_refunded".to_string()));
}

#[test]
fn an_answer_that_is_not_json_is_a_failure_not_a_panic() {
    let mut c = with_open_round();
    submit_all(&mut c);
    close(&mut c);
    answered(
        PromiseResult::Successful(b"<html>502</html>".to_vec()),
        1002,
    );
    c.on_tally(1, accounts(1), U128(DEPOSIT), U64(1001 * NS));
    assert_eq!(status(&c), RoundStatus::CloseFailed);
    assert_eq!(
        refunded_to(&accounts(1)),
        0,
        "OutLayer kept the fee for a run it made"
    );
}

#[test]
fn an_answer_too_long_to_read_is_a_failure_not_a_panic() {
    let mut c = with_open_round();
    submit_all(&mut c);
    close(&mut c);
    answered(
        PromiseResult::Successful(vec![b' '; MAX_ENCLAVE_ANSWER + 1]),
        1002,
    );
    c.on_tally(1, accounts(1), U128(DEPOSIT), U64(1001 * NS));
    assert_eq!(status(&c), RoundStatus::CloseFailed);
    assert_eq!(
        refunded_to(&accounts(1)),
        0,
        "OutLayer kept the fee for a run it made"
    );
}

#[test]
fn a_round_key_too_long_to_read_fails_the_round_and_keeps_the_fee() {
    let mut c = fresh();
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round(U64(1), U64(1000 * NS));
    answered(
        PromiseResult::Successful(vec![b' '; MAX_ENCLAVE_ANSWER + 1]),
        101,
    );
    c.on_round_key(1, owner(), U128(DEPOSIT));
    let r = c.get_round(U64(1)).unwrap();
    assert_eq!(r.status, RoundStatus::Failed);
    assert!(r.last_error.unwrap().contains("more than the"));
    assert_eq!(
        refunded_to(&owner()),
        0,
        "OutLayer kept the fee for a run it made"
    );
}

#[test]
fn an_audit_too_long_to_read_fails_and_keeps_the_fee() {
    let mut c = with_open_round();
    let f = funds()[1].clone();
    name_auditor(&mut c, &f);
    submit_from(&mut c, &f, 9);
    close(&mut c);
    testing_env!(ctx(&auditor(), READ, 1100));
    let _ = c.request_audit(1, f, pubkey());
    answered(
        PromiseResult::Successful(vec![b' '; MAX_ENCLAVE_ANSWER + 1]),
        1101,
    );
    c.on_audit(1, auditor(), U128(READ));
    let a = c.get_audits_of(auditor()).pop().unwrap();
    assert_eq!(a.status, AuditStatus::Failed);
    assert_eq!(
        refunded_to(&auditor()),
        0,
        "OutLayer kept the fee for a run it made"
    );
}

#[test]
fn a_good_answer_through_the_callback_publishes() {
    let mut c = with_open_round();
    submit_all(&mut c);
    close(&mut c);
    let h = set_hash(&c);
    answered(
        PromiseResult::Successful(good_tally(&h).to_string().into_bytes()),
        1002,
    );
    c.on_tally(1, accounts(1), U128(DEPOSIT), U64(1001 * NS));
    assert_eq!(status(&c), RoundStatus::Published);
}

#[test]
fn a_payment_that_bounces_is_kept_as_earnings() {
    let mut c = fresh();
    c.on_withdrawn(buyer(), U128(PRICE), Err(PromiseError::Failed));
    assert_eq!(c.get_earnings(buyer()).0, PRICE);
}

#[test]
fn a_payment_that_lands_is_not_credited_again() {
    let mut c = fresh();
    c.on_withdrawn(buyer(), U128(PRICE), Ok(()));
    assert_eq!(c.get_earnings(buyer()).0, 0);
}

#[test]
fn withdrawing_pays_the_whole_balance() {
    let mut c = published();
    let id = buy(&mut c);
    let h = set_hash(&c);
    c.apply_delivery(id, Ok(good_delivery(&h)));
    let f = funds()[0].clone();
    let owed = c.get_earnings(f.clone()).0;
    assert!(owed > 0);
    testing_env!(ctx(&f, 0, 1200));
    let _ = c.withdraw();
    assert_eq!(refunded_to(&f), owed);
}

#[test]
fn every_bond_is_paid_back() {
    let mut c = fresh();
    apply_now(&mut c);
    admit(&mut c);
    assert_eq!(refunded_to(&applicant()), BOND, "approved");

    let mut c = fresh();
    apply_now(&mut c);
    testing_env!(ctx(&owner(), 0, 130));
    let _ = c.reject(applicant());
    assert_eq!(refunded_to(&applicant()), BOND, "rejected");

    let mut c = fresh();
    apply_now(&mut c);
    testing_env!(ctx(&applicant(), 0, 140));
    let _ = c.withdraw_application();
    assert_eq!(refunded_to(&applicant()), BOND, "withdrawn");
}

// ---- duplicates and late answers ----

#[test]
#[should_panic(expected = "compressed secp256k1")]
fn a_key_in_capitals_is_refused() {
    let mut c = published();
    testing_env!(ctx(&buyer(), PRICE + READ, 1100));
    let _ = c.buy_read(1, pubkey().to_uppercase());
}

#[test]
fn a_late_delivery_is_logged_and_ignored() {
    let mut c = published();
    let id = buy(&mut c);
    testing_env!(ctx(&accounts(2), 0, 1100 + 30 * 60));
    let _ = c.reconcile_read(id);
    assert_eq!(c.get_pending_since("read".into(), U64(id)), None);
    let h = set_hash(&c);
    c.apply_delivery(id, Ok(good_delivery(&h)));
    assert!(events().contains(&"callback_ignored".to_string()));
    assert_eq!(purchase(&c, id).status, PurchaseStatus::Refunded);
}

#[test]
fn a_late_audit_after_settling_is_ignored() {
    let mut c = with_open_round();
    let f = funds()[1].clone();
    name_auditor(&mut c, &f);
    submit_from(&mut c, &f, 9);
    close(&mut c);
    testing_env!(ctx(&auditor(), READ, 1100));
    let _ = c.request_audit(1, f, pubkey());
    testing_env!(ctx(&accounts(2), 0, 1100 + 30 * 60));
    c.reconcile_audit(1);
    assert_eq!(c.get_pending_since("audit".into(), U64(1)), None);
    c.apply_audit(1, Ok(json!({"ok": true, "sealed": sealed()})));
    let a = &c.get_audits_of(auditor())[0];
    assert_eq!((a.status, a.sealed.clone()), (AuditStatus::Failed, None));
}

#[test]
fn a_late_key_for_an_ended_round_is_ignored() {
    let mut c = fresh();
    for f in funds() {
        c.members.insert(f);
    }
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round(U64(1), U64(1000 * NS));
    testing_env!(ctx(&accounts(1), DEPOSIT, 1001));
    let _ = c.close_round(1);
    assert_eq!(status(&c), RoundStatus::Failed);
    c.apply_round_key(1, Ok(json!({ "ok": true, "pubkey": pubkey() })));
    assert_eq!(status(&c), RoundStatus::Failed);
    assert_eq!(c.get_round(U64(1)).unwrap().pubkey, None);
}

#[test]
fn settling_a_tally_clears_the_wait() {
    let mut c = with_open_round();
    submit_all(&mut c);
    close(&mut c);
    testing_env!(ctx(&accounts(2), 0, 1001 + 30 * 60));
    c.reconcile_round(1);
    assert_eq!(c.get_pending_since("round".into(), U64(1)), None);
}

#[test]
fn a_read_from_before_the_wait_was_recorded_can_still_be_settled() {
    let mut c = published();
    let id = buy(&mut c);
    c.pending_since.remove(&format!("p{id}")); // as if made by the previous build
                                               // Too soon for a read recorded at 1100s, but one with no record counts as old.
    testing_env!(ctx(&accounts(2), 0, 30 * 60));
    let _ = c.reconcile_read(id);
    assert_eq!(purchase(&c, id).status, PurchaseStatus::Refunded);
    assert_eq!(refunded_to(&buyer()), PRICE);
}

// ---- submissions pay for their storage; a stale tally can't fail a retry ----

#[test]
fn a_mark_pays_for_its_own_storage_and_gets_the_rest_back() {
    let mut c = with_open_round();
    let f = funds()[0].clone();
    submit_from(&mut c, &f, 1);
    let back = refunded_to(&f);
    assert!(back > 0 && back < SUB, "charged {} of {SUB}", SUB - back);
    // 80-byte ciphertext plus the record: a few hundred bytes at 1e19 yocto each.
    assert!(SUB - back < 10_000_000_000_000_000_000_000);
}

#[test]
#[should_panic(expected = "for the storage this mark uses")]
fn a_mark_without_a_storage_deposit_is_refused() {
    let mut c = with_open_round();
    testing_env!(ctx(&funds()[0], 0, 200));
    let _ = c.submit(1, ct(1));
}

#[test]
fn replacing_a_mark_with_one_the_same_size_costs_nothing() {
    let mut c = with_open_round();
    let f = funds()[0].clone();
    submit_from(&mut c, &f, 1);
    submit_from(&mut c, &f, 2);
    assert_eq!(refunded_to(&f), SUB);
}

#[test]
fn an_answer_to_an_earlier_close_is_ignored() {
    let mut c = with_open_round();
    submit_all(&mut c);
    close(&mut c); // first close at 1001s
    let h = set_hash(&c);
    testing_env!(ctx(&accounts(2), 0, 1001 + 30 * 60));
    c.reconcile_round(1);
    let retry_at = 1001 + 30 * 60 + 5;
    testing_env!(ctx(&accounts(2), DEPOSIT, retry_at));
    let _ = c.close_round(1);
    // The first close's tally finally lands: it answers the old close, not the retry.
    answered(
        PromiseResult::Successful(good_tally(&h).to_string().into_bytes()),
        retry_at + 1,
    );
    c.on_tally(1, accounts(1), U128(DEPOSIT), U64(1001 * NS));
    assert_eq!(
        status(&c),
        RoundStatus::Closing,
        "still waiting on the retry"
    );
    assert!(events().contains(&"callback_ignored".to_string()));
    // The retry's own answer publishes.
    answered(
        PromiseResult::Successful(good_tally(&h).to_string().into_bytes()),
        retry_at + 2,
    );
    c.on_tally(1, accounts(2), U128(DEPOSIT), U64(retry_at * NS));
    assert_eq!(status(&c), RoundStatus::Published);
}

/// A full panel of 64 funds with the largest ciphertexts: the tally and a delivery
/// that credits all 64 must fit well inside the callbacks' 40 Tgas. The mock counts
/// host-function gas (storage, hashing, logs); round 2 on testnet measured the rest
/// of a 4-fund callback at about 2 Tgas.
#[test]
fn a_full_round_fits_in_the_callback_gas() {
    let mut c = fresh();
    let panel: Vec<AccountId> = (0..MAX_MEMBERS)
        .map(|i| format!("fund{i}.testnet").parse().unwrap())
        .collect();
    for f in &panel {
        c.members.insert(f.clone());
    }
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round(U64(1), U64(1000 * NS));
    c.apply_round_key(1, Ok(json!({ "ok": true, "pubkey": pubkey() })));
    for f in &panel {
        testing_env!(ctx(f, SUB, 200));
        let _ = c.submit(1, "ab".repeat(MAX_CIPHERTEXT_HEX / 2));
    }
    close(&mut c);
    let h = set_hash(&c);

    testing_env!(ctx(&owner(), 0, 1002));
    let start = env::used_gas().as_gas();
    c.apply_tally(
        1,
        Ok(json!({"ok": true, "count": MAX_MEMBERS, "rejected": [], "set_hash": h, "commitment": commitment()})),
    );
    flush(&mut c); // collections write at the end of a call; count those writes too
    let tally = (env::used_gas().as_gas() - start) as f64 / 1e12;
    assert_eq!(status(&c), RoundStatus::Published);

    let id = buy(&mut c);
    testing_env!(ctx(&owner(), 0, 1101));
    let start = env::used_gas().as_gas();
    c.apply_delivery(id, Ok(good_delivery(&h)));
    flush(&mut c);
    let deliver = (env::used_gas().as_gas() - start) as f64 / 1e12;
    assert_eq!(purchase(&c, id).status, PurchaseStatus::Delivered);

    println!("64-fund tally: {tally:.2} Tgas, delivery to 64: {deliver:.2} Tgas (host functions)");
    assert!(
        tally + 2.0 < 40.0 && deliver + 2.0 < 40.0,
        "tally {tally}, deliver {deliver}"
    );
}

fn flush(c: &mut Nema) {
    c.rounds.flush();
    c.purchases.flush();
    c.earnings.flush();
    c.pending_since.flush();
}

#[test]
fn one_audit_can_be_read_by_id() {
    let mut c = with_open_round();
    let f = funds()[1].clone();
    name_auditor(&mut c, &f);
    submit_from(&mut c, &f, 9);
    close(&mut c);
    testing_env!(ctx(&auditor(), READ, 1100));
    let _ = c.request_audit(1, f.clone(), pubkey());
    let a = c.get_audit(U64(1)).unwrap();
    assert_eq!((a.fund, a.status), (f, AuditStatus::Pending));
    assert!(c.get_audit(U64(2)).is_none());
}

// ---- v2: the council ----

fn as_member(c: &mut Nema, who: &AccountId, secs: u64, f: impl FnOnce(&mut Nema)) {
    testing_env!(ctx(who, 0, secs));
    f(c);
}

#[test]
#[should_panic(expected = "3 to 7 different accounts")]
fn a_council_of_two_is_refused() {
    testing_env!(ctx(&owner(), 0, 100));
    let mut ids = council();
    ids.pop();
    Nema::new(
        ids,
        2,
        0,
        DORMANT_SECS,
        "o.testnet".parse().unwrap(),
        "p".into(),
        "s.testnet".parse().unwrap(),
        "d".into(),
        4,
        U128(PRICE),
        0,
        vec![],
        vec![],
    );
}

#[test]
#[should_panic(expected = "3 to 7 different accounts")]
fn a_council_cannot_seat_the_same_account_twice() {
    testing_env!(ctx(&owner(), 0, 100));
    Nema::new(
        vec![owner(), owner(), council2()],
        2,
        0,
        DORMANT_SECS,
        "o.testnet".parse().unwrap(),
        "p".into(),
        "s.testnet".parse().unwrap(),
        "d".into(),
        4,
        U128(PRICE),
        0,
        vec![],
        vec![],
    );
}

#[test]
#[should_panic(expected = "majority of the council")]
fn a_threshold_of_one_is_refused() {
    testing_env!(ctx(&owner(), 0, 100));
    build(1, 0, 4);
}

#[test]
#[should_panic(expected = "majority of the council")]
fn a_threshold_below_a_majority_is_refused() {
    // Two of four is not a majority: two members could act against the other two.
    testing_env!(ctx(&owner(), 0, 100));
    let mut four = council();
    four.push("council4.testnet".parse().unwrap());
    Nema::new(
        four,
        2,
        0,
        DORMANT_SECS,
        "o.testnet".parse().unwrap(),
        "p".into(),
        "s.testnet".parse().unwrap(),
        "d".into(),
        4,
        U128(PRICE),
        0,
        vec![],
        vec![],
    );
}

#[test]
#[should_panic(expected = "only a council member")]
fn only_the_council_proposes() {
    let mut c = fresh();
    testing_env!(ctx(&accounts(1), 0, 100));
    c.propose(ProposalKind::SetReadPrice(U128(1)));
}

#[test]
#[should_panic(expected = "only a council member")]
fn only_the_council_votes() {
    let mut c = fresh();
    let id = c.propose(ProposalKind::SetReadPrice(U128(1)));
    testing_env!(ctx(&accounts(1), 0, 100));
    c.vote(id);
}

#[test]
fn one_council_member_cannot_change_the_price_alone() {
    let mut c = fresh();
    c.propose(ProposalKind::SetReadPrice(U128(5)));
    assert_eq!(c.read_price, PRICE, "one vote of two is not enough");
    assert_eq!(c.get_proposals().len(), 1);
}

#[test]
fn the_threshold_runs_the_proposal_and_clears_it() {
    let mut c = fresh();
    let id = c.propose(ProposalKind::SetReadPrice(U128(5)));
    as_member(&mut c, &council2(), 101, |c| c.vote(id));
    assert_eq!(c.read_price, 5);
    assert!(c.get_proposals().is_empty());
}

#[test]
#[should_panic(expected = "you already voted")]
fn a_member_cannot_vote_twice() {
    let mut c = fresh();
    let id = c.propose(ProposalKind::SetReadPrice(U128(5)));
    c.vote(id);
}

#[test]
#[should_panic(expected = "this proposal has lapsed")]
fn a_proposal_lapses_after_a_week() {
    let mut c = fresh();
    let id = c.propose(ProposalKind::SetReadPrice(U128(5)));
    as_member(&mut c, &council2(), 100 + 7 * 24 * 3600 + 1, |c| c.vote(id));
}

#[test]
fn a_proposal_still_counts_on_the_last_day() {
    let mut c = fresh();
    let id = c.propose(ProposalKind::SetReadPrice(U128(5)));
    as_member(&mut c, &council2(), 100 + 7 * 24 * 3600, |c| c.vote(id));
    assert_eq!(c.read_price, 5);
}

#[test]
fn the_council_removes_a_fund_by_vote() {
    let mut c = with_open_round();
    let id = c.propose(ProposalKind::RemoveMember(funds()[0].clone()));
    assert!(c.get_members().contains(&funds()[0]));
    as_member(&mut c, &council2(), 150, |c| c.vote(id));
    assert!(!c.get_members().contains(&funds()[0]));
}

#[test]
#[should_panic(expected = "not a panel member")]
fn removing_a_stranger_fails_when_proposed() {
    let mut c = fresh();
    c.propose(ProposalKind::RemoveMember(
        "stranger.testnet".parse().unwrap(),
    ));
}

#[test]
fn the_council_seats_and_unseats_members_by_vote() {
    let mut c = fresh();
    let newcomer: AccountId = "council4.testnet".parse().unwrap();
    let id = c.propose(ProposalKind::AddCouncil(newcomer.clone()));
    as_member(&mut c, &council2(), 101, |c| c.vote(id));
    assert_eq!(c.get_council().len(), 4);
    assert!(c.get_council().contains(&newcomer));

    // Four seats need three votes; the new member's vote counts, and the old seat can go.
    let id = c.propose(ProposalKind::RemoveCouncil(council3()));
    as_member(&mut c, &newcomer, 102, |c| c.vote(id));
    assert_eq!(c.get_council().len(), 4, "two of four is not a majority");
    as_member(&mut c, &owner(), 103, |c| c.vote(id));
    assert_eq!(c.get_council().len(), 3);
    assert!(!c.get_council().contains(&council3()));
}

#[test]
#[should_panic(expected = "fall below its threshold or 3 members")]
fn the_council_cannot_shrink_below_three() {
    let mut c = fresh();
    c.propose(ProposalKind::RemoveCouncil(council3()));
}

#[test]
#[should_panic(expected = "already on the council")]
fn a_council_member_cannot_be_seated_twice() {
    let mut c = fresh();
    c.propose(ProposalKind::AddCouncil(council2()));
}

#[test]
fn a_removed_council_members_old_vote_no_longer_counts() {
    let mut c = fresh();
    // council3 proposes a price change, then is voted off the council.
    testing_env!(ctx(&council3(), 0, 100));
    let price = c.propose(ProposalKind::SetReadPrice(U128(9)));
    let extra: AccountId = "council4.testnet".parse().unwrap();
    testing_env!(ctx(&owner(), 0, 101));
    let add = c.propose(ProposalKind::AddCouncil(extra.clone()));
    as_member(&mut c, &council2(), 102, |c| c.vote(add));
    testing_env!(ctx(&owner(), 0, 103));
    let leave = c.propose(ProposalKind::RemoveCouncil(council3()));
    as_member(&mut c, &council2(), 104, |c| c.vote(leave));
    as_member(&mut c, &extra, 104, |c| c.vote(leave)); // four seats: three votes
    assert!(!c.get_council().contains(&council3()));
    // Three votes on paper (the threshold is now three), but one is from a removed member.
    as_member(&mut c, &council2(), 105, |c| c.vote(price));
    as_member(&mut c, &extra, 106, |c| c.vote(price));
    assert_eq!(
        c.read_price, PRICE,
        "a departed member's vote is not counted"
    );
    as_member(&mut c, &owner(), 107, |c| c.vote(price));
    assert_eq!(c.read_price, 9);
}

// ---- v2: admission with a veto window ----

fn delayed() -> Nema {
    testing_env!(ctx(&owner(), 0, 100));
    build(2, 3600, 4)
}

#[test]
#[should_panic(expected = "not approved by enough council members yet")]
fn one_approval_does_not_admit() {
    let mut c = fresh();
    apply_now(&mut c);
    as_member(&mut c, &owner(), 130, |c| c.approve(applicant()));
    testing_env!(ctx(&accounts(4), 0, 131));
    let _ = c.finalize_admission(applicant());
}

#[test]
#[should_panic(expected = "you already approved this application")]
fn a_council_member_approves_once() {
    let mut c = fresh();
    apply_now(&mut c);
    as_member(&mut c, &owner(), 130, |c| c.approve(applicant()));
    as_member(&mut c, &owner(), 131, |c| c.approve(applicant()));
}

#[test]
#[should_panic(expected = "the veto window is still open")]
fn the_window_must_pass_before_admission() {
    let mut c = delayed();
    apply_now(&mut c);
    as_member(&mut c, &owner(), 130, |c| c.approve(applicant()));
    as_member(&mut c, &council2(), 131, |c| c.approve(applicant()));
    testing_env!(ctx(&accounts(4), 0, 131 + 3599));
    let _ = c.finalize_admission(applicant());
}

#[test]
fn anyone_admits_once_the_window_has_passed() {
    let mut c = delayed();
    apply_now(&mut c);
    as_member(&mut c, &owner(), 130, |c| c.approve(applicant()));
    as_member(&mut c, &council2(), 131, |c| c.approve(applicant()));
    testing_env!(ctx(&accounts(4), 0, 131 + 3600));
    let _ = c.finalize_admission(applicant());
    assert!(c.get_members().contains(&applicant()));
    assert_eq!(refunded_to(&applicant()), BOND);
}

#[test]
#[should_panic(expected = "no such application")]
fn a_veto_inside_the_window_stops_the_admission() {
    let mut c = delayed();
    apply_now(&mut c);
    as_member(&mut c, &owner(), 130, |c| c.approve(applicant()));
    as_member(&mut c, &council2(), 131, |c| c.approve(applicant()));
    // The third member, who did not approve, rejects it before the window ends.
    testing_env!(ctx(&council3(), 0, 200));
    let _ = c.reject(applicant());
    assert_eq!(refunded_to(&applicant()), BOND, "a vetoed bond comes back");
    testing_env!(ctx(&accounts(4), 0, 131 + 3600));
    let _ = c.finalize_admission(applicant());
}

#[test]
#[should_panic(expected = "only a council member")]
fn only_the_council_rejects() {
    let mut c = fresh();
    apply_now(&mut c);
    testing_env!(ctx(&applicant(), 0, 130));
    let _ = c.reject(applicant());
}

// ---- v2: any fund opens a round, on a registered loan ----

#[test]
fn a_panel_fund_opens_a_round_on_a_registered_loan() {
    let mut c = fresh();
    c.members.insert(funds()[0].clone());
    testing_env!(ctx(&funds()[0], DEPOSIT, 100));
    let _ = c.open_round(U64(2), U64(1000 * NS));
    let r = c.get_round(U64(1)).unwrap();
    assert_eq!((r.loan.as_str(), r.loan_id.0), ("Loan B", 2));
    assert_eq!(r.opened_by, funds()[0]);
}

#[test]
fn a_council_member_can_open_a_round_too() {
    let mut c = fresh();
    testing_env!(ctx(&council2(), DEPOSIT, 100));
    let _ = c.open_round(U64(1), U64(1000 * NS));
    assert_eq!(c.get_round(U64(1)).unwrap().opened_by, council2());
}

#[test]
#[should_panic(expected = "only panel funds and the council")]
fn a_stranger_cannot_open_a_round() {
    let mut c = fresh();
    testing_env!(ctx(&"stranger.testnet".parse().unwrap(), DEPOSIT, 100));
    let _ = c.open_round(U64(1), U64(1000 * NS));
}

#[test]
#[should_panic(expected = "only panel funds and the council")]
fn an_applicant_cannot_open_a_round() {
    let mut c = fresh();
    apply_now(&mut c);
    testing_env!(ctx(&applicant(), DEPOSIT, 130));
    let _ = c.open_round(U64(1), U64(1000 * NS));
}

#[test]
#[should_panic(expected = "no such loan")]
fn a_round_needs_a_registered_loan() {
    let mut c = fresh();
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round(U64(99), U64(1000 * NS));
}

#[test]
#[should_panic(expected = "a round on this loan is already running")]
fn one_round_at_a_time_per_loan() {
    let mut c = with_open_round();
    testing_env!(ctx(&owner(), DEPOSIT, 150));
    let _ = c.open_round(U64(1), U64(2000 * NS));
}

#[test]
fn two_loans_can_run_rounds_at_once() {
    let mut c = with_open_round();
    testing_env!(ctx(&owner(), DEPOSIT, 150));
    let _ = c.open_round(U64(2), U64(2000 * NS));
    assert_eq!(c.get_rounds(None, None).len(), 2);
}

#[test]
fn a_loan_can_be_re_run_once_its_round_has_ended() {
    let mut c = published();
    testing_env!(ctx(&owner(), DEPOSIT, 2000));
    let _ = c.open_round(U64(1), U64(3000 * NS));
    assert_eq!(c.get_rounds(None, None).len(), 2);
}

#[test]
fn a_failed_round_frees_its_loan() {
    let mut c = fresh();
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round(U64(1), U64(1000 * NS));
    c.apply_round_key(1, Err("enclave down".into()));
    assert_eq!(status(&c), RoundStatus::Failed);
    testing_env!(ctx(&owner(), DEPOSIT, 150));
    let _ = c.open_round(U64(1), U64(2000 * NS));
}

#[test]
fn the_registry_grows_by_vote() {
    let mut c = fresh();
    assert_eq!(c.get_loans().len(), 2);
    let id = c.propose(ProposalKind::RegisterLoan("Loan C".into()));
    as_member(&mut c, &council2(), 101, |c| c.vote(id));
    let loans = c.get_loans();
    assert_eq!(loans.len(), 3);
    assert_eq!((loans[2].id.0, loans[2].label.as_str()), (3, "Loan C"));
}

#[test]
#[should_panic(expected = "loan label must be 1 to 120 characters")]
fn an_empty_loan_label_is_refused() {
    let mut c = fresh();
    c.propose(ProposalKind::RegisterLoan(String::new()));
}

#[test]
fn founding_funds_are_on_the_panel_from_the_start() {
    testing_env!(ctx(&owner(), 0, 100));
    let c = Nema::new(
        council(),
        2,
        0,
        DORMANT_SECS,
        "o.testnet".parse().unwrap(),
        "p".into(),
        "s.testnet".parse().unwrap(),
        "d".into(),
        4,
        U128(PRICE),
        0,
        funds(),
        vec!["Loan A".into()],
    );
    assert_eq!(c.get_members().len(), 5);
}

#[test]
fn a_failed_round_key_leaves_an_event() {
    let mut c = fresh();
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round(U64(1), U64(1000 * NS));
    c.apply_round_key(1, Err("enclave down".into()));
    assert!(near_sdk::test_utils::get_logs()
        .iter()
        .any(|l| l.contains("round_key_failed")));
}

// ---- v2: no round below the panel minimum ----

#[test]
#[should_panic(expected = "too few funds on the panel")]
fn a_round_cannot_open_on_a_panel_below_the_minimum() {
    near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
    testing_env!(ctx(&owner(), 0, 100));
    let mut c = build(2, 0, 4);
    for f in funds().into_iter().take(3) {
        c.members.insert(f);
    }
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round(U64(1), U64(1000 * NS));
}

#[test]
fn a_panel_at_the_minimum_can_open_a_round() {
    near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
    testing_env!(ctx(&owner(), 0, 100));
    let mut c = build(2, 0, 4);
    for f in funds().into_iter().take(4) {
        c.members.insert(f);
    }
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round(U64(1), U64(1000 * NS));
    assert_eq!(c.get_rounds(None, None).len(), 1);
}

// ---- v2: the council is paid for keeping the panel running ----

/// What the council earns from one paid read, with the share set to `bps`.
fn council_earned(c: &Nema) -> Vec<u128> {
    council()
        .iter()
        .map(|a| c.get_earnings(a.clone()).0)
        .collect()
}

#[test]
#[should_panic(expected = "at most 20%")]
fn the_council_share_is_capped() {
    testing_env!(ctx(&owner(), 0, 100));
    Nema::new(
        council(),
        2,
        0,
        DORMANT_SECS,
        "o.testnet".parse().unwrap(),
        "p".into(),
        "s.testnet".parse().unwrap(),
        "d".into(),
        4,
        U128(PRICE),
        2_001,
        vec![],
        vec![],
    );
}

#[test]
fn a_paid_read_pays_the_council_its_share_and_the_funds_the_rest() {
    let mut c = published();
    c.council_share_bps = 1_000; // 10%
    let id = buy(&mut c);
    let h = set_hash(&c);
    c.apply_delivery(id, Ok(good_delivery(&h)));

    let cut = PRICE * 1_000 / 10_000;
    let per_seat = cut / 3;
    let pool = PRICE - per_seat * 3;
    let per_fund = pool / 5;
    let dust = pool - per_fund * 5;
    for f in funds() {
        assert_eq!(c.get_earnings(f).0, per_fund, "each contributing fund");
    }
    let seats = council_earned(&c);
    assert_eq!(seats[1], per_seat);
    assert_eq!(seats[2], per_seat);
    assert_eq!(
        seats[0],
        per_seat + dust,
        "the first seat also holds the dust"
    );
    let everything: u128 = funds()
        .iter()
        .map(|f| c.get_earnings(f.clone()).0)
        .sum::<u128>()
        + seats.iter().sum::<u128>();
    assert_eq!(everything, PRICE, "nothing lost or made");
}

#[test]
fn with_no_share_the_funds_split_the_whole_read() {
    let mut c = published();
    let id = buy(&mut c);
    let h = set_hash(&c);
    c.apply_delivery(id, Ok(good_delivery(&h)));
    for f in funds() {
        assert_eq!(c.get_earnings(f).0, PRICE / 5);
    }
    assert_eq!(council_earned(&c)[1], 0);
}

#[test]
fn a_free_read_pays_the_council_nothing() {
    let mut c = published();
    c.council_share_bps = 2_000;
    testing_env!(ctx(
        &funds()[0],
        READ - MIN_OUTLAYER_DEPOSIT + MIN_OUTLAYER_DEPOSIT,
        1100
    ));
    let _ = c.claim_read(1, pubkey());
    let id = c.get_purchases_of(funds()[0].clone()).last().unwrap().id.0;
    let h = set_hash(&c);
    c.apply_delivery(id, Ok(good_delivery(&h)));
    assert_eq!(council_earned(&c), vec![0, 0, 0]);
}

#[test]
fn the_council_share_never_loses_or_creates_a_yocto() {
    for bps in [0u32, 1, 333, 1_000, 2_000] {
        for n in 4..=9usize {
            let contributors: Vec<AccountId> = (0..n)
                .map(|i| format!("f{i}.testnet").parse().unwrap())
                .collect();
            for price in [
                1u128,
                7,
                99,
                10_000,
                PRICE,
                PRICE * 7 + 11,
                u64::MAX as u128,
                u128::MAX / 20_000,
            ] {
                let mut c = fresh();
                c.council_share_bps = bps;
                c.credit_contributors(&contributors, price);
                let to_funds: u128 = contributors
                    .iter()
                    .map(|a| c.get_earnings(a.clone()).0)
                    .sum();
                let to_council: u128 = council_earned(&c).iter().sum();
                assert_eq!(
                    to_funds + to_council,
                    price,
                    "bps={bps} n={n} price={price}"
                );
                // The council gets its share plus at most the dust of the split.
                let cut = price / 10_000 * bps as u128 + (price % 10_000) * bps as u128 / 10_000;
                assert!(
                    to_council <= cut + n as u128,
                    "bps={bps} n={n} price={price}"
                );
            }
        }
    }
}

// ---- v2: when the council goes quiet ----

fn new_council() -> Vec<AccountId> {
    ["n1.testnet", "n2.testnet", "n3.testnet"]
        .iter()
        .map(|a| a.parse().unwrap())
        .collect()
}

/// The first second at which a council created at t=100s counts as silent.
const QUIET: u64 = 100 + DORMANT_SECS;
const FORTNIGHT: u64 = 14 * 24 * 3600;

fn start_takeover(c: &mut Nema, who: &AccountId, secs: u64) {
    testing_env!(ctx(who, 0, secs));
    c.propose_council_takeover(new_council(), 2);
}

fn takeover_vote(c: &mut Nema, who: &AccountId, secs: u64) {
    testing_env!(ctx(who, 0, secs));
    c.vote_council_takeover();
}

#[test]
#[should_panic(expected = "the council has made a decision recently")]
fn a_takeover_needs_a_silent_council() {
    let mut c = fresh();
    start_takeover(&mut c, &funds()[0], QUIET - 1);
}

#[test]
fn a_takeover_can_start_once_the_council_has_been_silent_long_enough() {
    let mut c = fresh();
    start_takeover(&mut c, &funds()[0], QUIET);
    let t = c.get_takeover().expect("a vote is running");
    assert_eq!((t.votes.len(), t.council), (1, new_council()));
}

#[test]
#[should_panic(expected = "only a panel fund can do this")]
fn only_a_panel_fund_can_propose_a_takeover() {
    let mut c = fresh();
    start_takeover(&mut c, &council2(), QUIET);
}

#[test]
#[should_panic(expected = "only a panel fund can do this")]
fn only_a_panel_fund_can_vote_on_a_takeover() {
    let mut c = fresh();
    start_takeover(&mut c, &funds()[0], QUIET);
    takeover_vote(&mut c, &"stranger.testnet".parse().unwrap(), QUIET + 1);
}

#[test]
fn two_thirds_of_the_panel_replace_the_council() {
    let mut c = fresh(); // four funds: three votes are two thirds
    start_takeover(&mut c, &funds()[0], QUIET);
    takeover_vote(&mut c, &funds()[1], QUIET + 1);
    assert_eq!(c.get_council(), council(), "two of four is not enough");
    takeover_vote(&mut c, &funds()[2], QUIET + 2);
    assert_eq!(c.get_council(), new_council());
    assert!(c.get_takeover().is_none());
}

#[test]
#[should_panic(expected = "only a council member")]
fn the_replaced_council_loses_its_powers() {
    let mut c = fresh();
    start_takeover(&mut c, &funds()[0], QUIET);
    takeover_vote(&mut c, &funds()[1], QUIET + 1);
    takeover_vote(&mut c, &funds()[2], QUIET + 2);
    testing_env!(ctx(&owner(), 0, QUIET + 3));
    c.propose(ProposalKind::SetReadPrice(U128(1)));
}

#[test]
fn the_new_council_can_act() {
    let mut c = fresh();
    start_takeover(&mut c, &funds()[0], QUIET);
    takeover_vote(&mut c, &funds()[1], QUIET + 1);
    takeover_vote(&mut c, &funds()[2], QUIET + 2);
    let n = new_council();
    as_member(&mut c, &n[0], QUIET + 3, |c| {
        c.propose(ProposalKind::SetReadPrice(U128(7)));
    });
    as_member(&mut c, &n[1], QUIET + 4, |c| c.vote(U64(1)));
    assert_eq!(c.read_price, 7);
}

#[test]
#[should_panic(expected = "you already voted")]
fn a_fund_votes_on_a_takeover_once() {
    let mut c = fresh();
    start_takeover(&mut c, &funds()[0], QUIET);
    takeover_vote(&mut c, &funds()[0], QUIET + 1);
}

#[test]
#[should_panic(expected = "no vote to replace the council is running")]
fn the_council_deciding_kills_a_takeover() {
    let mut c = fresh();
    start_takeover(&mut c, &funds()[0], QUIET);
    // The council wakes up and decides something before the panel finishes.
    as_member(&mut c, &owner(), QUIET + 5, |c| {
        c.propose(ProposalKind::Heartbeat);
    });
    as_member(&mut c, &council2(), QUIET + 6, |c| c.vote(U64(1)));
    assert!(c.get_takeover().is_none());
    takeover_vote(&mut c, &funds()[1], QUIET + 7);
}

#[test]
#[should_panic(expected = "the council has made a decision recently")]
fn a_heartbeat_restarts_the_clock() {
    let mut c = fresh();
    as_member(&mut c, &owner(), QUIET - 10, |c| {
        c.propose(ProposalKind::Heartbeat);
    });
    as_member(&mut c, &council2(), QUIET - 9, |c| c.vote(U64(1)));
    assert_eq!(c.read_price, PRICE, "a heartbeat changes nothing else");
    start_takeover(&mut c, &funds()[0], QUIET);
}

#[test]
fn one_member_acting_alone_does_not_count_as_a_decision() {
    // A lone proposal that never reaches the threshold must not reset the clock, or
    // one absent-minded seat could keep a dead council alive forever.
    let mut c = fresh();
    as_member(&mut c, &owner(), QUIET - 10, |c| {
        c.propose(ProposalKind::SetReadPrice(U128(1)));
    });
    assert_eq!(c.read_price, PRICE);
    start_takeover(&mut c, &funds()[0], QUIET);
    assert!(
        c.get_takeover().is_some(),
        "the lone proposal did not stop the takeover"
    );
}

#[test]
#[should_panic(expected = "the council has made a decision recently")]
fn an_admission_reaching_its_threshold_counts_as_a_decision() {
    let mut c = fresh();
    apply_now(&mut c);
    as_member(&mut c, &owner(), QUIET - 50, |c| c.approve(applicant()));
    as_member(&mut c, &council2(), QUIET - 49, |c| c.approve(applicant()));
    start_takeover(&mut c, &funds()[0], QUIET);
}

#[test]
#[should_panic(expected = "no vote to replace the council is running")]
fn a_takeover_lapses_after_two_weeks() {
    let mut c = fresh();
    start_takeover(&mut c, &funds()[0], QUIET);
    takeover_vote(&mut c, &funds()[1], QUIET + FORTNIGHT + 1);
}

#[test]
fn a_takeover_still_counts_on_its_last_day() {
    let mut c = fresh();
    start_takeover(&mut c, &funds()[0], QUIET);
    takeover_vote(&mut c, &funds()[1], QUIET + FORTNIGHT);
    assert_eq!(c.get_takeover().unwrap().votes.len(), 2);
}

#[test]
fn a_lapsed_takeover_can_be_started_again() {
    let mut c = fresh();
    start_takeover(&mut c, &funds()[0], QUIET);
    start_takeover(&mut c, &funds()[1], QUIET + FORTNIGHT + 1);
    assert_eq!(c.get_takeover().unwrap().proposer, funds()[1]);
}

#[test]
#[should_panic(expected = "a vote to replace the council is already running")]
fn only_one_takeover_runs_at_a_time() {
    let mut c = fresh();
    start_takeover(&mut c, &funds()[0], QUIET);
    start_takeover(&mut c, &funds()[1], QUIET + 1);
}

#[test]
#[should_panic(expected = "the council has made a decision recently")]
fn a_new_council_is_not_replaceable_at_once() {
    let mut c = fresh();
    start_takeover(&mut c, &funds()[0], QUIET);
    takeover_vote(&mut c, &funds()[1], QUIET + 1);
    takeover_vote(&mut c, &funds()[2], QUIET + 2);
    start_takeover(&mut c, &funds()[0], QUIET + 3);
}

#[test]
#[should_panic(expected = "3 to 7 different accounts")]
fn a_replacement_council_needs_three_members() {
    let mut c = fresh();
    testing_env!(ctx(&funds()[0], 0, QUIET));
    c.propose_council_takeover(new_council()[..2].to_vec(), 2);
}

#[test]
#[should_panic(expected = "majority of the council")]
fn a_replacement_council_needs_a_majority_threshold() {
    let mut c = fresh();
    testing_env!(ctx(&funds()[0], 0, QUIET));
    c.propose_council_takeover(new_council(), 1);
}

#[test]
fn a_removed_funds_vote_does_not_count() {
    let mut c = fresh(); // four funds: three live votes needed
    c.takeover = Some(Takeover {
        council: new_council(),
        threshold: 2,
        proposer: funds()[0].clone(),
        // Three votes, but one is from an account that is not on the panel.
        votes: vec![
            funds()[0].clone(),
            funds()[1].clone(),
            "gone.testnet".parse().unwrap(),
        ],
        created_at: U64(QUIET * NS),
    });
    c.run_takeover_if_passed();
    assert_eq!(
        c.get_council(),
        council(),
        "a departed fund vote is not counted"
    );
}

#[test]
#[should_panic(expected = "at least a day of silence")]
fn a_council_must_be_allowed_a_day_of_silence() {
    testing_env!(ctx(&owner(), 0, 100));
    Nema::new(
        council(),
        2,
        0,
        24 * 3600 - 1,
        "o.testnet".parse().unwrap(),
        "p".into(),
        "s.testnet".parse().unwrap(),
        "d".into(),
        4,
        U128(PRICE),
        0,
        vec![],
        vec![],
    );
}

// ---- v2: the threshold stays a majority ----

fn seat_a_fourth(c: &mut Nema) -> AccountId {
    let newcomer: AccountId = "council4.testnet".parse().unwrap();
    let id = c.propose(ProposalKind::AddCouncil(newcomer.clone()));
    as_member(c, &council2(), 101, |c| c.vote(id));
    newcomer
}

#[test]
fn adding_a_seat_keeps_the_threshold_a_majority() {
    let mut c = fresh();
    seat_a_fourth(&mut c);
    assert_eq!((c.get_council().len(), c.threshold), (4, 3));
    // Two of four can no longer decide.
    testing_env!(ctx(&owner(), 0, 102));
    let id = c.propose(ProposalKind::SetReadPrice(U128(9)));
    as_member(&mut c, &council2(), 102, |c| c.vote(id));
    assert_eq!(c.read_price, PRICE);
}

#[test]
fn the_council_can_raise_its_threshold_by_vote() {
    let mut c = fresh();
    let id = c.propose(ProposalKind::SetThreshold(3));
    as_member(&mut c, &council2(), 101, |c| c.vote(id));
    assert_eq!(c.threshold, 3);
}

#[test]
#[should_panic(expected = "majority of the council")]
fn a_threshold_below_a_majority_cannot_be_voted_in() {
    let mut c = fresh();
    seat_a_fourth(&mut c);
    testing_env!(ctx(&owner(), 0, 102));
    c.propose(ProposalKind::SetThreshold(2));
}

#[test]
fn a_shrunk_council_can_lower_its_threshold_back() {
    // Four seats at three votes, one leaves: three of three until the council
    // votes the threshold back to two.
    let mut c = fresh();
    let newcomer = seat_a_fourth(&mut c);
    testing_env!(ctx(&owner(), 0, 102));
    let id = c.propose(ProposalKind::RemoveCouncil(council3()));
    as_member(&mut c, &council2(), 102, |c| c.vote(id));
    as_member(&mut c, &newcomer, 103, |c| c.vote(id));
    assert_eq!((c.get_council().len(), c.threshold), (3, 3));
    testing_env!(ctx(&owner(), 0, 104));
    let id = c.propose(ProposalKind::SetThreshold(2));
    as_member(&mut c, &council2(), 104, |c| c.vote(id));
    as_member(&mut c, &newcomer, 105, |c| c.vote(id));
    assert_eq!(c.threshold, 2);
}

#[test]
fn an_approval_from_a_departed_council_member_does_not_count() {
    let mut c = fresh();
    apply_now(&mut c);
    as_member(&mut c, &council3(), 125, |c| c.approve(applicant()));
    // council3 leaves; its approval stays on the application but must not count.
    c.council = vec![owner(), council2(), "council4.testnet".parse().unwrap()];
    as_member(&mut c, &owner(), 126, |c| c.approve(applicant()));
    assert!(
        c.get_applications()[0].ready_at.is_none(),
        "one live approval of two"
    );
    as_member(&mut c, &council2(), 127, |c| c.approve(applicant()));
    assert!(c.get_applications()[0].ready_at.is_some());
}

// ---- v2: lapsed proposals ----

const WEEK: u64 = 7 * 24 * 3600;

#[test]
fn a_lapsed_proposal_is_not_listed() {
    let mut c = fresh();
    c.propose(ProposalKind::SetReadPrice(U128(5)));
    testing_env!(ctx(&owner(), 0, 100 + WEEK + 1));
    assert!(c.get_proposals().is_empty());
}

#[test]
fn a_lapsed_proposal_is_cleared_from_storage_by_the_next_one() {
    let mut c = fresh();
    c.propose(ProposalKind::SetReadPrice(U128(5)));
    as_member(&mut c, &owner(), 100 + WEEK + 1, |c| {
        c.propose(ProposalKind::SetReadPrice(U128(6)));
    });
    assert_eq!(c.proposals.len(), 1);
}

#[test]
fn a_live_proposal_is_kept_when_another_is_made() {
    let mut c = fresh();
    c.propose(ProposalKind::SetReadPrice(U128(5)));
    as_member(&mut c, &owner(), 100 + WEEK, |c| {
        c.propose(ProposalKind::SetReadPrice(U128(6)));
    });
    assert_eq!(c.get_proposals().len(), 2);
}

// ---- v2: taking loans off the registry ----

#[test]
fn the_council_removes_a_loan_by_vote() {
    let mut c = fresh();
    let id = c.propose(ProposalKind::RemoveLoan(U64(1)));
    as_member(&mut c, &council2(), 101, |c| c.vote(id));
    let loans = c.get_loans();
    assert_eq!((loans.len(), loans[0].id.0), (1, 2));
}

#[test]
#[should_panic(expected = "no such loan")]
fn a_removed_loan_cannot_get_a_round() {
    let mut c = fresh();
    let id = c.propose(ProposalKind::RemoveLoan(U64(1)));
    as_member(&mut c, &council2(), 101, |c| c.vote(id));
    testing_env!(ctx(&owner(), DEPOSIT, 102));
    let _ = c.open_round(U64(1), U64(1000 * NS));
}

#[test]
#[should_panic(expected = "a round on this loan is still running")]
fn a_loan_with_a_running_round_cannot_be_removed() {
    let mut c = with_open_round();
    testing_env!(ctx(&owner(), 0, 150));
    c.propose(ProposalKind::RemoveLoan(U64(1)));
}

#[test]
fn a_past_round_keeps_its_label_after_the_loan_is_removed() {
    let mut c = published();
    testing_env!(ctx(&owner(), 0, 2000));
    let id = c.propose(ProposalKind::RemoveLoan(U64(1)));
    as_member(&mut c, &council2(), 2001, |c| c.vote(id));
    assert_eq!(c.get_round(U64(1)).unwrap().loan, "Loan A");
}

fn full_registry() -> Nema {
    near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
    testing_env!(ctx(&owner(), 0, 100));
    Nema::new(
        council(),
        2,
        0,
        DORMANT_SECS,
        "o.testnet".parse().unwrap(),
        "p".into(),
        "s.testnet".parse().unwrap(),
        "d".into(),
        4,
        U128(PRICE),
        0,
        vec![],
        (1..=64).map(|i| format!("Loan {i}")).collect(),
    )
}

#[test]
#[should_panic(expected = "the loan registry is full")]
fn a_full_registry_refuses_a_new_loan() {
    let mut c = full_registry();
    c.propose(ProposalKind::RegisterLoan("Loan 65".into()));
}

#[test]
fn removing_a_loan_makes_room_in_a_full_registry() {
    let mut c = full_registry();
    let id = c.propose(ProposalKind::RemoveLoan(U64(1)));
    as_member(&mut c, &council2(), 101, |c| c.vote(id));
    testing_env!(ctx(&owner(), 0, 102));
    let id = c.propose(ProposalKind::RegisterLoan("Loan 65".into()));
    as_member(&mut c, &council2(), 102, |c| c.vote(id));
    let loans = c.get_loans();
    assert_eq!(loans.len(), 64);
    assert!(loans.iter().any(|l| l.id.0 == 65 && l.label == "Loan 65"));
}

#[test]
fn a_read_split_matches_the_sites_vector() {
    // The same numbers are checked against the site's `splitRead` in
    // web/scripts/check-crypto.ts, so the price breakdown shown matches what is paid.
    let mut c = fresh();
    c.council_share_bps = 500;
    let funds4: Vec<AccountId> = funds().into_iter().take(4).collect();
    c.credit_contributors(&funds4, 100_000_000_000_000_000_000_007);
    let earned = |a: &AccountId| c.earnings.get(a).copied().unwrap_or(0);
    assert_eq!(earned(&council2()), 1_666_666_666_666_666_666_666);
    assert_eq!(earned(&funds4[0]), 23_750_000_000_000_000_000_002);
    // The first seat also holds the one yocto that does not divide.
    assert_eq!(earned(&owner()), 1_666_666_666_666_666_666_667);
}

// ---- v2: fixes from the reliability audit ----

const MONTH: u64 = 30 * 24 * 3600;

#[test]
#[should_panic(expected = "a round can stay open at most 30 days")]
fn a_round_cannot_hold_its_loan_for_more_than_30_days() {
    let mut c = fresh();
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round(U64(1), U64((100 + MONTH + 1) * NS));
}

#[test]
fn a_round_can_run_for_exactly_30_days() {
    let mut c = fresh();
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round(U64(1), U64((100 + MONTH) * NS));
    assert_eq!(c.get_rounds(None, None).len(), 1);
}

#[test]
#[should_panic(expected = "a round on this loan is already running")]
fn an_old_running_round_still_holds_its_loan() {
    // However many rounds were opened since, the loan's own round still counts.
    let mut c = fresh();
    testing_env!(ctx(&owner(), DEPOSIT, 100));
    let _ = c.open_round(U64(1), U64(1000 * NS));
    c.next_round_id += 500;
    let _ = c.open_round(U64(1), U64(2000 * NS));
}

#[test]
#[should_panic(expected = "you have 4 proposals open")]
fn one_council_member_holds_at_most_four_open_proposals() {
    let mut c = fresh();
    for price in 1..=5 {
        c.propose(ProposalKind::SetReadPrice(U128(price)));
    }
}

#[test]
fn another_member_can_still_propose_when_one_is_at_the_limit() {
    let mut c = fresh();
    for price in 1..=4 {
        c.propose(ProposalKind::SetReadPrice(U128(price)));
    }
    as_member(&mut c, &council2(), 101, |c| {
        c.propose(ProposalKind::Heartbeat);
    });
    assert_eq!(c.read_price, PRICE);
}

#[test]
fn a_proposal_that_went_stale_fails_cleanly_on_its_last_vote() {
    // Two proposals for the same loan: the first registers it, so the second can no
    // longer run. Its last vote lands, the proposal is dropped and an event says why.
    let mut c = fresh();
    let first = c.propose(ProposalKind::RegisterLoan("Loan C".into()));
    let second = c.propose(ProposalKind::RegisterLoan("Loan C".into()));
    as_member(&mut c, &council2(), 101, |c| c.vote(first));
    as_member(&mut c, &council2(), 102, |c| c.vote(second));
    assert_eq!(c.get_loans().len(), 3);
    assert!(c.get_proposals().is_empty());
    assert!(near_sdk::test_utils::get_logs()
        .iter()
        .any(|l| l.contains("proposal_failed") && l.contains("already registered")));
}

#[test]
fn a_lapsed_proposal_leaves_an_event_when_cleared() {
    let mut c = fresh();
    c.propose(ProposalKind::SetReadPrice(U128(5)));
    as_member(&mut c, &owner(), 100 + WEEK + 1, |c| {
        c.propose(ProposalKind::Heartbeat);
    });
    assert!(near_sdk::test_utils::get_logs()
        .iter()
        .any(|l| l.contains("proposal_lapsed")));
}

#[test]
#[should_panic(expected = "this loan is already registered")]
fn the_same_loan_cannot_be_registered_twice() {
    let mut c = fresh();
    c.propose(ProposalKind::RegisterLoan("Loan A".into()));
}

#[test]
#[should_panic(expected = "too few funds on the panel to replace the council")]
fn a_takeover_needs_a_panel_at_the_minimum() {
    let mut c = fresh();
    c.members.remove(&funds()[3]);
    start_takeover(&mut c, &funds()[0], QUIET);
}

#[test]
fn a_takeover_does_not_pass_once_the_panel_falls_below_the_minimum() {
    let mut c = fresh();
    start_takeover(&mut c, &funds()[0], QUIET);
    takeover_vote(&mut c, &funds()[1], QUIET + 1);
    c.members.remove(&funds()[3]);
    takeover_vote(&mut c, &funds()[2], QUIET + 2);
    assert_eq!(
        c.get_council(),
        council(),
        "three funds can't speak for the panel"
    );
}

#[test]
fn a_new_council_starts_without_the_old_ones_proposals_or_approvals() {
    let mut c = fresh();
    apply_now(&mut c);
    as_member(&mut c, &owner(), QUIET - 20, |c| c.approve(applicant()));
    as_member(&mut c, &owner(), QUIET - 10, |c| {
        c.propose(ProposalKind::SetReadPrice(U128(1)));
    });
    start_takeover(&mut c, &funds()[0], QUIET);
    takeover_vote(&mut c, &funds()[1], QUIET + 1);
    takeover_vote(&mut c, &funds()[2], QUIET + 2);
    assert_eq!(c.get_council(), new_council());
    assert!(c.get_proposals().is_empty());
    let app = &c.get_applications()[0];
    assert!(app.approvals.is_empty() && app.ready_at.is_none());
}

#[test]
fn a_seat_that_leaves_takes_its_votes_and_approvals_with_it() {
    let mut c = fresh();
    let newcomer = seat_a_fourth(&mut c);
    apply_now(&mut c);
    as_member(&mut c, &council3(), 125, |c| c.approve(applicant()));
    testing_env!(ctx(&council3(), 0, 126));
    let price = c.propose(ProposalKind::SetReadPrice(U128(9)));
    testing_env!(ctx(&owner(), 0, 127));
    let leave = c.propose(ProposalKind::RemoveCouncil(council3()));
    as_member(&mut c, &council2(), 128, |c| c.vote(leave));
    as_member(&mut c, &newcomer, 129, |c| c.vote(leave));
    assert!(!c.get_council().contains(&council3()));
    assert!(c.proposals.get(&price.0).unwrap().votes.is_empty());
    assert!(c.get_applications()[0].approvals.is_empty());
}

#[test]
#[should_panic(expected = "this loan is already registered")]
fn the_founding_registry_cannot_list_a_loan_twice() {
    testing_env!(ctx(&owner(), 0, 100));
    Nema::new(
        council(),
        2,
        0,
        DORMANT_SECS,
        "o.testnet".parse().unwrap(),
        "p".into(),
        "s.testnet".parse().unwrap(),
        "d".into(),
        4,
        U128(PRICE),
        0,
        vec![],
        vec!["Loan A".into(), "Loan A".into()],
    );
}
