//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! The wire shapes of sync v1 (`PROTOCOL.md`): control JSON between a device and the relay,
//! binary data frames, the header of a device-to-device body, and the deflated JSON messages
//! inside it. Encoding and decoding only: no sockets, no keys (those are in `crypto`).

use crate::model::{Group, Vector, BOOKMARK_FIELDS, COLLECTION_FIELDS, TAG_FIELDS};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};
use std::fmt;
use std::io::{Read, Write};
use uuid::Uuid;

/// The protocol version a device sends in `X-Koona-Proto` and in the sync `hello`.
pub const PROTO: u32 = 1;
/// The first byte of every device-to-device body.
pub const BODY_VERSION: u8 = 1;
/// The first byte of every binary WebSocket message.
pub const DATA_FRAME: u8 = 0x01;
/// The largest body a data frame carries, header and tag included.
pub const MAX_BODY: usize = 1 << 20;
/// The largest deflated message inside one body; leaves room for the header and the tag.
pub const MAX_PAYLOAD: usize = 900 * 1024;
/// A deflated message never inflates past this: a peer can't make a receiver allocate gigabytes.
pub const MAX_INFLATED: usize = 16 << 20;
/// The largest control message (a text frame).
pub const MAX_CONTROL: usize = 64 * 1024;
/// A device whose clock is this far from the relay's stops syncing: its clocks would win or lose
/// every conflict for the wrong reason.
pub const MAX_CLOCK_SKEW_MS: u64 = 5 * 60 * 1000;
/// `ver || kind || epoch || session || seq`.
pub const HEADER_LEN: usize = 1 + 1 + 4 + 16 + 8;
/// The Poly1305 tag at the end of a sealed body.
pub const TAG_LEN: usize = 16;
/// The most characters of the sync `hello`'s `platform` and `app`.
pub const MAX_HELLO_TEXT: usize = 32;

/// WebSocket close codes the relay uses.
pub mod close {
    pub const AUTH: u16 = 4001;
    pub const PLAN: u16 = 4002;
    pub const REVOKED: u16 = 4003;
    pub const PROTO_TOO_OLD: u16 = 4004;
    /// The account was started over (`PROTOCOL.md` 2.6), by another device or by this one.
    pub const STARTED_OVER: u16 = 4005;
    pub const RATE_LIMITED: u16 = 4008;
    pub const REPLACED: u16 = 4009;
}

/// `error{code}` codes the relay sends on control messages it refuses.
pub mod relay_error {
    /// Not JSON, an unknown `t`, or a field of the wrong type.
    pub const BAD_MESSAGE: &str = "bad_message";
    /// A binary frame shorter than its header, of an unknown type, or over the limit.
    pub const BAD_FRAME: &str = "bad_frame";
    /// The sender may not do this: not the hub, or still pending.
    pub const FORBIDDEN: &str = "forbidden";
    /// The named device is not on the account, or is in the wrong state for this.
    pub const UNKNOWN_DEVICE: &str = "unknown_device";
    /// `epoch{epoch}` not greater than the current one.
    pub const BAD_EPOCH: &str = "bad_epoch";
    /// `start_over` without a sign-in by email code in the last ten minutes.
    pub const STALE_SIGN_IN: &str = "stale_sign_in";
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Shorter than its fixed part.
    Truncated,
    /// A binary frame whose first byte is not `DATA_FRAME`.
    FrameType(u8),
    /// Over `MAX_BODY`, `MAX_PAYLOAD`, `MAX_INFLATED` or `MAX_CONTROL`.
    TooLarge,
    /// Not raw deflate.
    Inflate,
    /// Not JSON, or JSON of the wrong shape.
    Malformed(String),
    /// A body version this build doesn't know.
    UnknownVersion(u8),
    /// A body kind this build doesn't know.
    UnknownKind(u8),
    /// A message `t` this build doesn't know.
    UnknownMessage(String),
    /// A field, an entity or a synced field name this build doesn't know.
    UnknownField(String),
}

impl Error {
    /// A newer peer wrote this: the receiver pauses and asks the person to update, and its
    /// vector doesn't advance past what it couldn't read.
    pub fn update_needed(&self) -> bool {
        matches!(
            self,
            Error::UnknownVersion(_)
                | Error::UnknownKind(_)
                | Error::UnknownMessage(_)
                | Error::UnknownField(_)
        )
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Truncated => write!(f, "truncated"),
            Error::FrameType(t) => write!(f, "unknown frame type {t:#04x}"),
            Error::TooLarge => write!(f, "too large"),
            Error::Inflate => write!(f, "not raw deflate"),
            Error::Malformed(why) => write!(f, "malformed: {why}"),
            Error::UnknownVersion(v) => write!(f, "unknown body version {v}"),
            Error::UnknownKind(k) => write!(f, "unknown body kind {k}"),
            Error::UnknownMessage(t) => write!(f, "unknown message {t:?}"),
            Error::UnknownField(name) => write!(f, "unknown field {name:?}"),
        }
    }
}

