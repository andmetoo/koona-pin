//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! The keys of sync v1 (`PROTOCOL.md`): a device's Ed25519 key proves it to the relay and to the
//! hub; the library key, shared by the account's active devices, seals every sync body so the
//! relay forwards what it can't read; pairing hands the library key to a new device over an
//! X25519 exchange that the person confirms by comparing six digits. `ring` only.

use crate::protocol::{Address, Header, Kind, HEADER_LEN, TAG_LEN};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305};
use ring::agreement::{self, EphemeralPrivateKey, UnparsedPublicKey, X25519};
use ring::digest::{self, SHA256};
use ring::hkdf::{self, HKDF_SHA256};
use ring::rand::SecureRandom;
use ring::signature::{self, Ed25519KeyPair, KeyPair, ED25519};
use std::collections::HashMap;
use std::fmt;
use uuid::Uuid;

/// The symmetric key every active device holds; a new one per epoch.
pub type LibraryKey = [u8; 32];

pub const RELAY_HELLO_LABEL: &[u8] = b"koona-sync relay v1";
pub const FRAME_INFO: &[u8] = b"koona-sync frame v1";
pub const PAIR_CODE_INFO: &[u8] = b"koona-sync pair code";
pub const PAIR_COMMIT_LABEL: &[u8] = b"koona-sync pair commit v2";
pub const LIBRARY_KEY_AAD: &[u8] = b"koona-sync library key v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CryptoError {
    /// Shorter than a header and a tag.
    Truncated,
    /// The tag didn't verify: wrong key or epoch, or the header, ciphertext, sender or address
    /// changed on the way.
    Unauthentic,
    /// A sequence number at or below the last one accepted from that sender's session.
    Replayed,
    BadSignature,
    /// A key the algorithm rejects (a malformed PKCS#8, an X25519 point of small order).
    BadKey,
    /// The system random source failed.
    Random,
}

impl fmt::Display for CryptoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            CryptoError::Truncated => "truncated",
            CryptoError::Unauthentic => "not authentic",
            CryptoError::Replayed => "replayed",
            CryptoError::BadSignature => "bad signature",
            CryptoError::BadKey => "bad key",
            CryptoError::Random => "random source failed",
        })
    }
}

impl std::error::Error for CryptoError {}

struct Len(usize);

impl hkdf::KeyType for Len {
    fn len(&self) -> usize {
        self.0
    }
}

/// HKDF-SHA256 with the info given in parts (concatenated).
fn hkdf<const N: usize>(ikm: &[u8], salt: &[u8], info: &[&[u8]]) -> [u8; N] {
    let mut out = [0; N];
    hkdf::Salt::new(HKDF_SHA256, salt)
        .extract(ikm)
        .expand(info, Len(N))
        .and_then(|okm| okm.fill(&mut out))
        .expect("HKDF-SHA256 gives up to 8160 bytes");
    out
}

fn chacha(key: &[u8; 32]) -> LessSafeKey {
    LessSafeKey::new(UnboundKey::new(&CHACHA20_POLY1305, key).expect("32-byte key"))
}

pub fn random<const N: usize>(rng: &dyn SecureRandom) -> Result<[u8; N], CryptoError> {
    let mut out = [0; N];
    rng.fill(&mut out).map_err(|_| CryptoError::Random)?;
    Ok(out)
}

// --- Device keys ---

/// A new device key as PKCS#8, which is what a device stores (in the OS keychain).
pub fn generate_device_key(rng: &dyn SecureRandom) -> Result<Vec<u8>, CryptoError> {
    Ed25519KeyPair::generate_pkcs8(rng).map(|doc| doc.as_ref().to_vec()).map_err(|_| CryptoError::Random)
}

pub fn device_key(pkcs8: &[u8]) -> Result<Ed25519KeyPair, CryptoError> {
    Ed25519KeyPair::from_pkcs8(pkcs8).map_err(|_| CryptoError::BadKey)
}

