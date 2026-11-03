//! The Nema enclave module, run by OutLayer inside Intel TDX.
//!
//! It reads one JSON request on stdin and prints one JSON response. Four actions:
//!
//!   derive_pubkey  the round's public key, which funds encrypt their marks to
//!   tally          decrypt the committed submissions, compute the consensus, and
//!                  return only the count, the rejected list and a commitment to
//!                  the result; the mean and spread stay sealed
//!   deliver        recompute the same result and return it encrypted to one
//!                  buyer's key, with the salt so the buyer can check the commitment
//!   audit          open one fund's stored submission and return its mark encrypted
//!                  to the auditor that fund named, so the auditor sees exactly what
//!                  the fund sent rather than a copy the fund could have altered
//!
//! The module keeps no state between runs. Everything is recomputed from the
//! master secret (`PROTECTED_NEMA_MASTER`, generated inside the enclave) and the
//! ciphertexts the contract passes in.
//!
//! Only the contract named in the request may call it (checked against the
//! NEAR predecessor that OutLayer reports). Without this, anyone could ask the
//! enclave to tally a hand-picked set, for example one real fund's ciphertext
//! next to three of their own, and read that fund's mark off the mean.

mod crypto;
mod stats;

use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, Read};
use stats::{Consensus, Outcome, Rejected};

const MASTER_ENV: &str = "PROTECTED_NEMA_MASTER";