impl std::error::Error for Error {}

/// Fixed-length bytes as standard base64 with padding, as every key, nonce and signature in JSON.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct B64<const N: usize>(pub [u8; N]);

impl<const N: usize> fmt::Debug for B64<N> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "B64({})", STANDARD.encode(self.0))
    }
}

impl<const N: usize> Serialize for B64<N> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&STANDARD.encode(self.0))
    }
}

impl<'de, const N: usize> Deserialize<'de> for B64<N> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::Error as _;
        let text = String::deserialize(d)?;
        let bytes = STANDARD.decode(text.as_bytes()).map_err(D::Error::custom)?;
        let len = bytes.len();
        let bytes: [u8; N] = bytes
            .try_into()
            .map_err(|_| D::Error::custom(format!("{len} bytes, expected {N}")))?;
        Ok(B64(bytes))
    }
}

// --- Device <-> relay: control messages (text frames) ---

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceStatus {
    /// Registered by its first `hello`, waiting for the hub to pair it.
    Pending,
    Active,
    /// Final: the relay closes its connections with 4003 and never routes to it again.
    Revoked,
}

/// A device as the relay keeps it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub id: Uuid,
    pub name: String,
    /// Its Ed25519 public key, fixed by its first `hello`.
    pub key: B64<32>,
    pub status: DeviceStatus,
    /// When it last connected or disconnected, ms since the Unix epoch.
    pub last_seen: u64,
}

/// The latest start over of the account (`welcome.started_over`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartedOver {
    /// The device that started it over, the hub since.
    pub by: Uuid,
    /// ms since the Unix epoch.
    pub at: u64,
    /// The epoch the relay set then.
    pub epoch: u32,
}

/// Text frames between a device and the relay. Unknown fields are ignored, so the relay can grow
/// them; an unknown `t` decodes to `Error::UnknownMessage`, which a device ignores.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Control {
    /// Relay -> device, first message after the upgrade.
    Challenge { nonce: B64<32>, time: u64 },
    /// Device -> relay, the answer; `sig` is `crypto::sign_relay_hello`.
    Hello { device: Uuid, key: B64<32>, name: String, app: String, sig: B64<64> },
    /// Relay -> device after a valid `hello`. `status` is the device's own.
    Welcome {
        status: DeviceStatus,
        hub: Uuid,
        epoch: u32,
        devices: Vec<DeviceInfo>,
        online: Vec<Uuid>,
        time: u64,
        /// Once the account was started over (2.6).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_over: Option<StartedOver>,
    },
    /// Relay -> devices: a device's connection opened or closed.
    Presence { device: Uuid, online: bool },
    /// Relay -> devices: a device was registered, approved, revoked or renamed.
    Device { device: DeviceInfo },
    /// Relay -> devices: the hub or the epoch changed.
    Account { hub: Uuid, epoch: u32 },
    /// Hub -> relay: the pending device becomes active.
    Approve { device: Uuid },
    /// Hub -> relay.
    Revoke { device: Uuid },
    /// Hub -> relay: another active device becomes the hub, once the person on the hub allowed
    /// its `hub_request` (4.4).
    SetHub { device: Uuid },
    /// Active device -> relay.
    Rename { device: Uuid, name: String },
    /// Hub -> relay: the library key was rotated; greater than the current epoch.
    Epoch { epoch: u32 },
    /// Active or pending device -> relay: start the account over from this device (2.6). `token`
    /// is an access token of a sign-in by email code at most ten minutes old.
    StartOver { token: String },
    /// Relay -> device: the last control message was refused (`relay_error`).
    Error { code: String },
    /// Relay -> device: a data frame to `to` (as addressed) found nobody online to take it.
    Undeliverable { to: Uuid },
}

const CONTROL_TAGS: [&str; 14] = [
    "challenge",
    "hello",
    "welcome",
    "presence",
    "device",
    "account",
    "approve",
    "revoke",
    "set_hub",
    "rename",
    "epoch",
    "start_over",
    "error",
    "undeliverable",
];

pub fn encode_control(message: &Control) -> String {
    serde_json::to_string(message).expect("control messages always serialize")
}

pub fn decode_control(text: &str) -> Result<Control, Error> {
    if text.len() > MAX_CONTROL {
        return Err(Error::TooLarge);
    }
    let value: Value = serde_json::from_str(text).map_err(|e| Error::Malformed(e.to_string()))?;
    let tag = value.get("t").and_then(Value::as_str).ok_or_else(|| Error::Malformed("no t".into()))?;
    if !CONTROL_TAGS.contains(&tag) {
        return Err(Error::UnknownMessage(tag.to_string()));
    }
    serde_json::from_value(value).map_err(|e| Error::Malformed(e.to_string()))
}

// --- Device <-> relay: data frames (binary) ---

/// Where a device sends a data frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Address {
    /// All zero: whichever device is the hub when the relay routes it.
    Hub,
    /// All 0xFF: every other active device online.
    All,
    Device(Uuid),
}