pub fn public_key(pair: &Ed25519KeyPair) -> [u8; 32] {
    pair.public_key().as_ref().try_into().expect("Ed25519 public keys are 32 bytes")
}

pub fn sign(pair: &Ed25519KeyPair, message: &[u8]) -> [u8; 64] {
    pair.sign(message).as_ref().try_into().expect("Ed25519 signatures are 64 bytes")
}

pub fn verify(public: &[u8; 32], message: &[u8], sig: &[u8; 64]) -> Result<(), CryptoError> {
    signature::UnparsedPublicKey::new(&ED25519, public)
        .verify(message, sig)
        .map_err(|_| CryptoError::BadSignature)
}

// --- Device <-> relay: hello ---

/// `"koona-sync relay v1" || sub || 0x00 || nonce || device`: the account binds the signature to
/// one sign-in and the nonce to one connection. A `sub` never holds NUL, so the split is unique.
pub fn relay_hello_bytes(sub: &str, nonce: &[u8; 32], device: Uuid) -> Vec<u8> {
    let mut out = Vec::with_capacity(RELAY_HELLO_LABEL.len() + sub.len() + 1 + 32 + 16);
    out.extend_from_slice(RELAY_HELLO_LABEL);
    out.extend_from_slice(sub.as_bytes());
    out.push(0);
    out.extend_from_slice(nonce);
    out.extend_from_slice(device.as_bytes());
    out
}

pub fn sign_relay_hello(pair: &Ed25519KeyPair, sub: &str, nonce: &[u8; 32], device: Uuid) -> [u8; 64] {
    sign(pair, &relay_hello_bytes(sub, nonce, device))
}

pub fn verify_relay_hello(
    public: &[u8; 32],
    sub: &str,
    nonce: &[u8; 32],
    device: Uuid,
    sig: &[u8; 64],
) -> Result<(), CryptoError> {
    verify(public, &relay_hello_bytes(sub, nonce, device), sig)
}

// --- Device <-> device: sealed bodies ---

/// One key per (library key, epoch, session, sender): a sender's nonces only have to be unique
/// within its own session, which a counter guarantees.
pub fn session_key(library: &LibraryKey, epoch: u32, session: &[u8; 16], sender: Uuid) -> [u8; 32] {
    hkdf(library, session, &[FRAME_INFO, &epoch.to_be_bytes(), sender.as_bytes()])
}

pub fn frame_nonce(seq: u64) -> [u8; 12] {
    let mut nonce = [0; 12];
    nonce[4..].copy_from_slice(&seq.to_be_bytes());
    nonce
}

/// The header, then the relay's routing fields: a body moved to another sender or recipient no
/// longer opens.
pub fn frame_aad(header: &[u8; HEADER_LEN], from: Uuid, to: Address) -> [u8; HEADER_LEN + 32] {
    let mut aad = [0; HEADER_LEN + 32];
    aad[..HEADER_LEN].copy_from_slice(header);
    aad[HEADER_LEN..HEADER_LEN + 16].copy_from_slice(from.as_bytes());
    aad[HEADER_LEN + 16..].copy_from_slice(&to.to_bytes());
    aad
}

/// `header || ChaCha20-Poly1305(payload) || tag`. `to` is the address exactly as the frame
/// carries it.
pub fn seal_body(library: &LibraryKey, header: &Header, from: Uuid, to: Address, payload: &[u8]) -> Vec<u8> {
    let key = chacha(&session_key(library, header.epoch, &header.session, from));
    let encoded = header.encode();
    let mut body = Vec::with_capacity(HEADER_LEN + payload.len() + TAG_LEN);
    body.extend_from_slice(&encoded);
    body.extend_from_slice(payload);
    let mut sealed = body.split_off(HEADER_LEN);
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(frame_nonce(header.seq)),
        Aad::from(frame_aad(&encoded, from, to)),
        &mut sealed,
    )
    .expect("a body under the AEAD limit");
    body.extend_from_slice(&sealed);
    body
}

