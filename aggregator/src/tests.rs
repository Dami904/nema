use super::*;
use ecies::{PublicKey, SecretKey};

const MASTER: crypto::Master = [42u8; 32];
const CONTRACT: &str = "nema-dev.testnet";

/// Encrypt a fund's mark the way the browser will.
fn encrypt_mark(round_id: u64, account: &str, mark: i64) -> String {
    let pk = crypto::round_pubkey_hex(&MASTER, CONTRACT, round_id).unwrap();
    let plain = json!({"account": account, "mark": mark}).to_string();
    crypto::seal_hex(&pk, plain.as_bytes()).unwrap()
}

fn sub(account: &str, ciphertext_hex: String) -> Sub {
    Sub { account: account.to_string(), ciphertext_hex }
}

fn five_funds() -> Vec<Sub> {
    [("a.testnet", 9175), ("b.testnet", 9500), ("c.testnet", 9300), ("d.testnet", 9650), ("e.testnet", 9425)]
        .iter()
        .map(|(a, m)| sub(a, encrypt_mark(1, a, *m)))
        .collect()
}

fn hash_of(subs: &[Sub]) -> String {
    crypto::set_hash(&subs.iter().map(|s| (s.account.clone(), s.ciphertext_hex.clone())).collect::<Vec<_>>())
}

fn tally_req(subs: Vec<Sub>, set_hash: String) -> Request {
    Request::Tally { contract: CONTRACT.into(), round_id: 1, min_contributors: 4, set_hash, submissions: subs }
}

fn deliver_req(subs: Vec<Sub>, set_hash: String, commitment: String, buyer_pubkey: String) -> Request {
    Request::Deliver {
        contract: CONTRACT.into(),
        round_id: 1,
        min_contributors: 4,
        set_hash,
        commitment,
        buyer_pubkey,
        submissions: subs,
    }
}

fn buyer() -> (SecretKey, String) {
    let sk = SecretKey::generate();
    let pk = hex::encode(PublicKey::from_secret_key(&sk).serialize_compressed());
    (sk, pk)
}

// ---- who may call ----

#[test]
fn derive_pubkey_returns_the_round_key() {
    let out = handle(Request::DerivePubkey { contract: CONTRACT.into(), round_id: 3 }, &MASTER, CONTRACT);
    assert_eq!(out["ok"], true);
    assert_eq!(out["pubkey"], crypto::round_pubkey_hex(&MASTER, CONTRACT, 3).unwrap());
}

#[test]
fn another_caller_is_refused_for_every_action() {
    let subs = five_funds();
    let h = hash_of(&subs);
    let (_, pk) = buyer();
    for req in [
        Request::DerivePubkey { contract: CONTRACT.into(), round_id: 1 },
        tally_req(subs.clone(), h.clone()),
        deliver_req(subs, h, "00".repeat(32), pk),
    ] {
        let out = handle(req, &MASTER, "attacker.testnet");
        assert_eq!(out["ok"], false);
        assert_eq!(out["error"], "only the round's contract may call this module");
    }
}

#[test]
fn an_empty_predecessor_is_refused() {
    let out = handle(Request::DerivePubkey { contract: CONTRACT.into(), round_id: 1 }, &MASTER, "");
    assert_eq!(out["ok"], false);
}

// ---- tally ----

#[test]
fn tally_publishes_count_and_commitment_but_not_the_result() {
    let subs = five_funds();
    let h = hash_of(&subs);
    let out = handle(tally_req(subs, h.clone()), &MASTER, CONTRACT);
    assert_eq!(out["ok"], true);
    assert_eq!(out["count"], 5);
    assert_eq!(out["set_hash"], h);
    let salt = crypto::result_salt(&MASTER, CONTRACT, 1);
    assert_eq!(out["commitment"], crypto::commitment(CONTRACT, 1, &salt, 5, "94.10", "1.6324"));
    let text = out.to_string();
    assert!(out.get("mean").is_none() && out.get("spread").is_none());
    assert!(!text.contains("94.10") && !text.contains("1.6324"));
}

#[test]
fn tally_refuses_a_set_other_than_the_committed_one() {
    let subs = five_funds();
    let h = hash_of(&subs);
    let out = handle(tally_req(subs[..4].to_vec(), h), &MASTER, CONTRACT);
    assert_eq!(out["ok"], false);
    assert_eq!(out["error"], "the submissions do not match the committed set");
}

#[test]
fn a_copied_ciphertext_is_rejected() {
    let mut subs = five_funds();
    // f.testnet resubmits a.testnet's ciphertext to double its weight.
    subs.push(sub("f.testnet", subs[0].ciphertext_hex.clone()));
    let h = hash_of(&subs);
    let out = handle(tally_req(subs, h), &MASTER, CONTRACT);
    assert_eq!(out["count"], 5);
    assert_eq!(out["rejected"], json!([{"account": "f.testnet", "reason": "encrypted for another account"}]));
}

