//! The hex SHA-256 the app names things by: the picture cache's file names (thumbs.rs) and a Play
//! purchase's account id (billing/play.rs). One function, so the two never differ in case or form.

use sha2::{Digest, Sha256};

/// SHA-256 of `bytes` as 64 lower-case hex digits.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}