/// Opens a body addressed as `to`. The caller has read the header (`Header::parse`) to pick the
/// library key of its epoch, and checks the replay guard afterwards.
pub fn open_body(library: &LibraryKey, from: Uuid, to: Address, body: &[u8]) -> Result<(Header, Vec<u8>), CryptoError> {
    let (header, _) = Header::parse(body).map_err(|_| CryptoError::Truncated)?;
    if body.len() < HEADER_LEN + TAG_LEN {
        return Err(CryptoError::Truncated);
    }
    let encoded: [u8; HEADER_LEN] = body[..HEADER_LEN].try_into().unwrap();
    let key = chacha(&session_key(library, header.epoch, &header.session, from));
    let mut sealed = body[HEADER_LEN..].to_vec();
    let len = key
        .open_in_place(
            Nonce::assume_unique_for_key(frame_nonce(header.seq)),
            Aad::from(frame_aad(&encoded, from, to)),
            &mut sealed,
        )
        .map_err(|_| CryptoError::Unauthentic)?
        .len();
    sealed.truncate(len);
    Ok((header, sealed))
}

/// The delivered frame doesn't say how it was addressed: a body for this device was sent either
/// to its id or to everyone. Kind-1 bodies are never addressed to the hub alias.
pub fn open_for(library: &LibraryKey, from: Uuid, me: Uuid, body: &[u8]) -> Result<(Header, Vec<u8>), CryptoError> {
    match open_body(library, from, Address::Device(me), body) {
        Err(CryptoError::Unauthentic) => open_body(library, from, Address::All, body),
        other => other,
    }
}

/// A sender's side of one session: a fresh random session, then seq 0, 1, 2…
pub struct Sealer {
    library: LibraryKey,
    epoch: u32,
    session: [u8; 16],
    from: Uuid,
    next: u64,
}

impl Sealer {
    pub fn new(library: LibraryKey, epoch: u32, from: Uuid, rng: &dyn SecureRandom) -> Result<Sealer, CryptoError> {
        Ok(Sealer { library, epoch, session: random(rng)?, from, next: 0 })
    }

    pub fn session(&self) -> [u8; 16] {
        self.session
    }

    pub fn seal(&mut self, to: Address, payload: &[u8]) -> Vec<u8> {
        let header = Header { kind: Kind::Sync, epoch: self.epoch, session: self.session, seq: self.next };
        self.next += 1;
        seal_body(&self.library, &header, self.from, to, payload)
    }

    /// The header of an unsealed kind-2 body in the same sequence.
    pub fn pairing_header(&mut self) -> Header {
        let header = Header { kind: Kind::Pairing, epoch: self.epoch, session: self.session, seq: self.next };
        self.next += 1;
        header
    }
}

/// The last sequence number accepted per (sender, session). In memory: a replay after the
/// receiver restarts only re-applies changes it already holds, which changes nothing.
#[derive(Debug, Default)]
pub struct ReplayGuard {
    last: HashMap<(Uuid, [u8; 16]), u64>,
}

impl ReplayGuard {
    /// Whether `accept` would refuse this body, without recording it: for a body that failed to
    /// authenticate, to tell a replay from a forgery.
    pub fn replayed(&self, from: Uuid, header: &Header) -> bool {
        self.last.get(&(from, header.session)).is_some_and(|&last| header.seq <= last)
    }

    /// Call only for a body that opened, so a forger can't push the window ahead.
    pub fn accept(&mut self, from: Uuid, header: &Header) -> Result<(), CryptoError> {
        match self.last.get(&(from, header.session)) {
            Some(&last) if header.seq <= last => Err(CryptoError::Replayed),
            _ => {
                self.last.insert((from, header.session), header.seq);
                Ok(())
            }
        }
    }
}

// --- Pairing and rekeying ---

/// Pairing hands the library key to a new device and shows a code; rekeying hands a new library
/// key to a device both sides already know, so no code. Separate labels keep one from ever
/// standing in for the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exchange {
    Pair,
    Rekey,
}