#[derive(Deserialize, Clone)]
struct Sub {
    account: String,
    ciphertext_hex: String,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum Request {
    DerivePubkey {
        contract: String,
        round_id: u64,
    },
    Tally {
        contract: String,
        round_id: u64,
        min_contributors: usize,
        set_hash: String,
        submissions: Vec<Sub>,
    },
    Deliver {
        contract: String,
        round_id: u64,
        min_contributors: usize,
        set_hash: String,
        commitment: String,
        buyer_pubkey: String,
        submissions: Vec<Sub>,
    },
    Audit {
        contract: String,
        round_id: u64,
        account: String,
        ciphertext_hex: String,
        auditor_pubkey: String,
    },
}

/// What a fund encrypts: its own account, so a copied ciphertext is rejected, and
/// its mark in hundredths of a point.
#[derive(Deserialize)]
struct Plain {
    account: String,
    mark: i64,
}

struct Tallied {
    consensus: Consensus,
    rejected: Vec<Rejected>,
    set_hash: String,
    commitment: String,
    salt: [u8; 32],
}

fn fail(msg: impl Into<String>) -> Value {
    json!({"ok": false, "error": msg.into()})
}

impl Request {
    fn contract(&self) -> &str {
        match self {
            Request::DerivePubkey { contract, .. }
            | Request::Tally { contract, .. }
            | Request::Deliver { contract, .. }
            | Request::Audit { contract, .. } => contract,
        }
    }
}

/// Decrypt, check and aggregate. Fails if the submission set is not the one the
/// contract committed to, or if too few funds are valid.
fn tally(
    master: &crypto::Master,
    contract: &str,
    round_id: u64,
    min: usize,
    expected_set_hash: &str,
    subs: &[Sub],
) -> Result<Tallied, Value> {
    let pairs: Vec<(String, String)> =
        subs.iter().map(|s| (s.account.clone(), s.ciphertext_hex.clone())).collect();
    let set_hash = crypto::set_hash(&pairs);
    if set_hash != expected_set_hash {
        return Err(fail("the submissions do not match the committed set"));
    }

    let sk = crypto::round_key(master, contract, round_id).map_err(fail)?;
    let mut marks = Vec::new();
    let mut rejected = Vec::new();
    for s in subs {
        let plain = crypto::decrypt_hex(&sk, &s.ciphertext_hex)
            .and_then(|b| serde_json::from_slice::<Plain>(&b).map_err(|_| "malformed plaintext".into()));
        match plain {
            Ok(p) if p.account == s.account => marks.push((s.account.clone(), p.mark)),
            Ok(_) => rejected.push(Rejected::new(&s.account, "encrypted for another account")),
            Err(reason) => rejected.push(Rejected::new(&s.account, &reason)),
        }
    }

    match stats::aggregate(&marks, min, &mut rejected) {
        Outcome::Published(consensus) => {
            let salt = crypto::result_salt(master, contract, round_id);
            let commitment = crypto::commitment(
                contract,
                round_id,
                &salt,
                consensus.count,
                &consensus.mean,
                &consensus.spread,
            );
            Ok(Tallied { consensus, rejected, set_hash, commitment, salt })
        }
        Outcome::BelowMinimum { valid, min } => Err(json!({
            "ok": false,
            "error": format!("only {valid} valid submissions, {min} required"),
            "rejected": rejected,
        })),
    }
}

/// `predecessor` is the account that asked OutLayer for this run.
fn handle(req: Request, master: &crypto::Master, predecessor: &str) -> Value {
    if req.contract() != predecessor {
        return fail("only the round's contract may call this module");
    }
    match req {
        Request::DerivePubkey { contract, round_id } => {
            match crypto::round_pubkey_hex(master, &contract, round_id) {
                Ok(pubkey) => json!({"ok": true, "pubkey": pubkey}),
                Err(e) => fail(e),
            }
        }
        Request::Tally { contract, round_id, min_contributors, set_hash, submissions } => {
            match tally(master, &contract, round_id, min_contributors, &set_hash, &submissions) {
                Ok(t) => json!({
                    "ok": true,
                    "count": t.consensus.count,
                    "rejected": t.rejected,
                    "set_hash": t.set_hash,
                    "commitment": t.commitment,
                }),
                Err(e) => e,
            }
        }
        Request::Deliver {
            contract,
            round_id,
            min_contributors,
            set_hash,
            commitment,
            buyer_pubkey,
            submissions,
        } => {
            let t = match tally(master, &contract, round_id, min_contributors, &set_hash, &submissions) {
                Ok(t) => t,
                Err(e) => return e,
            };
            if t.commitment != commitment {
                return fail("the result does not match the published commitment");
            }
            let plain = json!({
                "count": t.consensus.count,
                "mean": t.consensus.mean,
                "spread": t.consensus.spread,
                "salt": hex::encode(t.salt),
            });
            match crypto::seal_hex(&buyer_pubkey, plain.to_string().as_bytes()) {
                Ok(sealed) => json!({
                    "ok": true,
                    "set_hash": t.set_hash,
                    "commitment": t.commitment,
                    "sealed": sealed,
                }),
                Err(e) => fail(e),
            }
        }
        Request::Audit { contract, round_id, account, ciphertext_hex, auditor_pubkey } => {
            let sk = match crypto::round_key(master, &contract, round_id) {
                Ok(sk) => sk,
                Err(e) => return fail(e),
            };
            let plain = crypto::decrypt_hex(&sk, &ciphertext_hex)
                .and_then(|b| serde_json::from_slice::<Plain>(&b).map_err(|_| "malformed plaintext".into()));
            let mark = match plain {
                Ok(p) if p.account == account => p.mark,
                Ok(_) => return fail("encrypted for another account"),
                Err(reason) => return fail(reason),
            };
            let out = json!({"kind": "audit", "account": account, "round_id": round_id, "mark": mark});
            match crypto::seal_hex(&auditor_pubkey, out.to_string().as_bytes()) {
                Ok(sealed) => json!({"ok": true, "sealed": sealed}),
                Err(e) => fail(e),
            }
        }
    }
}

fn main() {
    let mut raw = String::new();
    let out = if io::stdin().read_to_string(&mut raw).is_err() {
        fail("cannot read input")
    } else {
        match serde_json::from_str::<Request>(&raw) {
            Err(e) => fail(format!("bad input: {e}")),
            Ok(req) => match std::env::var(MASTER_ENV).map_err(|_| "the master secret is not set".to_string())
                .and_then(|h| crypto::parse_master(&h))
            {
                Err(e) => fail(e),
                Ok(master) => {
                    let predecessor = std::env::var("NEAR_PREDECESSOR_ID").unwrap_or_default();
                    handle(req, &master, &predecessor)
                }
            },
        }
    };
    print!("{out}");
}

#[cfg(test)]
mod tests;