impl Address {
    pub fn to_bytes(self) -> [u8; 16] {
        match self {
            Address::Hub => [0; 16],
            Address::All => [0xFF; 16],
            Address::Device(id) => *id.as_bytes(),
        }
    }

    /// Device ids are random UUIDs, never all zero or all 0xFF.
    pub fn from_bytes(bytes: [u8; 16]) -> Address {
        match bytes {
            b if b == [0; 16] => Address::Hub,
            b if b == [0xFF; 16] => Address::All,
            b => Address::Device(Uuid::from_bytes(b)),
        }
    }

    /// The address as `undeliverable{to}` reports it.
    pub fn as_uuid(self) -> Uuid {
        Uuid::from_bytes(self.to_bytes())
    }
}

/// Device -> relay: `0x01 || to(16) || body`.
pub fn encode_outgoing(to: Address, body: &[u8]) -> Result<Vec<u8>, Error> {
    if body.len() > MAX_BODY {
        return Err(Error::TooLarge);
    }
    let mut frame = Vec::with_capacity(17 + body.len());
    frame.push(DATA_FRAME);
    frame.extend_from_slice(&to.to_bytes());
    frame.extend_from_slice(body);
    Ok(frame)
}

/// The relay's side of `encode_outgoing`.
pub fn decode_outgoing(frame: &[u8]) -> Result<(Address, &[u8]), Error> {
    let (&kind, rest) = frame.split_first().ok_or(Error::Truncated)?;
    if kind != DATA_FRAME {
        return Err(Error::FrameType(kind));
    }
    if rest.len() < 16 {
        return Err(Error::Truncated);
    }
    let (to, body) = rest.split_at(16);
    if body.len() > MAX_BODY {
        return Err(Error::TooLarge);
    }
    Ok((Address::from_bytes(to.try_into().unwrap()), body))
}

/// A data frame as the relay delivers it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Delivered<'a> {
    /// Written by the relay from the authenticated connection, never taken from the sender.
    pub from: Uuid,
    /// The relay's clock when it forwarded the frame, ms since the Unix epoch.
    pub relay_ms: u64,
    pub body: &'a [u8],
}

/// Relay -> device: `0x01 || from(16) || relay_ms(u64 BE) || body`.
pub fn encode_delivered(from: Uuid, relay_ms: u64, body: &[u8]) -> Result<Vec<u8>, Error> {
    if body.len() > MAX_BODY {
        return Err(Error::TooLarge);
    }
    let mut frame = Vec::with_capacity(25 + body.len());
    frame.push(DATA_FRAME);
    frame.extend_from_slice(from.as_bytes());
    frame.extend_from_slice(&relay_ms.to_be_bytes());
    frame.extend_from_slice(body);
    Ok(frame)
}

pub fn decode_delivered(frame: &[u8]) -> Result<Delivered<'_>, Error> {
    let (&kind, rest) = frame.split_first().ok_or(Error::Truncated)?;
    if kind != DATA_FRAME {
        return Err(Error::FrameType(kind));
    }
    if rest.len() < 24 {
        return Err(Error::Truncated);
    }
    let body = &rest[24..];
    if body.len() > MAX_BODY {
        return Err(Error::TooLarge);
    }
    Ok(Delivered {
        from: Uuid::from_bytes(rest[..16].try_into().unwrap()),
        relay_ms: u64::from_be_bytes(rest[16..24].try_into().unwrap()),
        body,
    })
}

/// Whether a delivered frame says this device's clock is off (`error{clock_skew}`).
pub fn clock_skewed(relay_ms: u64, local_ms: u64) -> bool {
    relay_ms.abs_diff(local_ms) > MAX_CLOCK_SKEW_MS
}

// --- Device <-> device: body header ---

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    /// Sealed with a key derived from the library key; carries `SyncMessage`.
    Sync = 1,
    /// Not sealed (its secrets are sealed inside); carries `PairMessage`. The only kind a pending
    /// device may send, and only to the hub.
    Pairing = 2,
}

impl Kind {
    pub fn from_byte(byte: u8) -> Result<Kind, Error> {
        match byte {
            1 => Ok(Kind::Sync),
            2 => Ok(Kind::Pairing),
            other => Err(Error::UnknownKind(other)),
        }
    }
}

/// `ver(1) || kind(1) || epoch(u32 BE) || session(16) || seq(u64 BE)`, before the payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Header {
    pub kind: Kind,
    /// The library key generation the body is sealed under.
    pub epoch: u32,
    /// Random per sender run; with `seq` it never repeats a nonce under one key.
    pub session: [u8; 16],
    pub seq: u64,
}

impl Header {
    pub fn encode(&self) -> [u8; HEADER_LEN] {
        let mut out = [0; HEADER_LEN];
        out[0] = BODY_VERSION;
        out[1] = self.kind as u8;
        out[2..6].copy_from_slice(&self.epoch.to_be_bytes());
        out[6..22].copy_from_slice(&self.session);
        out[22..30].copy_from_slice(&self.seq.to_be_bytes());
        out
    }