#[test]
fn undecryptable_and_malformed_submissions_are_named_not_fatal() {
    let mut subs = five_funds();
    subs.push(sub("junk.testnet", "ab".repeat(120)));
    let pk = crypto::round_pubkey_hex(&MASTER, CONTRACT, 1).unwrap();
    subs.push(sub("words.testnet", crypto::seal_hex(&pk, b"ninety four").unwrap()));
    // Encrypted to round 2's key, so round 1's key cannot open it.
    subs.push(sub("late.testnet", encrypt_mark(2, "late.testnet", 9000)));
    let h = hash_of(&subs);
    let out = handle(tally_req(subs, h), &MASTER, CONTRACT);
    assert_eq!(out["ok"], true);
    assert_eq!(out["count"], 5);
    let reasons: Vec<(String, String)> = out["rejected"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["account"].as_str().unwrap().into(), r["reason"].as_str().unwrap().into()))
        .collect();
    assert!(reasons.contains(&("junk.testnet".into(), "cannot decrypt".into())));
    assert!(reasons.contains(&("words.testnet".into(), "malformed plaintext".into())));
    assert!(reasons.contains(&("late.testnet".into(), "cannot decrypt".into())));
}

#[test]
fn tally_below_the_minimum_publishes_nothing() {
    let mut subs = five_funds();
    subs.truncate(3);
    subs.push(sub("evil.testnet", encrypt_mark(1, "evil.testnet", 999_999)));
    let h = hash_of(&subs);
    let out = handle(tally_req(subs, h), &MASTER, CONTRACT);
    assert_eq!(out["ok"], false);
    assert!(out.get("commitment").is_none() && out.get("count").is_none());
    assert_eq!(out["rejected"][0]["reason"], "out of range");
}

// ---- deliver ----

fn published_commitment(subs: &[Sub]) -> String {
    let out = handle(tally_req(subs.to_vec(), hash_of(subs)), &MASTER, CONTRACT);
    out["commitment"].as_str().unwrap().to_string()
}

#[test]
fn only_the_buyer_can_open_the_delivery_and_it_matches_the_commitment() {
    let subs = five_funds();
    let h = hash_of(&subs);
    let c = published_commitment(&subs);
    let (sk, pk) = buyer();
    let out = handle(deliver_req(subs, h.clone(), c.clone(), pk), &MASTER, CONTRACT);
    assert_eq!(out["ok"], true);
    assert_eq!(out["set_hash"], h);
    assert_eq!(out["commitment"], c);
    assert!(!out.to_string().contains("94.10"));

    let sealed = out["sealed"].as_str().unwrap();
    let opened: Value = serde_json::from_slice(&crypto::decrypt_hex(&sk, sealed).unwrap()).unwrap();
    assert_eq!(opened["count"], 5);
    assert_eq!(opened["mean"], "94.10");
    assert_eq!(opened["spread"], "1.6324");

    // The buyer's own check: rebuild the commitment from what they received.
    let salt: [u8; 32] = hex::decode(opened["salt"].as_str().unwrap()).unwrap().try_into().unwrap();
    assert_eq!(crypto::commitment(CONTRACT, 1, &salt, 5, "94.10", "1.6324"), c);

    let (other, _) = buyer();
    assert!(crypto::decrypt_hex(&other, sealed).is_err());
}

#[test]
fn deliver_refuses_a_commitment_that_does_not_match() {
    let subs = five_funds();
    let h = hash_of(&subs);
    let (_, pk) = buyer();
    let out = handle(deliver_req(subs, h, "00".repeat(32), pk), &MASTER, CONTRACT);
    assert_eq!(out["ok"], false);
    assert_eq!(out["error"], "the result does not match the published commitment");
    assert!(out.get("sealed").is_none());
}

#[test]
fn deliver_refuses_a_different_set() {
    let subs = five_funds();
    let h = hash_of(&subs);
    let c = published_commitment(&subs);
    let (_, pk) = buyer();
    let out = handle(deliver_req(subs[1..].to_vec(), h, c, pk), &MASTER, CONTRACT);
    assert_eq!(out["error"], "the submissions do not match the committed set");
}

#[test]
fn deliver_refuses_a_bad_buyer_key() {
    let subs = five_funds();
    let h = hash_of(&subs);
    let c = published_commitment(&subs);
    let out = handle(deliver_req(subs, h, c, "02".to_string() + &"ff".repeat(32)), &MASTER, CONTRACT);
    assert_eq!(out["ok"], false);
    assert!(out.get("sealed").is_none());
}

#[test]
fn delivery_fits_outlayers_output_limit() {
    let subs = five_funds();
    let h = hash_of(&subs);
    let c = published_commitment(&subs);
    let (_, pk) = buyer();
    let out = handle(deliver_req(subs, h, c, pk), &MASTER, CONTRACT);
    assert!(out.to_string().len() < 900, "{} bytes", out.to_string().len());
}

// ---- interop with eciesjs (the browser library); steps in interop/interop.mjs ----

