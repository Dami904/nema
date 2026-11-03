//! Keys, hashes and encryption. Every value here is derived from the master
//! secret, which OutLayer generates inside the enclave and never reveals, plus
//! public data (the contract id and the round id). So the enclave holds no state
//! between runs and still gets the same round key every time.
//!
//! Ciphertexts use ECIES over secp256k1 in the format of the `ecies` crate and the
//! eciesjs library with their default settings: uncompressed ephemeral public key
//! (65 bytes), then AES-256-GCM with a 16-byte nonce and 16-byte tag.

use ecies::{PublicKey, SecretKey};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};

pub type Master = [u8; 32];

pub fn parse_master(hex_str: &str) -> Result<Master, String> {
    let bytes = hex::decode(hex_str.trim()).map_err(|_| "the master secret is not hex")?;
    bytes.try_into().map_err(|_| "the master secret must be 32 bytes".to_string())
}

fn expand(master: &Master, label: &str, contract: &str, round_id: u64) -> [u8; 32] {
    let info = format!("nema/{label}/v1/{contract}/{round_id}");
    let mut out = [0u8; 32];
    Hkdf::<Sha256>::new(None, master)
        .expand(info.as_bytes(), &mut out)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    out
}

/// The round's secret key. Funds encrypt their marks to its public key.
pub fn round_key(master: &Master, contract: &str, round_id: u64) -> Result<SecretKey, String> {
    // A 32-byte value fails only if it is zero or above the curve order, which
    // happens with probability about 2^-128.
    SecretKey::parse_slice(&expand(master, "round-key", contract, round_id))
        .map_err(|_| "derived round key is out of range".to_string())
}

pub fn round_pubkey_hex(master: &Master, contract: &str, round_id: u64) -> Result<String, String> {
    let sk = round_key(master, contract, round_id)?;
    Ok(hex::encode(PublicKey::from_secret_key(&sk).serialize_compressed()))
}

/// Keeps the commitment hiding: without it, the small space of plausible
/// mean/spread pairs could be hashed and matched against the published value.
pub fn result_salt(master: &Master, contract: &str, round_id: u64) -> [u8; 32] {
    expand(master, "result-salt", contract, round_id)
}

/// Same layout as the contract's `compute_set_hash`: for each submission sorted by
/// account, u32 little-endian account length, the account bytes, and the sha256
/// of the ciphertext hex string. Then sha256 of the whole buffer.
pub fn set_hash(subs: &[(String, String)]) -> String {
    let mut sorted: Vec<&(String, String)> = subs.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut buf = Vec::new();
    for (account, ciphertext_hex) in sorted {
        buf.extend_from_slice(&(account.len() as u32).to_le_bytes());
        buf.extend_from_slice(account.as_bytes());
        buf.extend_from_slice(&Sha256::digest(ciphertext_hex.as_bytes()));
    }
    hex::encode(Sha256::digest(&buf))
}

/// The commitment published on chain in place of the result. A buyer who receives
/// the result and the salt recomputes this and checks it against the chain.
///
/// sha256("nema/commit/v1" || u32 LE contract length || contract || u64 LE round id
///        || salt (32 bytes) || "count|mean|spread")
pub fn commitment(contract: &str, round_id: u64, salt: &[u8; 32], count: usize, mean: &str, spread: &str) -> String {
    let mut h = Sha256::new();
    h.update(b"nema/commit/v1");
    h.update((contract.len() as u32).to_le_bytes());
    h.update(contract.as_bytes());
    h.update(round_id.to_le_bytes());
    h.update(salt);
    h.update(format!("{count}|{mean}|{spread}").as_bytes());
    hex::encode(h.finalize())
}

pub fn decrypt_hex(sk: &SecretKey, ciphertext_hex: &str) -> Result<Vec<u8>, String> {
    let bytes = hex::decode(ciphertext_hex).map_err(|_| "ciphertext is not hex")?;
    ecies::decrypt(&sk.serialize(), &bytes).map_err(|_| "cannot decrypt".to_string())
}

/// Encrypt to a reader's (buyer's or auditor's) secp256k1 public key (33 or 65
/// bytes, hex).
pub fn seal_hex(reader_pubkey_hex: &str, plaintext: &[u8]) -> Result<String, String> {
    let pk = hex::decode(reader_pubkey_hex).map_err(|_| "the reader's key is not hex")?;
    ecies::encrypt(&pk, plaintext).map(hex::encode).map_err(|_| "invalid reader key".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MASTER: Master = [7u8; 32];

    #[test]
    fn round_keys_differ_by_round_and_contract_and_are_stable() {
        let a = round_pubkey_hex(&MASTER, "nema.testnet", 1).unwrap();
        assert_eq!(a, round_pubkey_hex(&MASTER, "nema.testnet", 1).unwrap());
        assert_ne!(a, round_pubkey_hex(&MASTER, "nema.testnet", 2).unwrap());
        assert_ne!(a, round_pubkey_hex(&MASTER, "other.testnet", 1).unwrap());
        assert_eq!(a.len(), 66);
        assert!(a.starts_with("02") || a.starts_with("03"));
    }

    #[test]
    fn encrypt_to_round_key_then_decrypt() {
        let pk = round_pubkey_hex(&MASTER, "nema.testnet", 1).unwrap();
        let ct = seal_hex(&pk, b"hello").unwrap();
        let sk = round_key(&MASTER, "nema.testnet", 1).unwrap();
        assert_eq!(decrypt_hex(&sk, &ct).unwrap(), b"hello");
        let wrong = round_key(&MASTER, "nema.testnet", 2).unwrap();
        assert!(decrypt_hex(&wrong, &ct).is_err());
    }

    #[test]
    fn set_hash_ignores_input_order() {
        let a = vec![("b.testnet".to_string(), "aa".to_string()), ("a.testnet".to_string(), "bb".to_string())];
        let b = vec![a[1].clone(), a[0].clone()];
        assert_eq!(set_hash(&a), set_hash(&b));
    }

    #[test]
    fn set_hash_matches_a_fixed_vector() {
        // The contract's tests pin the same input to the same digest, so a layout
        // change on either side breaks one of the two suites.
        let subs = vec![
            ("alice.testnet".to_string(), "ab".repeat(40)),
            ("bob.testnet".to_string(), "cd".repeat(40)),
        ];
        assert_eq!(set_hash(&subs), SET_HASH_VECTOR);
    }

    pub const SET_HASH_VECTOR: &str = include_str!("../../testdata/set_hash_vector.txt");

    #[test]
    fn commitment_changes_with_any_field() {
        let s = result_salt(&MASTER, "nema.testnet", 1);
        let base = commitment("nema.testnet", 1, &s, 5, "94.10", "1.6324");
        assert_ne!(base, commitment("nema.testnet", 1, &s, 5, "94.11", "1.6324"));
        assert_ne!(base, commitment("nema.testnet", 1, &s, 5, "94.10", "1.6325"));
        assert_ne!(base, commitment("nema.testnet", 1, &s, 4, "94.10", "1.6324"));
        assert_ne!(base, commitment("nema.testnet", 2, &s, 5, "94.10", "1.6324"));
        assert_ne!(base, commitment("nema.testnet", 1, &[0u8; 32], 5, "94.10", "1.6324"));
    }
}