    /// The header and what follows it.
    pub fn parse(body: &[u8]) -> Result<(Header, &[u8]), Error> {
        // The version first: a newer body may have a different layout altogether.
        let &ver = body.first().ok_or(Error::Truncated)?;
        if ver != BODY_VERSION {
            return Err(Error::UnknownVersion(ver));
        }
        if body.len() < HEADER_LEN {
            return Err(Error::Truncated);
        }
        let header = Header {
            kind: Kind::from_byte(body[1])?,
            epoch: u32::from_be_bytes(body[2..6].try_into().unwrap()),
            session: body[6..22].try_into().unwrap(),
            seq: u64::from_be_bytes(body[22..30].try_into().unwrap()),
        };
        Ok((header, &body[HEADER_LEN..]))
    }
}

// --- Device <-> device: messages (raw deflate of JSON) ---

/// Errors one device reports to another.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The receiver met a version, kind, message, field or enum value it doesn't know; it pauses
    /// until the person updates the app.
    UpdateNeeded,
    /// The receiver's clock is more than five minutes from the relay's.
    ClockSkew,
    /// Pairing: the person declined the code on the hub, or it didn't match.
    Rejected,
    /// Pairing: a signature didn't verify against the expected key.
    BadSignature,
    /// The hub is already answering another `hub_request`.
    Busy,
    /// A code from a newer build.
    #[serde(other)]
    Unknown,
}

/// A device key the hub vouches for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RosterEntry {
    pub id: Uuid,
    pub key: B64<32>,
}

/// Kind-1 messages, sealed under the library key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum SyncMessage {
    /// First message both ways on a new session. `schema` is the library schema version;
    /// `hub` says whether the sender is the hub; `platform` ([`platform`]) and `app` (its
    /// version) are shown to the person and trusted for nothing else.
    Hello { proto: u32, schema: u32, vector: Vector, hub: bool, platform: String, app: String },
    /// Send me what isn't covered by this vector.
    Pull { vector: Vector },
    /// One batch of an answer to `pull` (or an unasked push). The receiver merges `covers` into
    /// its vector only after applying the batch with `last: true`.
    Changes { groups: Vec<Group>, covers: Vector, last: bool },
    /// The receiver's vector after applying a `last` batch.
    Ack { vector: Vector },
    /// Hub -> devices: the active devices' keys, so a device trusts a new hub or a rekey only
    /// from a key someone holding the library key vouched for, never from the relay alone.
    Roster { hub: Uuid, devices: Vec<RosterEntry> },
    /// Active device -> hub: "make me the main computer" (4.4).
    HubRequest,
    /// Hub -> the asking device: what the person on the hub chose.
    HubAnswer { allow: bool },
    Error { code: ErrorCode },
}

/// Kind-2 messages, not sealed: authenticity comes from the signatures and the code, secrecy of
/// the library key from `sealed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum PairMessage {
    /// New device -> hub. `eph` is X25519, `key` the new device's Ed25519 key.
    PairOffer { device: Uuid, eph: B64<32>, key: B64<32>, sig: B64<64> },
    /// Hub -> new device.
    PairAccept { eph: B64<32>, sig: B64<64> },
    /// Hub -> new device, after the person confirmed the code on the hub.
    PairKey { epoch: u32, sealed: B64<48> },
    /// A device without the current epoch's key -> hub.
    RekeyOffer { device: Uuid, eph: B64<32>, sig: B64<64> },
    RekeyAccept { eph: B64<32>, sig: B64<64> },
    RekeyKey { epoch: u32, sealed: B64<48> },
    Error { code: ErrorCode },
}

/// This build's `hello.platform`: `macos`, `windows`, `linux`, or the system's own lowercase word
/// (`std::env::consts::OS`) elsewhere.
pub fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        "linux" => "linux",
        other if platform_word(other) => other,
        _ => "other",
    }
}

/// A `hello.platform`: one lowercase word of ASCII letters and digits, a letter first, at most
/// [`MAX_HELLO_TEXT`] characters.
pub fn platform_word(text: &str) -> bool {
    text.len() <= MAX_HELLO_TEXT
        && text.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
        && text.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// A `hello.app`: at most [`MAX_HELLO_TEXT`] characters, none of them a control character.
pub fn app_text(text: &str) -> bool {
    text.chars().count() <= MAX_HELLO_TEXT && !text.chars().any(char::is_control)
}

/// An app version as `hello.app` carries it: control characters left out, cut to
/// [`MAX_HELLO_TEXT`] characters.
pub fn hello_app(version: &str) -> String {
    version.chars().filter(|c| !c.is_control()).take(MAX_HELLO_TEXT).collect()
}

/// Raw deflate (no zlib header) of the JSON; the bytes are not canonical, only what they inflate
/// to is.
pub fn encode_payload<T: Serialize>(message: &T) -> Result<Vec<u8>, Error> {
    let json = serde_json::to_vec(message).map_err(|e| Error::Malformed(e.to_string()))?;
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&json).expect("writing to a Vec");
    let out = encoder.finish().expect("writing to a Vec");
    if out.len() > MAX_PAYLOAD {
        return Err(Error::TooLarge);
    }
    Ok(out)
}