impl Exchange {
    fn transcript_label(self) -> &'static [u8] {
        match self {
            Exchange::Pair => b"koona-sync pair v2",
            Exchange::Rekey => b"koona-sync rekey v1",
        }
    }

    fn offer_label(self) -> &'static [u8] {
        match self {
            Exchange::Pair => b"koona-sync pair offer v2",
            Exchange::Rekey => b"koona-sync rekey offer v1",
        }
    }

    fn accept_label(self) -> &'static [u8] {
        match self {
            Exchange::Pair => b"koona-sync pair accept v2",
            Exchange::Rekey => b"koona-sync rekey accept v1",
        }
    }

    fn key_info(self) -> &'static [u8] {
        match self {
            Exchange::Pair => b"koona-sync pair key",
            Exchange::Rekey => b"koona-sync rekey key",
        }
    }
}

/// One side of an exchange: the device asking for the key, or the hub.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Party {
    pub device: Uuid,
    /// Ed25519.
    pub key: [u8; 32],
    /// X25519, ephemeral.
    pub eph: [u8; 32],
}

/// An X25519 key for one exchange. `ring` only lets it be used once, which is all it is for.
pub struct Ephemeral {
    private: EphemeralPrivateKey,
    public: [u8; 32],
}

impl Ephemeral {
    pub fn generate(rng: &dyn SecureRandom) -> Result<Ephemeral, CryptoError> {
        let private = EphemeralPrivateKey::generate(&X25519, rng).map_err(|_| CryptoError::Random)?;
        let public = private.compute_public_key().map_err(|_| CryptoError::Random)?;
        let public = public.as_ref().try_into().expect("X25519 public keys are 32 bytes");
        Ok(Ephemeral { private, public })
    }

    pub fn public(&self) -> [u8; 32] {
        self.public
    }

    /// The raw X25519 shared secret; `ring` refuses a peer key of small order (an all-zero
    /// result).
    pub fn agree(self, peer: &[u8; 32]) -> Result<[u8; 32], CryptoError> {
        agreement::agree_ephemeral(self.private, &UnparsedPublicKey::new(&X25519, peer), |shared| {
            <[u8; 32]>::try_from(shared).expect("X25519 secrets are 32 bytes")
        })
        .map_err(|_| CryptoError::BadKey)
    }
}

/// What the device asking for the key commits to in a pairing before it sees the hub's `eph`,
/// and reveals after: neither side can choose its ephemeral key knowing the other's, so a relay
/// playing the hub can't grind keys until the two codes match.
pub fn commitment(asking: &Party, hub: Uuid) -> [u8; 32] {
    let bytes = [PAIR_COMMIT_LABEL, asking.device.as_bytes(), hub.as_bytes(), &asking.key, &asking.eph].concat();
    digest::digest(&SHA256, &bytes).as_ref().try_into().expect("SHA-256 is 32 bytes")
}

/// What the device asking for the key signs: everything it knows before the hub answers. `sent`
/// is what the offer carries: `eph` in a rekey, the [`commitment`] to it in a pairing.
pub fn offer_bytes(exchange: Exchange, device: Uuid, key: &[u8; 32], hub: Uuid, sent: &[u8; 32]) -> Vec<u8> {
    [exchange.offer_label(), device.as_bytes(), hub.as_bytes(), sent, key].concat()
}

/// SHA-256 over both parties: the code and the key depend on every public value, so a relay
/// that swaps one gets different digits on the two screens. A pairing's also covers the
/// commitment.
pub fn transcript(exchange: Exchange, asking: &Party, hub: &Party) -> [u8; 32] {
    let commit = match exchange {
        Exchange::Pair => commitment(asking, hub.device).to_vec(),
        Exchange::Rekey => Vec::new(),
    };
    let bytes = [
        exchange.transcript_label(),
        asking.device.as_bytes(),
        &asking.key,
        &asking.eph,
        hub.device.as_bytes(),
        &hub.key,
        &hub.eph,
        &commit,
    ]
    .concat();
    digest::digest(&SHA256, &bytes).as_ref().try_into().expect("SHA-256 is 32 bytes")
}

