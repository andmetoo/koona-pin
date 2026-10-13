//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! The sync engine (Р-68): every library is a replica that records the last clock of each field
//! it changed; two replicas exchange the fields beyond each other's version vector, and the later
//! clock wins field by field, so they end in one state whatever the order of delivery. The relay
//! between devices only forwards frames this crate encrypts. No Tauri here: the phone apps wrap
//! the same code later.

pub mod model;
pub mod protocol;
pub mod crypto;