/// Inflates at most `MAX_INFLATED` bytes and parses them as JSON.
pub fn inflate_json(payload: &[u8]) -> Result<Value, Error> {
    if payload.len() > MAX_PAYLOAD {
        return Err(Error::TooLarge);
    }
    let mut json = Vec::new();
    DeflateDecoder::new(payload)
        .take(MAX_INFLATED as u64 + 1)
        .read_to_end(&mut json)
        .map_err(|_| Error::Inflate)?;
    if json.len() > MAX_INFLATED {
        return Err(Error::TooLarge);
    }
    serde_json::from_slice(&json).map_err(|e| Error::Malformed(e.to_string()))
}

impl SyncMessage {
    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        encode_payload(self)
    }

    /// Anything this build doesn't know is `update_needed`, never silently dropped: dropping a
    /// field would let the vector cover a change the replica never stored.
    pub fn decode(payload: &[u8]) -> Result<SyncMessage, Error> {
        let value = inflate_json(payload)?;
        let (tag, object) = tagged(&value)?;
        match tag {
            "hello" => keys(object, &["t", "proto", "schema", "vector", "hub", "platform", "app"], "hello")?,
            "pull" | "ack" => keys(object, &["t", "vector"], tag)?,
            "changes" => {
                keys(object, &["t", "groups", "covers", "last"], "changes")?;
                if let Some(Value::Array(groups)) = object.get("groups") {
                    groups.iter().try_for_each(check_group)?;
                }
            }
            "roster" => {
                keys(object, &["t", "hub", "devices"], "roster")?;
                if let Some(Value::Array(devices)) = object.get("devices") {
                    for device in devices {
                        keys(as_object(device)?, &["id", "key"], "roster.devices")?;
                    }
                }
            }
            "hub_request" => keys(object, &["t"], "hub_request")?,
            "hub_answer" => keys(object, &["t", "allow"], "hub_answer")?,
            "error" => keys(object, &["t", "code"], "error")?,
            other => return Err(Error::UnknownMessage(other.to_string())),
        }
        let message = from_value(value)?;
        if let SyncMessage::Hello { platform, app, .. } = &message {
            // The wrong shape is a broken peer, not a newer one.
            if !platform_word(platform) {
                return Err(Error::Malformed(format!("hello.platform {platform:?}")));
            }
            if !app_text(app) {
                return Err(Error::Malformed(format!("hello.app {app:?}")));
            }
        }
        Ok(message)
    }

    /// Splits `groups` into `changes` batches that each deflate under `MAX_PAYLOAD`, in order,
    /// every batch with the same `covers` and only the final one `last`.
    pub fn pack_changes(groups: Vec<Group>, covers: &Vector) -> Result<Vec<Vec<u8>>, Error> {
        let mut out = Vec::new();
        pack(groups, covers, &mut out)?;
        if out.is_empty() {
            out.push(SyncMessage::Changes { groups: Vec::new(), covers: covers.clone(), last: true });
        }
        if let Some(SyncMessage::Changes { last, .. }) = out.last_mut() {
            *last = true;
        }
        out.iter().map(SyncMessage::encode).collect()
    }
}

/// Halves a batch until it fits; deflate ratios vary too much to size batches up front.
fn pack(groups: Vec<Group>, covers: &Vector, out: &mut Vec<SyncMessage>) -> Result<(), Error> {
    if groups.is_empty() {
        return Ok(());
    }
    let batch = SyncMessage::Changes { groups, covers: covers.clone(), last: false };
    match batch.encode() {
        Ok(_) => {
            out.push(batch);
            Ok(())
        }
        Err(Error::TooLarge) => {
            let SyncMessage::Changes { mut groups, .. } = batch else { unreachable!() };
            if groups.len() == 1 {
                return Err(Error::TooLarge);
            }
            let tail = groups.split_off(groups.len() / 2);
            pack(groups, covers, out)?;
            pack(tail, covers, out)
        }
        Err(other) => Err(other),
    }
}

impl PairMessage {
    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        encode_payload(self)
    }

    pub fn decode(payload: &[u8]) -> Result<PairMessage, Error> {
        let value = inflate_json(payload)?;
        let (tag, object) = tagged(&value)?;
        let allowed: &[&str] = match tag {
            "pair_offer" => &["t", "device", "eph", "key", "sig"],
            "rekey_offer" => &["t", "device", "eph", "sig"],
            "pair_accept" | "rekey_accept" => &["t", "eph", "sig"],
            "pair_key" | "rekey_key" => &["t", "epoch", "sealed"],
            "error" => &["t", "code"],
            other => return Err(Error::UnknownMessage(other.to_string())),
        };
        keys(object, allowed, tag)?;
        from_value(value)
    }
}