/// What the hub signs in a pairing: everything public so far. It hasn't seen the asking
/// device's `eph` yet, only the commitment to it.
pub fn pair_accept_bytes(device: Uuid, key: &[u8; 32], commit: &[u8; 32], hub: &Party) -> Vec<u8> {
    [Exchange::Pair.accept_label(), device.as_bytes(), key, commit, hub.device.as_bytes(), &hub.key, &hub.eph].concat()
}

/// What the hub signs in a rekey: the whole transcript.
pub fn rekey_accept_bytes(transcript: &[u8; 32]) -> Vec<u8> {
    [Exchange::Rekey.accept_label(), transcript].concat()
}

/// Six digits both screens show; leading zeros kept (`format!("{:06}")`).
pub fn pair_code(shared: &[u8; 32], transcript: &[u8; 32]) -> u32 {
    u32::from_be_bytes(hkdf(shared, transcript, &[PAIR_CODE_INFO])) % 1_000_000
}

/// The key that seals the library key for this one exchange.
pub fn exchange_key(exchange: Exchange, shared: &[u8; 32], transcript: &[u8; 32]) -> [u8; 32] {
    hkdf(shared, transcript, &[exchange.key_info()])
}

fn library_key_aad(epoch: u32, device: Uuid) -> Vec<u8> {
    [LIBRARY_KEY_AAD, &epoch.to_be_bytes(), device.as_bytes()].concat()
}

/// The library key of `epoch` for `device` (the one asking). The exchange key seals exactly one
/// message, so a zero nonce is safe.
pub fn seal_library_key(key: &[u8; 32], epoch: u32, device: Uuid, library: &LibraryKey) -> [u8; 48] {
    let mut sealed = library.to_vec();
    chacha(key)
        .seal_in_place_append_tag(
            Nonce::assume_unique_for_key([0; 12]),
            Aad::from(library_key_aad(epoch, device)),
            &mut sealed,
        )
        .expect("32 bytes under the AEAD limit");
    sealed.try_into().expect("32 bytes and a tag")
}