/// A fixed test-only buyer key, so the JavaScript side can open the delivery.
const INTEROP_BUYER_SK: [u8; 32] = [9u8; 32];

/// Writes the Rust side of the interop vectors. Run with NEMA_WRITE_VECTORS=1.
#[test]
fn interop_write_rust_side() {
    if std::env::var("NEMA_WRITE_VECTORS").is_err() {
        return;
    }
    let subs = five_funds();
    let h = hash_of(&subs);
    let c = published_commitment(&subs);
    let buyer_sk = SecretKey::parse_slice(&INTEROP_BUYER_SK).unwrap();
    let buyer_pk = hex::encode(PublicKey::from_secret_key(&buyer_sk).serialize_compressed());
    let out = handle(deliver_req(subs, h, c.clone(), buyer_pk), &MASTER, CONTRACT);
    let vectors = json!({
        "contract": CONTRACT,
        "round_id": 1,
        "round_pubkey": crypto::round_pubkey_hex(&MASTER, CONTRACT, 1).unwrap(),
        "buyer_sk_hex": hex::encode(INTEROP_BUYER_SK),
        "commitment": c,
        "sealed": out["sealed"],
    });
    std::fs::write("../testdata/interop/rust.json", serde_json::to_string_pretty(&vectors).unwrap()).unwrap();
}

/// Marks encrypted by eciesjs to the round key decrypt and tally here.
#[test]
fn eciesjs_ciphertexts_tally() {
    let js: Value = serde_json::from_str(include_str!("../../testdata/interop/js.json")).unwrap();
    let subs: Vec<Sub> = js["submissions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| sub(s["account"].as_str().unwrap(), s["ciphertext_hex"].as_str().unwrap().to_string()))
        .collect();
    let h = hash_of(&subs);
    assert_eq!(js["set_hash"], h, "the browser and the enclave disagree on the set hash");
    let out = handle(tally_req(subs, h), &MASTER, CONTRACT);
    assert_eq!(out["ok"], true, "{out}");
    assert_eq!(out["count"], 5);
    let salt = crypto::result_salt(&MASTER, CONTRACT, 1);
    assert_eq!(out["commitment"], crypto::commitment(CONTRACT, 1, &salt, 5, "94.10", "1.6324"));
}

// ---- input parsing ----

#[test]
fn requests_parse_from_the_contracts_json() {
    let raw = json!({
        "action": "tally", "contract": CONTRACT, "round_id": 1, "min_contributors": 4,
        "set_hash": "x", "submissions": [{"account": "a.testnet", "ciphertext_hex": "ab"}],
    })
    .to_string();
    assert!(matches!(serde_json::from_str::<Request>(&raw).unwrap(), Request::Tally { .. }));
    let raw = json!({"action": "derive_pubkey", "contract": CONTRACT, "round_id": 1}).to_string();
    assert!(matches!(serde_json::from_str::<Request>(&raw).unwrap(), Request::DerivePubkey { .. }));
}

// ---- audit ----

fn audit_req(account: &str, ciphertext_hex: String, auditor_pubkey: String) -> Request {
    Request::Audit { contract: CONTRACT.into(), round_id: 1, account: account.into(), ciphertext_hex, auditor_pubkey }
}

#[test]
fn audit_seals_the_funds_own_mark_to_its_auditor() {
    let (sk, pk) = buyer();
    let out = handle(audit_req("b.testnet", encrypt_mark(1, "b.testnet", 9500), pk), &MASTER, CONTRACT);
    assert_eq!(out["ok"], true, "{out}");
    let opened: Value =
        serde_json::from_slice(&ecies::decrypt(&sk.serialize(), &hex::decode(out["sealed"].as_str().unwrap()).unwrap()).unwrap())
            .unwrap();
    assert_eq!(opened, json!({"kind": "audit", "account": "b.testnet", "round_id": 1, "mark": 9500}));
}

#[test]
fn audit_refuses_a_ciphertext_made_for_another_account() {
    let (_, pk) = buyer();
    let out = handle(audit_req("b.testnet", encrypt_mark(1, "a.testnet", 9500), pk), &MASTER, CONTRACT);
    assert_eq!(out["ok"], false);
    assert_eq!(out["error"], "encrypted for another account");
    assert!(out.get("sealed").is_none());
}

#[test]
fn audit_is_refused_to_anyone_but_the_contract() {
    let (_, pk) = buyer();
    let out = handle(audit_req("b.testnet", encrypt_mark(1, "b.testnet", 9500), pk), &MASTER, "someone.testnet");
    assert_eq!(out["ok"], false);
    assert_eq!(out["error"], "only the round's contract may call this module");
}

#[test]
fn audit_parses_from_the_contracts_json() {
    let raw = json!({
        "action": "audit", "contract": CONTRACT, "round_id": 1, "account": "a.testnet",
        "ciphertext_hex": "ab", "auditor_pubkey": "02ab",
    })
    .to_string();
    assert!(matches!(serde_json::from_str::<Request>(&raw).unwrap(), Request::Audit { .. }));
}