fn from_value<T: DeserializeOwned>(value: Value) -> Result<T, Error> {
    serde_json::from_value(value).map_err(|e| Error::Malformed(e.to_string()))
}

fn as_object(value: &Value) -> Result<&Map<String, Value>, Error> {
    value.as_object().ok_or_else(|| Error::Malformed("expected an object".into()))
}

fn tagged(value: &Value) -> Result<(&str, &Map<String, Value>), Error> {
    let object = as_object(value)?;
    let tag = object.get("t").and_then(Value::as_str).ok_or_else(|| Error::Malformed("no t".into()))?;
    Ok((tag, object))
}

fn keys(object: &Map<String, Value>, allowed: &[&str], context: &str) -> Result<(), Error> {
    match object.keys().find(|key| !allowed.contains(&key.as_str())) {
        Some(key) => Err(Error::UnknownField(format!("{context}.{key}"))),
        None => Ok(()),
    }
}

/// `model::Group` ignores unknown keys and would fail an unknown entity as malformed; here both,
/// and a synced field name this build doesn't have, are `update_needed`.
fn check_group(group: &Value) -> Result<(), Error> {
    let object = as_object(group)?;
    keys(object, &["entity", "uid", "fields", "gone"], "group")?;
    let entity = object.get("entity").and_then(Value::as_str).unwrap_or_default();
    let known: Option<&[&str]> = match entity {
        "bookmark" => Some(&BOOKMARK_FIELDS),
        "collection" => Some(&COLLECTION_FIELDS),
        "tag" => Some(&TAG_FIELDS),
        // A link's fields are tag uids.
        "link" => None,
        other => return Err(Error::UnknownField(format!("entity {other:?}"))),
    };
    if let Some(Value::Array(fields)) = object.get("fields") {
        for change in fields {
            let change = as_object(change)?;
            keys(change, &["field", "value", "clock"], "field")?;
            if let Some(clock) = change.get("clock") {
                keys(as_object(clock)?, &["hlc", "replica", "counter"], "clock")?;
            }
            let name = change.get("field").and_then(Value::as_str).unwrap_or_default();
            let fine = match known {
                Some(names) => names.contains(&name),
                None => Uuid::parse_str(name).is_ok(),
            };
            if !fine {
                return Err(Error::UnknownField(format!("{entity}.{name}")));
            }
        }
    }
    if let Some(gone) = object.get("gone").filter(|gone| !gone.is_null()) {
        let gone = as_object(gone)?;
        keys(gone, &["clock", "merged_into"], "gone")?;
        if let Some(clock) = gone.get("clock") {
            keys(as_object(clock)?, &["hlc", "replica", "counter"], "clock")?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Clock, Entity, FieldChange, Hlc};
    use serde_json::json;

    fn id(n: u8) -> Uuid {
        Uuid::from_bytes([n; 16])
    }

    fn deflate(value: &Value) -> Vec<u8> {
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(value.to_string().as_bytes()).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn addresses_have_two_reserved_values() {
        assert_eq!(Address::from_bytes([0; 16]), Address::Hub);
        assert_eq!(Address::from_bytes([0xFF; 16]), Address::All);
        assert_eq!(Address::from_bytes([7; 16]), Address::Device(id(7)));
        assert_eq!(Address::All.as_uuid().to_string(), "ffffffff-ffff-ffff-ffff-ffffffffffff");
    }

    #[test]
    fn frames_round_trip_and_refuse_garbage() {
        let frame = encode_outgoing(Address::Device(id(3)), b"body").unwrap();
        assert_eq!(decode_outgoing(&frame).unwrap(), (Address::Device(id(3)), &b"body"[..]));
        assert_eq!(decode_outgoing(&frame[..10]), Err(Error::Truncated));
        assert_eq!(decode_outgoing(&[2; 20]), Err(Error::FrameType(2)));
        assert_eq!(encode_outgoing(Address::All, &vec![0; MAX_BODY + 1]), Err(Error::TooLarge));

        let frame = encode_delivered(id(4), 1_760_400_000_000, b"x").unwrap();
        let delivered = decode_delivered(&frame).unwrap();
        assert_eq!((delivered.from, delivered.relay_ms, delivered.body), (id(4), 1_760_400_000_000, &b"x"[..]));
    }

    #[test]
    fn a_newer_body_is_update_needed() {
        let header = Header { kind: Kind::Sync, epoch: 1, session: [9; 16], seq: 5 };
        let mut body = header.encode().to_vec();
        assert_eq!(Header::parse(&body).unwrap(), (header, &[][..]));
        body[1] = 3;
        assert!(Header::parse(&body).unwrap_err().update_needed());
        body[0] = 2;
        assert_eq!(Header::parse(&body), Err(Error::UnknownVersion(2)));
        assert_eq!(Header::parse(&[1, 1, 0]), Err(Error::Truncated));
    }

    #[test]
    fn control_ignores_unknown_fields_but_names_unknown_messages() {
        let text = r#"{"t":"presence","device":"01010101-0101-0101-0101-010101010101","online":true,"extra":1}"#;
        assert_eq!(decode_control(text).unwrap(), Control::Presence { device: id(1), online: true });
        assert_eq!(decode_control(r#"{"t":"later"}"#), Err(Error::UnknownMessage("later".into())));
        assert!(matches!(decode_control(r#"{"t":"presence"}"#), Err(Error::Malformed(_))));
        let undeliverable = Control::Undeliverable { to: Address::Hub.as_uuid() };
        assert_eq!(decode_control(&encode_control(&undeliverable)).unwrap(), undeliverable);
    }

    #[test]
    fn sync_messages_round_trip() {
        let clock = Clock { hlc: Hlc::new(10, 0), replica: id(1), counter: 1 };
        let mut covers = Vector::default();
        covers.0.insert(id(1), 1);
        let message = SyncMessage::Changes {
            groups: vec![Group {
                entity: Entity::Bookmark,
                uid: id(2),
                fields: vec![FieldChange { field: "title".into(), value: json!("A"), clock }],
                gone: None,
            }],
            covers,
            last: true,
        };
        assert_eq!(SyncMessage::decode(&message.encode().unwrap()).unwrap(), message);
        let error = SyncMessage::Error { code: ErrorCode::ClockSkew };
        assert_eq!(SyncMessage::decode(&error.encode().unwrap()).unwrap(), error);
        for message in [SyncMessage::HubRequest, SyncMessage::HubAnswer { allow: true }, SyncMessage::Error { code: ErrorCode::Busy }] {
            assert_eq!(SyncMessage::decode(&message.encode().unwrap()).unwrap(), message);
        }
        assert_eq!(inflate_json(&SyncMessage::HubRequest.encode().unwrap()).unwrap(), json!({"t": "hub_request"}));
        let busy = SyncMessage::Error { code: ErrorCode::Busy };
        assert_eq!(inflate_json(&busy.encode().unwrap()).unwrap(), json!({"t": "error", "code": "busy"}));
        let extra = deflate(&json!({"t": "hub_answer", "allow": true, "why": "later"}));
        assert!(SyncMessage::decode(&extra).unwrap_err().update_needed());
    }

    #[test]
    fn a_welcome_names_the_latest_start_over_only_once_there_was_one() {
        let welcome = |started_over| Control::Welcome {
            status: DeviceStatus::Pending,
            hub: id(1),
            epoch: 4,
            devices: Vec::new(),
            online: Vec::new(),
            time: 5,
            started_over,
        };
        assert!(!encode_control(&welcome(None)).contains("started_over"));
        let text = r#"{"t":"welcome","status":"pending","hub":"01010101-0101-0101-0101-010101010101","epoch":4,
            "devices":[],"online":[],"time":5,"started_over":{"by":"01010101-0101-0101-0101-010101010101","at":3,"epoch":4}}"#;
        assert_eq!(decode_control(text).unwrap(), welcome(Some(StartedOver { by: id(1), at: 3, epoch: 4 })));
        let start = Control::StartOver { token: "jwt".into() };
        assert_eq!(encode_control(&start), r#"{"t":"start_over","token":"jwt"}"#);
        assert_eq!(decode_control(&encode_control(&start)).unwrap(), start);
    }

    #[test]
    fn anything_unknown_in_sync_is_update_needed() {
        let clock = json!({"hlc": 1, "replica": id(1), "counter": 1});
        let cases = [
            json!({"t": "merge", "vector": {}}),
            json!({"t": "pull", "vector": {}, "since": 3}),
            json!({"t": "changes", "covers": {}, "last": true,
                   "groups": [{"entity": "note", "uid": id(2)}]}),
            json!({"t": "changes", "covers": {}, "last": true,
                   "groups": [{"entity": "bookmark", "uid": id(2), "pinned": true}]}),
            json!({"t": "changes", "covers": {}, "last": true,
                   "groups": [{"entity": "tag", "uid": id(2),
                               "fields": [{"field": "color", "value": "red", "clock": clock}]}]}),
            json!({"t": "changes", "covers": {}, "last": true,
                   "groups": [{"entity": "link", "uid": id(2),
                               "fields": [{"field": "not-a-uid", "value": true, "clock": clock}]}]}),
        ];
        for case in cases {
            let error = SyncMessage::decode(&deflate(&case)).unwrap_err();
            assert!(error.update_needed(), "{case}: {error}");
        }
        // A wrong type is a broken peer, not a newer one.
        let error = SyncMessage::decode(&deflate(&json!({"t": "pull", "vector": 5}))).unwrap_err();
        assert!(!error.update_needed());
        // An unknown error code still decodes: codes may grow without forcing updates.
        let error = SyncMessage::decode(&deflate(&json!({"t": "error", "code": "later"}))).unwrap();
        assert_eq!(error, SyncMessage::Error { code: ErrorCode::Unknown });
    }

    #[test]
    fn hello_names_the_platform_and_app_in_a_checked_shape() {
        let hello = |platform: &str, app: &str| SyncMessage::Hello {
            proto: 1,
            schema: 10,
            vector: Vector::default(),
            hub: false,
            platform: platform.into(),
            app: app.into(),
        };
        let fine = hello("macos", "0.13.0");
        assert_eq!(SyncMessage::decode(&fine.encode().unwrap()).unwrap(), fine);
        let longest = hello("freebsd", &"9".repeat(MAX_HELLO_TEXT));
        assert_eq!(SyncMessage::decode(&longest.encode().unwrap()).unwrap(), longest);
        for wrong in [
            hello("", "0.13.0"),
            hello("macOS", "0.13.0"),
            hello("mac os", "0.13.0"),
            hello("9front", "0.13.0"),
            hello(&"a".repeat(MAX_HELLO_TEXT + 1), "0.13.0"),
            hello("linux", &"9".repeat(MAX_HELLO_TEXT + 1)),
            hello("linux", "0.13\n"),
        ] {
            let error = SyncMessage::decode(&wrong.encode().unwrap()).unwrap_err();
            assert!(matches!(error, Error::Malformed(_)), "{wrong:?}: {error}");
        }
        // Both are required: a hello without them is broken, not newer.
        let missing = deflate(&json!({"t": "hello", "proto": 1, "schema": 10, "vector": {}, "hub": false}));
        assert!(matches!(SyncMessage::decode(&missing), Err(Error::Malformed(_))));
        let extra = deflate(&json!({"t": "hello", "proto": 1, "schema": 10, "vector": {}, "hub": false,
                                    "platform": "linux", "app": "1", "arch": "arm64"}));
        assert!(SyncMessage::decode(&extra).unwrap_err().update_needed());
    }

    #[test]
    fn this_build_names_its_platform_and_cuts_its_version() {
        assert!(platform_word(platform()));
        if cfg!(target_os = "macos") {
            assert_eq!(platform(), "macos");
        }
        assert_eq!(hello_app("0.13.0"), "0.13.0");
        assert_eq!(hello_app("0.13\n.0"), "0.13.0");
        assert_eq!(hello_app(&"1".repeat(40)).chars().count(), MAX_HELLO_TEXT);
        assert!(app_text(&hello_app(&"é".repeat(40))));
    }

    #[test]
    fn inflating_is_capped() {
        let bomb = deflate(&Value::String("a".repeat(MAX_INFLATED + 10)));
        assert!(bomb.len() < MAX_PAYLOAD);
        assert_eq!(inflate_json(&bomb), Err(Error::TooLarge));
        assert_eq!(inflate_json(b"\xff\xff\xff"), Err(Error::Inflate));
    }

    #[test]
    fn large_answers_split_into_batches_that_fit() {
        // Notes of random-looking text barely deflate, so 4000 of them need several batches.
        let mut seed = 1u64;
        let mut noise = || {
            (0..400)
                .map(|_| {
                    seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                    char::from(b'!' + (seed >> 58) as u8)
                })
                .collect::<String>()
        };
        let groups: Vec<Group> = (0..4000u32)
            .map(|n| Group {
                entity: Entity::Bookmark,
                uid: Uuid::from_u128(u128::from(n) + 1),
                fields: vec![FieldChange {
                    field: "notes".into(),
                    value: json!(noise()),
                    clock: Clock { hlc: Hlc::new(1, 0), replica: id(1), counter: u64::from(n) + 1 },
                }],
                gone: None,
            })
            .collect();
        let covers = Vector::default();
        let frames = SyncMessage::pack_changes(groups.clone(), &covers).unwrap();
        assert!(frames.len() > 1);
        let mut seen = Vec::new();
        for (n, frame) in frames.iter().enumerate() {
            assert!(frame.len() <= MAX_PAYLOAD);
            let SyncMessage::Changes { groups, last, .. } = SyncMessage::decode(frame).unwrap() else { panic!() };
            assert_eq!(last, n == frames.len() - 1);
            seen.extend(groups);
        }
        assert_eq!(seen, groups);
        assert_eq!(SyncMessage::pack_changes(Vec::new(), &covers).unwrap().len(), 1);
    }

    #[test]
    fn pairing_messages_round_trip() {
        let offer = PairMessage::PairOffer { device: id(1), eph: B64([2; 32]), key: B64([3; 32]), sig: B64([4; 64]) };
        assert_eq!(PairMessage::decode(&offer.encode().unwrap()).unwrap(), offer);
        let extra = deflate(&json!({"t": "pair_key", "epoch": 1, "sealed": "", "hint": 1}));
        assert!(PairMessage::decode(&extra).unwrap_err().update_needed());
        let short = deflate(&json!({"t": "pair_accept", "eph": "AAAA", "sig": "AAAA"}));
        assert!(matches!(PairMessage::decode(&short), Err(Error::Malformed(_))));
    }
}