pub fn open_library_key(key: &[u8; 32], epoch: u32, device: Uuid, sealed: &[u8; 48]) -> Result<LibraryKey, CryptoError> {
    let mut buffer = sealed.to_vec();
    let opened = chacha(key)
        .open_in_place(Nonce::assume_unique_for_key([0; 12]), Aad::from(library_key_aad(epoch, device)), &mut buffer)
        .map_err(|_| CryptoError::Unauthentic)?;
    Ok(opened.try_into().expect("32 bytes"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::rand::SystemRandom;

    fn id(n: u8) -> Uuid {
        Uuid::from_bytes([n; 16])
    }

    fn header(epoch: u32, seq: u64) -> Header {
        Header { kind: Kind::Sync, epoch, session: [5; 16], seq }
    }

    #[test]
    fn a_sealed_body_opens_only_unchanged() {
        let library = [1; 32];
        let body = seal_body(&library, &header(3, 0), id(1), Address::Device(id(2)), b"payload");
        let (opened, payload) = open_body(&library, id(1), Address::Device(id(2)), &body).unwrap();
        assert_eq!((opened, payload.as_slice()), (header(3, 0), &b"payload"[..]));

        let mut ciphertext = body.clone();
        ciphertext[HEADER_LEN] ^= 1;
        let mut tag = body.clone();
        *tag.last_mut().unwrap() ^= 1;
        let mut epoch = body.clone();
        epoch[5] ^= 1;
        let mut seq = body.clone();
        seq[29] ^= 1;
        for tampered in [ciphertext, tag, epoch, seq] {
            assert_eq!(open_body(&library, id(1), Address::Device(id(2)), &tampered), Err(CryptoError::Unauthentic));
        }
        // The relay rewrote the sender or delivered it elsewhere: the AAD differs.
        assert_eq!(open_body(&library, id(9), Address::Device(id(2)), &body), Err(CryptoError::Unauthentic));
        assert_eq!(open_body(&library, id(1), Address::Device(id(9)), &body), Err(CryptoError::Unauthentic));
        assert_eq!(open_body(&library, id(1), Address::All, &body), Err(CryptoError::Unauthentic));
        assert_eq!(open_body(&[2; 32], id(1), Address::Device(id(2)), &body), Err(CryptoError::Unauthentic));
        assert_eq!(open_body(&library, id(1), Address::All, &body[..HEADER_LEN + 3]), Err(CryptoError::Truncated));
    }

    #[test]
    fn a_receiver_opens_bodies_to_it_and_to_everyone() {
        let library = [1; 32];
        let mut sealer = Sealer::new(library, 0, id(1), &SystemRandom::new()).unwrap();
        let direct = sealer.seal(Address::Device(id(2)), b"a");
        let broadcast = sealer.seal(Address::All, b"b");
        assert_eq!(open_for(&library, id(1), id(2), &direct).unwrap().1, b"a");
        assert_eq!(open_for(&library, id(1), id(2), &broadcast).unwrap().1, b"b");
        assert_eq!(open_for(&library, id(1), id(3), &direct), Err(CryptoError::Unauthentic));
    }

    #[test]
    fn replayed_and_reordered_seqs_are_refused() {
        let mut guard = ReplayGuard::default();
        assert_eq!(guard.accept(id(1), &header(0, 0)), Ok(()));
        assert_eq!(guard.accept(id(1), &header(0, 1)), Ok(()));
        assert_eq!(guard.accept(id(1), &header(0, 1)), Err(CryptoError::Replayed));
        assert_eq!(guard.accept(id(1), &header(0, 0)), Err(CryptoError::Replayed));
        // Another sender, or a new session of the same sender, starts over.
        assert_eq!(guard.accept(id(2), &header(0, 0)), Ok(()));
        let fresh = Header { session: [6; 16], ..header(0, 0) };
        assert_eq!(guard.accept(id(1), &fresh), Ok(()));
    }

    #[test]
    fn hello_signatures_bind_the_account_nonce_and_device() {
        let rng = SystemRandom::new();
        let pair = device_key(&generate_device_key(&rng).unwrap()).unwrap();
        let public = public_key(&pair);
        let nonce = [7; 32];
        let sig = sign_relay_hello(&pair, "user-a", &nonce, id(1));
        assert_eq!(verify_relay_hello(&public, "user-a", &nonce, id(1), &sig), Ok(()));
        assert!(verify_relay_hello(&public, "user-b", &nonce, id(1), &sig).is_err());
        assert!(verify_relay_hello(&public, "user-a", &[8; 32], id(1), &sig).is_err());
        assert!(verify_relay_hello(&public, "user-a", &nonce, id(2), &sig).is_err());
    }

    struct Side {
        party: Party,
        pair: Ed25519KeyPair,
        eph: Ephemeral,
    }

    fn side(device: Uuid, rng: &SystemRandom) -> Side {
        let pair = device_key(&generate_device_key(rng).unwrap()).unwrap();
        let eph = Ephemeral::generate(rng).unwrap();
        Side { party: Party { device, key: public_key(&pair), eph: eph.public() }, pair, eph }
    }

    #[test]
    fn both_sides_see_the_same_code_and_get_the_key() {
        let rng = SystemRandom::new();
        let (asking, hub) = (side(id(1), &rng), side(id(2), &rng));

        let (a, h) = (asking.party, hub.party);
        let commit = commitment(&a, h.device);
        let offer_sig = sign(&asking.pair, &offer_bytes(Exchange::Pair, a.device, &a.key, h.device, &commit));
        assert_eq!(verify(&a.key, &offer_bytes(Exchange::Pair, a.device, &a.key, id(2), &commit), &offer_sig), Ok(()));

        let accept_sig = sign(&hub.pair, &pair_accept_bytes(a.device, &a.key, &commit, &h));
        assert_eq!(verify(&h.key, &pair_accept_bytes(a.device, &a.key, &commit, &h), &accept_sig), Ok(()));
        let t = transcript(Exchange::Pair, &a, &h);

        let (asking_party, hub_party) = (asking.party, hub.party);
        let shared_asking = asking.eph.agree(&hub_party.eph).unwrap();
        let shared_hub = hub.eph.agree(&asking_party.eph).unwrap();
        assert_eq!(shared_asking, shared_hub);
        assert_eq!(pair_code(&shared_asking, &t), pair_code(&shared_hub, &t));

        let library = [9; 32];
        let sealed = seal_library_key(&exchange_key(Exchange::Pair, &shared_hub, &t), 4, id(1), &library);
        let key = exchange_key(Exchange::Pair, &shared_asking, &t);
        assert_eq!(open_library_key(&key, 4, id(1), &sealed), Ok(library));
        assert_eq!(open_library_key(&key, 5, id(1), &sealed), Err(CryptoError::Unauthentic));
        assert_eq!(open_library_key(&key, 4, id(3), &sealed), Err(CryptoError::Unauthentic));
        // A rekey key from the same secret is a different key.
        let rekey = exchange_key(Exchange::Rekey, &shared_asking, &t);
        assert_eq!(open_library_key(&rekey, 4, id(1), &sealed), Err(CryptoError::Unauthentic));
    }

    #[test]
    fn a_swapped_ephemeral_key_shows_different_digits() {
        // The relay answers the new device's offer with its own X25519 key and the hub's offer
        // with another: each side agrees with the relay, and the codes don't match.
        let rng = SystemRandom::new();
        let (asking, hub) = (side(id(1), &rng), side(id(2), &rng));
        let (relay_to_asking, relay_to_hub) = (Ephemeral::generate(&rng).unwrap(), Ephemeral::generate(&rng).unwrap());

        let asking_view = Party { eph: relay_to_asking.public(), ..hub.party };
        let hub_view = Party { eph: relay_to_hub.public(), ..asking.party };
        let t_asking = transcript(Exchange::Pair, &asking.party, &asking_view);
        let t_hub = transcript(Exchange::Pair, &hub_view, &hub.party);
        let code_asking = pair_code(&asking.eph.agree(&asking_view.eph).unwrap(), &t_asking);
        let code_hub = pair_code(&hub.eph.agree(&hub_view.eph).unwrap(), &t_hub);
        assert_ne!(code_asking, code_hub);

        // Even with the same secret, a changed public value changes the code.
        let shared = [3; 32];
        let honest = transcript(Exchange::Pair, &asking.party, &hub.party);
        let swapped = transcript(Exchange::Pair, &asking.party, &Party { eph: [4; 32], ..hub.party });
        assert_ne!(pair_code(&shared, &honest), pair_code(&shared, &swapped));
    }

    #[test]
    fn the_commitment_binds_every_value_of_the_asking_side() {
        let a = Party { device: id(1), key: [2; 32], eph: [3; 32] };
        let commit = commitment(&a, id(9));
        assert_ne!(commit, commitment(&Party { eph: [4; 32], ..a }, id(9)));
        assert_ne!(commit, commitment(&Party { key: [4; 32], ..a }, id(9)));
        assert_ne!(commit, commitment(&Party { device: id(4), ..a }, id(9)));
        assert_ne!(commit, commitment(&a, id(8)));
        // The transcript covers it, so a pairing transcript is never a rekey one.
        let h = Party { device: id(9), key: [5; 32], eph: [6; 32] };
        assert_ne!(transcript(Exchange::Pair, &a, &h), transcript(Exchange::Rekey, &a, &h));
    }

    #[test]
    fn a_small_order_point_is_refused() {
        let eph = Ephemeral::generate(&SystemRandom::new()).unwrap();
        assert_eq!(eph.agree(&[0; 32]), Err(CryptoError::BadKey));
    }
}
