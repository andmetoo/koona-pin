//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! A device's side of sync v1 (`PROTOCOL.md`) as a state machine with no sockets and no clock of
//! its own: the caller feeds it what the relay sent, timer ticks and the person's actions, with
//! the time, and carries out the effects it returns (frames to send, what the interface shows).
//! The library is passed in on every call ([`Library`]), so the session never holds the database.
//!
//! Randomness comes from the `SecureRandom` given to [`Session::new`]; everything else is a
//! function of the inputs.

use crate::crypto::{self, CryptoError, Ephemeral, Exchange, LibraryKey, Party, ReplayGuard, Sealer};
use crate::library::{Library, Meta, Roster, SCHEMA};
use crate::model::{Group, Vector};
use crate::protocol::{
    self, close, relay_error, Address, Control, DeviceInfo, DeviceStatus, ErrorCode, Header, Kind, PairMessage,
    RosterEntry, StartedOver, SyncMessage, B64, MAX_PAYLOAD, PROTO,
};
use crate::{Applied, Cursor};
use ring::rand::SecureRandom;
use ring::signature::Ed25519KeyPair;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use uuid::Uuid;

/// A pairing not approved by then is abandoned by both sides.
pub const PAIRING_TIMEOUT_MS: u64 = 5 * 60 * 1000;
/// At most this many pairing attempts in any [`PAIRING_TIMEOUT_MS`]: offers a device sends, and
/// offers a hub answers (all devices together, an approved pairing not counted). Each attempt
/// gives a relay in between one chance in 10^6 that the two codes match; without a cap it could
/// abort and retry unseen until they did (4.2).
pub const MAX_PAIRING_ATTEMPTS: usize = 3;
/// A pairing offer whose `pair_reveal` doesn't come by then frees the hub for others, and the
/// device is told. The reveal follows `pair_accept` at once, and until it comes the hub shows
/// nothing to Reject (4.2); this leaves room for a client backing off 30 s after a 4008.
pub const REVEAL_TIMEOUT_MS: u64 = 2 * 60 * 1000;
/// A `hub_request` not answered by then is given up on both sides (4.4).
pub const HUB_REQUEST_TIMEOUT_MS: u64 = 5 * 60 * 1000;
/// How long the key of the previous epoch still opens frames after a rotation.
pub const OLD_KEY_MS: u64 = 60 * 1000;
/// An answer whose `ack` doesn't come by then counts as lost; a later change is pushed again.
pub const ACK_TIMEOUT_MS: u64 = 60 * 1000;
/// A rekey that got no answer is asked again after this.
pub const REKEY_RETRY_MS: u64 = 30 * 1000;
/// A peer whose clock was off is greeted again after this: its answer's `relay_ms` rechecks
/// its clock, and nothing else would reach it while it can't sync.
pub const SKEW_RETRY_MS: u64 = 60 * 1000;
/// Pulls in a row after an answer that left something out (deferred changes or a gap).
const MAX_REPULLS: u32 = 3;
/// Received groups held before one transaction applies them ([`Config::hold_groups`]): every
/// commit writes the index pages it touched again, so a 100 000-bookmark snapshot took 27 s
/// applied chunk by chunk and 12.5 s held like this (`sync_library::Receiving` in the app).
/// About 27 MB of JSON; a small push (one chunk, `last`) is applied at once. Held groups lost
/// with the connection come again: the vector is merged only after the last chunk.
pub const HOLD_GROUPS: usize = 20_000;
/// The close reason of a 4008 that no waiting cures: the account has too many devices.
pub const DEVICE_LIMIT: &str = "device_limit";
/// The relay keeps at most this many UTF-16 code units of a device name.
pub const MAX_NAME_UTF16: usize = 128;
/// Batches handed out per [`Input::Pump`], so incoming frames are read between them.
const BATCHES_PER_PUMP: usize = 4;
/// Engine chunks read from the library per call: each call scans the delta's keys again.
const CHUNKS_PER_PAGE: usize = 4;

pub struct Config {
    pub device: Uuid,
    /// The device's Ed25519 key (from the OS keychain).
    pub device_key: Ed25519KeyPair,
    /// The account: the JWT's `sub`, signed into the relay `hello`.
    pub sub: String,
    pub name: String,
    /// The app version, for the relay's directory and the sync `hello`.
    pub app: String,
    /// This build's platform for the sync `hello` ([`protocol::platform`]).
    pub platform: String,
    /// The library schema version, `hello.schema`.
    pub schema: u32,
    /// JSON bytes per engine chunk; each deflates to well under a batch.
    pub chunk_bytes: usize,
    /// Groups received before they are applied, unless the answer ends first ([`HOLD_GROUPS`]).
    pub hold_groups: usize,
}

impl Config {
    pub fn new(device: Uuid, device_key: Ed25519KeyPair, sub: String, name: String, app: String) -> Config {
        Config {
            device,
            device_key,
            sub,
            name,
            app,
            platform: protocol::platform().to_string(),
            schema: SCHEMA,
            chunk_bytes: 2 << 20,
            hold_groups: HOLD_GROUPS,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PauseReason {
    /// This device's clock is more than five minutes off the relay's.
    ClockSkew,
    /// A peer or the relay speaks a newer protocol or schema: the person updates the app.
    UpdateNeeded,
    /// This device was removed; it forgot the library key.
    Revoked,
    /// The plan has no sync, the lease is gone, or the account is not in the beta.
    Plan,
    /// The account has the most devices the relay allows (4008 `device_limit`).
    DeviceLimit,
    Offline,
    /// The account was started over from another device (2.6): nothing is offered to its new
    /// hub until the person joins again ([`Action::JoinAgain`]).
    StartedOver,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Connecting,
    /// Registered, waiting to be paired from the hub.
    Pending,
    Online,
    /// `done` of about `total` changes moved in the transfers under way, both directions.
    Syncing { done: u64, total: u64 },
    Paused { reason: PauseReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// The new device, asking for the key.
    Asking,
    /// The hub, which approves.
    Hub,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairingFailure {
    /// The person declined on the hub, or the hub is busy with another device.
    Rejected,
    BadSignature,
    Timeout,
    /// The hub is not online.
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingEvent {
    /// The new device sent its offer: "Confirm on <hub_name>".
    Waiting { hub: Uuid, hub_name: String },
    /// Show the six digits; on the hub with Approve / Reject. Tell the person to compare them.
    Code { role: Role, peer: Uuid, peer_name: String, code: String },
    /// The new device holds the library key; on the hub, the device was approved.
    Paired { peer: Uuid },
    /// On the hub: the device asked again, so the code shown for it is void; hide it.
    Withdrawn { peer: Uuid },
    /// On the hub with `BadSignature`, a warning for a pairing that goes on waiting: a reveal
    /// came that didn't match the offer (4.2).
    Failed { peer: Uuid, reason: PairingFailure },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HubChangeFailure {
    /// The person on the hub denied it.
    Denied,
    /// No answer within [`HUB_REQUEST_TIMEOUT_MS`].
    Timeout,
    /// The hub is not online, or went away before it answered.
    Unavailable,
    /// The hub is answering another device's request.
    Busy,
}

/// A change of the hub (4.4), on the device that asks and on the hub.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HubChangeEvent {
    /// This device asked: "Waiting for <hub_name>".
    Waiting { hub: Uuid, hub_name: String },
    /// On the hub: "Make <name> the main computer?" with Allow / Deny.
    Asked { device: Uuid, name: String },
    /// Over without a failure: this device became the hub, or the hub answered or forgot it.
    Settled { peer: Uuid },
    Failed { peer: Uuid, reason: HubChangeFailure },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionError {
    /// The relay refused a request (`relay_error`).
    Relay(String),
    Library(String),
    /// A peer reported an error.
    Peer { device: Uuid, code: ErrorCode },
    /// The relay names a hub this device has no pinned key for.
    UntrustedHub(Uuid),
    /// The action needs a state this device isn't in (not the hub, not pending…).
    NotAllowed(&'static str),
}

/// Why a frame was dropped; for logs and tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropReason {
    Malformed,
    Unauthentic,
    Replayed,
    /// Sealed under an epoch whose key this device doesn't hold.
    UnknownEpoch,
    /// Changes while this device's clock is off.
    ClockSkew,
    /// Not expected from this sender now.
    Unexpected,
    BadSignature,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    SendText(String),
    SendBinary(Vec<u8>),
    Status(Phase),
    Pairing(PairingEvent),
    HubChange(HubChangeEvent),
    /// The account was started over from `by` (named `by_name` in the new directory) at `at`,
    /// to `epoch`: this device holds until the person joins again.
    StartedOver { by: Uuid, by_name: Option<String>, at: u64, epoch: u32 },
    /// Remote changes were written: the interface reads these again.
    LibraryChanged(Applied),
    /// The relay's directory as last seen.
    Devices { devices: Vec<DeviceInfo>, online: Vec<Uuid>, hub: Option<Uuid> },
    Error(SessionError),
    Dropped { from: Uuid, reason: DropReason },
    /// A peer's sync `hello`: what it runs, as it says.
    PeerHello { device: Uuid, platform: String, app: String },
    /// A transfer with the peer finished: an answer or a push from it applied up to its `last`
    /// batch, or one of this device's acknowledged.
    Synced { peer: Uuid },
    /// This device's clock minus the relay's, ms, from the relay's `challenge`.
    ClockOffset(i64),
    /// The newest library key this device holds is now of this epoch (none: no key).
    KeyEpoch(Option<u32>),
    /// The peer whose newer protocol or schema pauses this device for an update; none once no
    /// peer does.
    UpdateFrom(Option<Uuid>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// On a pending device: send the pairing offer to the hub.
    StartPairing,
    /// On the hub, after the person compared the digits.
    ApprovePairing { device: Uuid },
    RejectPairing { device: Uuid },
    /// On an active device other than the hub: ask the hub to hand over to this one (4.4).
    RequestHub,
    /// On the hub: the person's answer to the `hub_request` shown.
    AnswerHubRequest { allow: bool },
    /// Start the account over from this device (2.6), with the access token of a sign-in by
    /// email code just now; sent once the relay welcomed this device.
    StartOver { token: String },
    /// After the account was started over elsewhere: pair with its new hub, keeping the library.
    JoinAgain,
    /// On the hub: revoke the device and rotate the library key.
    RemoveDevice { device: Uuid },
    Rename { device: Uuid, name: String },
    /// Say `hello` again to every sync peer: a full exchange of vectors.
    SyncNow,
    /// The library changed locally: push it.
    LocalChange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Input<'a> {
    /// The socket is being opened.
    Dialing,
    /// The socket is open; the relay's `challenge` comes next.
    Connected,
    Text(&'a str),
    Binary(&'a [u8]),
    /// The socket closed, with the close code and reason if there were any.
    Closed { code: Option<u16>, reason: Option<&'a str> },
    /// About once a second.
    Tick,
    /// Hand out the next batches of answers under way; see [`Session::wants_pump`].
    Pump,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Link {
    Down,
    Dialing,
    /// Open, before `welcome`.
    Open,
    Ready,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PeerPause {
    /// The peer is newer: this device needs an update.
    UpdateNeeded,
    /// The peer said it can't read us.
    Outdated,
    /// The peer's clock is off.
    Skewed,
}

/// An answer coming in from a peer.
#[derive(Debug, Default)]
struct Incoming {
    /// The peer's session when it began; a change means the rest may never come.
    session: Option<[u8; 16]>,
    done: u64,
    total: u64,
    deferred: usize,
    broken: bool,
    /// The highest counter per replica among the changes received, to see a gap.
    seen: BTreeMap<Uuid, u64>,
    /// Groups received and not applied yet ([`HOLD_GROUPS`]).
    held: Vec<Group>,
}

/// An answer (or a push) going out to a peer, read from the library a page at a time.
#[derive(Debug)]
struct Outgoing {
    since: Vector,
    covers: Option<Vector>,
    cursor: Option<Cursor>,
    /// Payloads ready to seal, with their number of groups.
    queue: VecDeque<(Vec<u8>, u64)>,
    finished: bool,
    sent: u64,
    remaining: u64,
}

#[derive(Debug, Default)]
struct Peer {
    session: Option<[u8; 16]>,
    said_hello: bool,
    /// A `hello` or `pull` came from it: changes are pushed to it.
    synced: bool,
    /// What it holds at least, from its hello, pull, ack and covers.
    known: Vector,
    pause: Option<PeerPause>,
    paused_at: u64,
    incoming: Option<Incoming>,
    outgoing: Option<Outgoing>,
    /// A change to push once the answer under way is acknowledged.
    dirty: bool,
    ack_since: Option<u64>,
    repulls: u32,
}

/// The new device's side of a pairing.
struct Asking {
    hub: Uuid,
    hub_key: [u8; 32],
    hub_name: String,
    party: Party,
    /// What the offer committed to; `party.eph` is revealed only after the hub's `pair_accept`.
    commit: [u8; 32],
    eph: Option<Ephemeral>,
    exchange_key: Option<[u8; 32]>,
    started: u64,
}

/// The hub's side of a pairing.
struct Hosting {
    device: Uuid,
    key: [u8; 32],
    commit: [u8; 32],
    /// Its own X25519 key, sent in `pair_accept`; spent when the reveal arrives.
    eph: Option<Ephemeral>,
    hub_eph: [u8; 32],
    /// Once the reveal matched the commitment and the code is shown.
    exchange_key: Option<[u8; 32]>,
    /// A reveal that didn't match the commitment came: someone is in between.
    tampered: bool,
    started: u64,
}

impl Hosting {
    /// Still waiting for `pair_reveal` after [`REVEAL_TIMEOUT_MS`]: no longer holds the hub.
    fn awaits_reveal_past(&self, now: u64) -> bool {
        self.exchange_key.is_none() && now >= self.started + REVEAL_TIMEOUT_MS
    }
}

/// A device without the current key asking the hub for it.
struct Rekeying {
    hub: Uuid,
    hub_key: [u8; 32],
    party: Party,
    eph: Option<Ephemeral>,
    exchange_key: Option<[u8; 32]>,
    started: u64,
}

pub struct Session {
    cfg: Config,
    rng: Box<dyn SecureRandom + Send + Sync>,
    public: [u8; 32],
    fx: Vec<Effect>,
    link: Link,
    stop: Option<PauseReason>,
    status: Option<DeviceStatus>,
    hub: Option<Uuid>,
    relay_epoch: u32,
    devices: BTreeMap<Uuid, DeviceInfo>,
    online: BTreeSet<Uuid>,
    skewed: bool,
    meta: Meta,
    /// Library keys by epoch, with when an older one stops opening frames.
    keys: BTreeMap<u32, (LibraryKey, Option<u64>)>,
    sealer: Sealer,
    /// The epoch the sealer seals under; `None` while this device holds no key (pairing only).
    sealer_epoch: Option<u32>,
    guard: ReplayGuard,
    peers: BTreeMap<Uuid, Peer>,
    asking: Option<Asking>,
    hosting: Option<Hosting>,
    rekey: Option<Rekeying>,
    /// The device just approved: the roster goes out once the relay reports it active.
    roster_for: Option<Uuid>,
    /// The `hub_request` this device sent: to which hub, and when.
    hub_asking: Option<(Uuid, u64)>,
    /// The hub that handed over to this device: its `hub_answer{allow: true}` follows the
    /// relay's `account` (it sends `set_hub` first) and is expected, not a drop.
    handed_over_by: Option<Uuid>,
    /// On the hub: the device whose `hub_request` the person is asked about, and since when.
    hub_asked: Option<(Uuid, u64)>,
    /// `start_over` to send once the relay welcomes this device.
    start_over_token: Option<String>,
    /// `start_over` went out: the 4005 that follows is this device's own.
    starting_over: bool,
    /// The account was started over elsewhere: held until the person joins again. Kept across
    /// connections, unlike the rest of the relay's state.
    held: bool,
    /// The person chose to join again: a `welcome` that would hold doesn't.
    joining: bool,
    phase: Option<Phase>,
    /// The key epoch and the newer peer last reported ([`Effect::KeyEpoch`], [`Effect::UpdateFrom`]).
    shown_epoch: Option<Option<u32>>,
    shown_update_from: Option<Uuid>,
    /// Pairing attempts within the last [`PAIRING_TIMEOUT_MS`] ([`MAX_PAIRING_ATTEMPTS`]): when
    /// each went out, and on the hub to which device. Kept across connections.
    attempts: VecDeque<(u64, Option<Uuid>)>,
    /// On the hub: until when the person was already warned about too many attempts.
    attempts_warned_until: u64,
    now: u64,
}

fn rng_failed() -> ! {
    // The system random source failing leaves nothing safe to do.
    panic!("the system random source failed")
}

/// A name cut to what the relay keeps, at a character boundary.
pub fn device_name(name: &str) -> String {
    let mut units = 0;
    name.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= MAX_NAME_UTF16
        })
        .collect()
}

fn code_text(code: u32) -> String {
    format!("{code:06}")
}

/// `local - relay`, ms, saturating.
fn clock_offset(local: u64, relay: u64) -> i64 {
    let offset = i128::from(local) - i128::from(relay);
    offset.clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64
}

impl Session {
    pub fn new(cfg: Config, rng: Box<dyn SecureRandom + Send + Sync>) -> Session {
        let public = crypto::public_key(&cfg.device_key);
        let sealer = Sealer::new([0; 32], 0, cfg.device, rng.as_ref()).unwrap_or_else(|_| rng_failed());
        Session {
            cfg,
            rng,
            public,
            fx: Vec::new(),
            link: Link::Down,
            stop: None,
            status: None,
            hub: None,
            relay_epoch: 0,
            devices: BTreeMap::new(),
            online: BTreeSet::new(),
            skewed: false,
            meta: Meta::default(),
            keys: BTreeMap::new(),
            sealer,
            sealer_epoch: None,
            guard: ReplayGuard::default(),
            peers: BTreeMap::new(),
            asking: None,
            hosting: None,
            rekey: None,
            roster_for: None,
            hub_asking: None,
            handed_over_by: None,
            hub_asked: None,
            attempts: VecDeque::new(),
            attempts_warned_until: 0,
            start_over_token: None,
            starting_over: false,
            held: false,
            joining: false,
            phase: None,
            shown_epoch: None,
            shown_update_from: None,
            now: 0,
        }
    }

    pub fn device(&self) -> Uuid {
        self.cfg.device
    }

    pub fn is_hub(&self) -> bool {
        self.hub == Some(self.cfg.device)
    }

    pub fn hub(&self) -> Option<Uuid> {
        self.hub
    }

    /// The account's devices with a connection open, this one included (at least 1): they share
    /// the relay's rate limits.
    pub fn devices_online(&self) -> usize {
        let others = self.online.iter().filter(|d| **d != self.cfg.device).count();
        others + 1
    }

    /// The relay's epoch and the newest library key epoch this device holds.
    pub fn epochs(&self) -> (u32, Option<u32>) {
        (self.relay_epoch, self.keys.keys().next_back().copied())
    }

    pub fn phase(&self) -> Phase {
        self.compute_phase()
    }

    /// Whether answers are waiting to go out: feed [`Input::Pump`] until it says no, reading the
    /// socket in between.
    pub fn wants_pump(&self) -> bool {
        self.link == Link::Ready && self.peers.values().any(|p| p.outgoing.is_some())
    }

    pub fn handle(&mut self, lib: &mut dyn Library, now: u64, input: Input<'_>) -> Vec<Effect> {
        self.now = now;
        match input {
            Input::Dialing => {
                if self.link == Link::Down {
                    self.link = Link::Dialing;
                }
            }
            Input::Connected => self.on_connected(lib),
            Input::Text(text) => self.on_text(lib, text),
            Input::Binary(frame) => self.on_binary(lib, frame),
            Input::Closed { code, reason } => self.on_closed(lib, code, reason),
            Input::Tick => self.on_tick(lib),
            Input::Pump => self.pump(lib),
        }
        self.update_phase();
        std::mem::take(&mut self.fx)
    }

    pub fn act(&mut self, lib: &mut dyn Library, now: u64, action: Action) -> Vec<Effect> {
        self.now = now;
        self.on_action(lib, action);
        self.update_phase();
        std::mem::take(&mut self.fx)
    }

    // --- Phase ---

    fn compute_phase(&self) -> Phase {
        if let Some(reason) = self.stop {
            return Phase::Paused { reason };
        }
        if self.held {
            return Phase::Paused { reason: PauseReason::StartedOver };
        }
        match self.link {
            Link::Down => return Phase::Paused { reason: PauseReason::Offline },
            Link::Dialing | Link::Open => return Phase::Connecting,
            Link::Ready => {}
        }
        if self.status == Some(DeviceStatus::Pending) {
            return Phase::Pending;
        }
        if self.skewed {
            return Phase::Paused { reason: PauseReason::ClockSkew };
        }
        if self.peers.values().any(|p| p.pause == Some(PeerPause::UpdateNeeded)) {
            return Phase::Paused { reason: PauseReason::UpdateNeeded };
        }
        let (mut done, mut total, mut busy) = (0, 0, false);
        for peer in self.peers.values() {
            if let Some(i) = &peer.incoming {
                busy = true;
                done += i.done;
                total += i.total.max(i.done);
            }
            if let Some(o) = &peer.outgoing {
                busy = true;
                done += o.sent;
                total += o.sent + o.queue.iter().map(|q| q.1).sum::<u64>() + o.remaining;
            }
        }
        if busy {
            Phase::Syncing { done, total }
        } else {
            Phase::Online
        }
    }

    /// The peer that pauses this device for an update, if a peer does.
    pub fn update_from(&self) -> Option<Uuid> {
        self.peers.iter().find(|(_, p)| p.pause == Some(PeerPause::UpdateNeeded)).map(|(id, _)| *id)
    }

    fn update_phase(&mut self) {
        let epoch = self.newest_epoch();
        if self.shown_epoch != Some(epoch) {
            self.shown_epoch = Some(epoch);
            self.fx.push(Effect::KeyEpoch(epoch));
        }
        let from = self.update_from();
        if self.shown_update_from != from {
            self.shown_update_from = from;
            self.fx.push(Effect::UpdateFrom(from));
        }
        let phase = self.compute_phase();
        if self.phase != Some(phase) {
            self.phase = Some(phase);
            self.fx.push(Effect::Status(phase));
        }
    }

    // --- Sending ---

    fn error(&mut self, error: SessionError) {
        self.fx.push(Effect::Error(error));
    }

    fn lib_error(&mut self, e: crate::Error) {
        self.error(SessionError::Library(e.to_string()));
    }

    fn dropped(&mut self, from: Uuid, reason: DropReason) {
        self.fx.push(Effect::Dropped { from, reason });
    }

    fn send_text(&mut self, message: Control) {
        self.fx.push(Effect::SendText(protocol::encode_control(&message)));
    }

    fn send_sealed(&mut self, to: Address, payload: &[u8]) -> bool {
        if self.sealer_epoch.is_none() {
            return false;
        }
        let body = self.sealer.seal(to, payload);
        match protocol::encode_outgoing(to, &body) {
            Ok(frame) => {
                self.fx.push(Effect::SendBinary(frame));
                true
            }
            Err(_) => false,
        }
    }

    fn send_sync(&mut self, to: Address, message: &SyncMessage) -> bool {
        match message.encode() {
            Ok(payload) => self.send_sealed(to, &payload),
            Err(e) => {
                self.error(SessionError::Library(format!("encoding a message: {e}")));
                false
            }
        }
    }

    fn send_pair(&mut self, to: Uuid, message: &PairMessage) {
        let header = self.sealer.pairing_header();
        let mut body = header.encode().to_vec();
        body.extend_from_slice(&message.encode().expect("pairing messages are small"));
        if let Ok(frame) = protocol::encode_outgoing(Address::Device(to), &body) {
            self.fx.push(Effect::SendBinary(frame));
        }
    }

    fn send_hello(&mut self, lib: &mut dyn Library, to: Uuid) {
        let vector = match lib.vector() {
            Ok(v) => v,
            Err(e) => return self.lib_error(e),
        };
        let hello = SyncMessage::Hello {
            proto: PROTO,
            schema: self.cfg.schema,
            vector,
            hub: self.is_hub(),
            platform: self.cfg.platform.clone(),
            app: protocol::hello_app(&self.cfg.app),
        };
        if self.send_sync(Address::Device(to), &hello) {
            self.peers.entry(to).or_default().said_hello = true;
        }
    }

    fn send_pull(&mut self, lib: &mut dyn Library, to: Uuid) {
        let vector = match lib.vector() {
            Ok(v) => v,
            Err(e) => return self.lib_error(e),
        };
        let peer = self.peers.entry(to).or_default();
        // Changes beyond this vector that the peer is known to hold, about one per counter.
        let total = peer.known.0.iter().map(|(r, c)| c.saturating_sub(vector.get(r))).sum();
        let carry = peer.incoming.take().filter(|i| i.session.is_some() && i.session == peer.session);
        peer.incoming = Some(match carry {
            // An answer is still coming on the same session: what it left out still counts.
            Some(mut i) => {
                i.total = i.total.max(total);
                i
            }
            None => Incoming { session: peer.session, total, ..Incoming::default() },
        });
        self.send_sync(Address::Device(to), &SyncMessage::Pull { vector });
    }

    fn roster_message(&self) -> Option<SyncMessage> {
        let roster = self.meta.roster.as_ref()?;
        Some(SyncMessage::Roster { hub: roster.hub, devices: roster.devices.clone() })
    }

    fn send_roster(&mut self, to: Address) {
        if let Some(message) = self.roster_message() {
            self.send_sync(to, &message);
        }
    }

    // --- Keys ---

    fn store_meta(&mut self, lib: &mut dyn Library) {
        self.meta.key = self.keys.iter().next_back().map(|(e, (k, _))| (*e, *k));
        let meta = self.meta.clone();
        if let Err(e) = lib.store_meta(&meta) {
            self.lib_error(e);
        }
    }

    fn newest_epoch(&self) -> Option<u32> {
        self.keys.keys().next_back().copied()
    }

    /// The newest key the relay has announced; an older one while a rotation is not announced
    /// yet, so peers still read what this device sends.
    fn refresh_sealer(&mut self) {
        let want = self.keys.keys().filter(|e| **e <= self.relay_epoch).next_back().copied().or_else(|| self.keys.keys().next().copied());
        if want == self.sealer_epoch {
            return;
        }
        let Some(epoch) = want else {
            self.sealer_epoch = None;
            self.sealer = Sealer::new([0; 32], 0, self.cfg.device, self.rng.as_ref()).unwrap_or_else(|_| rng_failed());
            return;
        };
        let key = self.keys[&epoch].0;
        self.sealer = Sealer::new(key, epoch, self.cfg.device, self.rng.as_ref()).unwrap_or_else(|_| rng_failed());
        self.sealer_epoch = Some(epoch);
        let expires = self.now + OLD_KEY_MS;
        for (e, (_, until)) in self.keys.iter_mut() {
            if *e < epoch && until.is_none() {
                *until = Some(expires);
            }
        }
        if let Some(entry) = self.keys.get_mut(&epoch) {
            entry.1 = None;
        }
    }

    fn key_for(&self, epoch: u32) -> Option<LibraryKey> {
        match self.keys.get(&epoch) {
            Some((key, until)) if until.map_or(true, |t| self.now < t) => Some(*key),
            _ => None,
        }
    }

    fn add_key(&mut self, lib: &mut dyn Library, epoch: u32, key: LibraryKey) {
        self.keys.insert(epoch, (key, None));
        self.store_meta(lib);
        self.refresh_sealer();
    }

    fn generate_key(&self) -> LibraryKey {
        crypto::random(self.rng.as_ref()).unwrap_or_else(|_| rng_failed())
    }

    fn pinned_key(&self, device: Uuid) -> Option<[u8; 32]> {
        if device == self.cfg.device {
            return Some(self.public);
        }
        self.meta.roster.as_ref().and_then(|r| r.key_of(device))
    }

    // --- Who to sync with ---

    fn is_active(&self) -> bool {
        self.status == Some(DeviceStatus::Active)
    }

    fn can_sync(&self) -> bool {
        self.link == Link::Ready && self.is_active() && self.sealer_epoch.is_some() && !self.skewed && self.stop.is_none()
    }

    fn active_online(&self, device: Uuid) -> bool {
        device != self.cfg.device
            && self.online.contains(&device)
            && self.devices.get(&device).is_some_and(|d| d.status == DeviceStatus::Active)
    }

    fn peer_available(&self, device: Uuid) -> bool {
        self.active_online(device) && self.peers.get(&device).map_or(true, |p| p.pause.is_none())
    }

    /// The hub when it is reachable; every active peer otherwise. The hub syncs with everyone.
    fn hub_reachable(&self) -> bool {
        self.hub.is_some_and(|hub| hub != self.cfg.device && self.peer_available(hub))
    }

    fn sync_targets(&self) -> Vec<Uuid> {
        if !self.is_hub() && self.hub_reachable() {
            return self.hub.into_iter().collect();
        }
        self.online.iter().copied().filter(|d| self.peer_available(*d)).collect()
    }

    fn start_sessions(&mut self, lib: &mut dyn Library) {
        if !self.can_sync() {
            return;
        }
        for target in self.sync_targets() {
            if !self.peers.get(&target).is_some_and(|p| p.said_hello) {
                self.send_hello(lib, target);
            }
        }
    }

    /// Pushes what each sync peer doesn't hold yet. A push is a delta since what the peer is
    /// known to hold, so its `covers` is exact (`PROTOCOL.md` 3.4 step 4): sent to each peer
    /// rather than to everyone.
    fn push_all(&mut self, lib: &mut dyn Library) {
        if !self.can_sync() {
            return;
        }
        for target in self.sync_targets() {
            let Some(peer) = self.peers.get_mut(&target) else { continue };
            if !peer.synced {
                continue;
            }
            if peer.outgoing.is_some() || peer.ack_since.is_some() {
                peer.dirty = true;
                continue;
            }
            let since = peer.known.clone();
            self.start_outgoing(lib, target, since, true);
        }
    }

    fn start_outgoing(&mut self, lib: &mut dyn Library, to: Uuid, since: Vector, push: bool) {
        let mut out = Outgoing {
            since,
            covers: None,
            cursor: None,
            queue: VecDeque::new(),
            finished: false,
            sent: 0,
            remaining: 0,
        };
        if let Err(e) = self.fill(lib, &mut out) {
            return self.lib_error(e);
        }
        if push && out.finished && out.queue.iter().all(|q| q.1 == 0) {
            // Nothing the peer lacks.
            return;
        }
        let peer = self.peers.entry(to).or_default();
        peer.dirty = false;
        peer.outgoing = Some(out);
    }

    /// Reads the next page of the delta into batches.
    fn fill(&self, lib: &mut dyn Library, out: &mut Outgoing) -> crate::Result<()> {
        let page = lib.delta(&out.since, out.cursor.as_ref(), self.cfg.chunk_bytes, CHUNKS_PER_PAGE)?;
        out.remaining = page.remaining as u64;
        if page.chunks.is_empty() {
            out.finished = true;
        }
        for chunk in page.chunks {
            // Every batch carries the covers of the whole answer; only the last merges it.
            let covers = out.covers.get_or_insert_with(|| {
                let mut covers = out.since.clone();
                covers.merge(&chunk.cursor.target);
                covers
            });
            for payload in pack(chunk.groups, covers, chunk.last)
                .map_err(|e| crate::Error::Damaged(format!("a record too large to send: {e}")))?
            {
                out.queue.push_back(payload);
            }
            out.cursor = Some(chunk.cursor);
            if chunk.last {
                out.finished = true;
            }
        }
        Ok(())
    }

    fn pump(&mut self, lib: &mut dyn Library) {
        if self.link != Link::Ready {
            return;
        }
        let mut budget = BATCHES_PER_PUMP;
        let ids: Vec<Uuid> = self.peers.iter().filter(|(_, p)| p.outgoing.is_some()).map(|(id, _)| *id).collect();
        for id in ids {
            while budget > 0 {
                let Some(mut out) = self.peers.get_mut(&id).and_then(|p| p.outgoing.take()) else { break };
                if out.queue.is_empty() && !out.finished {
                    if let Err(e) = self.fill(lib, &mut out) {
                        self.lib_error(e);
                        break;
                    }
                }
                let Some((payload, groups)) = out.queue.pop_front() else {
                    // Finished and sent: the peer acks.
                    let peer = self.peers.entry(id).or_default();
                    peer.ack_since = Some(self.now);
                    break;
                };
                self.send_sealed(Address::Device(id), &payload);
                out.sent += groups;
                budget -= 1;
                let done = out.finished && out.queue.is_empty();
                let peer = self.peers.entry(id).or_default();
                if done {
                    peer.ack_since = Some(self.now);
                    break;
                }
                peer.outgoing = Some(out);
            }
        }
    }

    // --- Connection ---

    fn reset_connection(&mut self) {
        self.peers.clear();
        self.online.clear();
        self.skewed = false;
        self.asking = None;
        self.hosting = None;
        self.rekey = None;
        self.roster_for = None;
        self.handed_over_by = None;
        // The other side's state of a hub change is lost with either connection.
        if let Some((hub, _)) = self.hub_asking.take() {
            self.hub_change(HubChangeEvent::Failed { peer: hub, reason: HubChangeFailure::Unavailable });
        }
        if let Some((device, _)) = self.hub_asked.take() {
            self.hub_change(HubChangeEvent::Settled { peer: device });
        }
    }

    fn hub_change(&mut self, event: HubChangeEvent) {
        self.fx.push(Effect::HubChange(event));
    }

    fn on_connected(&mut self, lib: &mut dyn Library) {
        self.reset_connection();
        self.link = Link::Open;
        self.stop = None;
        self.status = None;
        match lib.load_meta() {
            Ok(meta) => self.meta = meta,
            Err(e) => self.lib_error(e),
        }
        self.keys.clear();
        if let Some((epoch, key)) = self.meta.key {
            self.keys.insert(epoch, (key, None));
        }
        self.hub = self.meta.hub;
        self.relay_epoch = self.meta.key.map_or(0, |k| k.0);
        // A new session on every connection: the seq counter starts over.
        self.sealer_epoch = Some(u32::MAX);
        self.refresh_sealer();
    }

    fn on_closed(&mut self, lib: &mut dyn Library, code: Option<u16>, reason: Option<&str>) {
        self.reset_connection();
        self.link = Link::Down;
        match (code, reason) {
            (Some(close::REVOKED), _) => self.forget(lib),
            (Some(close::PLAN), _) => self.stop = Some(PauseReason::Plan),
            (Some(close::PROTO_TOO_OLD), _) => self.stop = Some(PauseReason::UpdateNeeded),
            (Some(close::RATE_LIMITED), Some(DEVICE_LIMIT)) => self.stop = Some(PauseReason::DeviceLimit),
            (Some(close::STARTED_OVER), _) => {
                // This device's own start over reconnects as the new hub (2.6 step 5); another
                // one's holds a device that took part in sync until the person joins again.
                let own = std::mem::take(&mut self.starting_over);
                if !own && !self.joining && self.meta.key.is_some() {
                    self.held = true;
                }
            }
            _ => {}
        }
    }

    /// Revoked: the library key and the roster are of no more use, and must not be kept.
    fn forget(&mut self, lib: &mut dyn Library) {
        self.stop = Some(PauseReason::Revoked);
        self.status = Some(DeviceStatus::Revoked);
        self.keys.clear();
        self.meta = Meta::default();
        self.store_meta(lib);
        self.refresh_sealer();
        self.peers.clear();
    }

    fn check_skew(&mut self, lib: &mut dyn Library, relay_ms: u64) {
        let skewed = protocol::clock_skewed(relay_ms, self.now);
        if skewed == self.skewed {
            return;
        }
        self.skewed = skewed;
        if skewed {
            // Nothing applied or produced from here: answers under way stop.
            for peer in self.peers.values_mut() {
                peer.incoming = None;
                peer.outgoing = None;
                peer.ack_since = None;
                peer.said_hello = false;
            }
        } else if self.link == Link::Ready {
            self.start_sessions(lib);
        }
    }

    fn on_tick(&mut self, lib: &mut dyn Library) {
        let now = self.now;
        let sealing = self.sealer_epoch;
        self.keys.retain(|e, (_, until)| Some(*e) == sealing || until.map_or(true, |t| now < t));
        if let Some(a) = &self.asking {
            if now >= a.started + PAIRING_TIMEOUT_MS {
                let hub = a.hub;
                self.asking = None;
                self.fx.push(Effect::Pairing(PairingEvent::Failed { peer: hub, reason: PairingFailure::Timeout }));
            }
        }
        if let Some(h) = &self.hosting {
            if h.awaits_reveal_past(now) {
                self.abandon_unrevealed();
            } else if now >= h.started + PAIRING_TIMEOUT_MS {
                let device = h.device;
                self.hosting = None;
                self.fx.push(Effect::Pairing(PairingEvent::Failed { peer: device, reason: PairingFailure::Timeout }));
            }
        }
        if let Some((hub, started)) = self.hub_asking {
            if now >= started + HUB_REQUEST_TIMEOUT_MS {
                self.hub_asking = None;
                self.hub_change(HubChangeEvent::Failed { peer: hub, reason: HubChangeFailure::Timeout });
            }
        }
        if let Some((device, started)) = self.hub_asked {
            if now >= started + HUB_REQUEST_TIMEOUT_MS {
                // The asking device gave up by now.
                self.hub_asked = None;
                self.hub_change(HubChangeEvent::Settled { peer: device });
            }
        }
        if self.rekey.as_ref().is_some_and(|r| now >= r.started + REKEY_RETRY_MS) {
            self.rekey = None;
            self.maybe_rekey();
        }
        let mut repush = false;
        for peer in self.peers.values_mut() {
            if peer.ack_since.is_some_and(|t| now >= t + ACK_TIMEOUT_MS) {
                peer.ack_since = None;
                repush |= peer.dirty;
            }
        }
        if repush {
            self.push_all(lib);
        }
        let retry: Vec<Uuid> = self
            .peers
            .iter()
            .filter(|(_, p)| p.pause == Some(PeerPause::Skewed) && now >= p.paused_at + SKEW_RETRY_MS)
            .map(|(id, _)| *id)
            .collect();
        for id in retry {
            if let Some(peer) = self.peers.get_mut(&id) {
                peer.pause = None;
                peer.said_hello = false;
            }
            if self.can_sync() && self.sync_targets().contains(&id) {
                self.send_hello(lib, id);
            }
        }
    }

    // --- Control messages ---

    fn on_text(&mut self, lib: &mut dyn Library, text: &str) {
        let message = match protocol::decode_control(text) {
            Ok(m) => m,
            // Unknown messages are ignored; the relay may grow them.
            Err(_) => return,
        };
        match message {
            Control::Challenge { nonce, time } => {
                if self.link != Link::Open {
                    return;
                }
                self.check_skew(lib, time);
                self.fx.push(Effect::ClockOffset(clock_offset(self.now, time)));
                let sig = crypto::sign_relay_hello(&self.cfg.device_key, &self.cfg.sub, &nonce.0, self.cfg.device);
                self.send_text(Control::Hello {
                    device: self.cfg.device,
                    key: B64(self.public),
                    name: device_name(&self.cfg.name),
                    app: self.cfg.app.clone(),
                    sig: B64(sig),
                });
            }
            Control::Welcome { status, hub, epoch, devices, online, time, started_over } => {
                if self.link != Link::Open {
                    return;
                }
                self.link = Link::Ready;
                self.status = Some(status);
                self.devices = devices.into_iter().map(|d| (d.id, d)).collect();
                self.online = online.into_iter().collect();
                self.starting_over = false;
                self.held = false;
                if status == DeviceStatus::Active {
                    self.joining = false;
                }
                self.check_skew(lib, time);
                if let Some(started_over) = started_over {
                    self.on_started_over(lib, started_over, status, hub, epoch);
                }
                self.set_account(lib, hub, epoch, true);
                // After the hub is known: the interface asks to pair once the hub is online.
                self.emit_devices();
                if let Some(token) = self.start_over_token.take() {
                    self.send_start_over(token);
                }
            }
            Control::Presence { device, online } => self.on_presence(lib, device, online),
            Control::Device { device } => self.on_device(lib, device),
            Control::Account { hub, epoch } => self.set_account(lib, hub, epoch, false),
            Control::Error { code } => {
                if code == relay_error::STALE_SIGN_IN {
                    // Nothing changed on the relay: no 4005 follows.
                    self.starting_over = false;
                }
                self.error(SessionError::Relay(code))
            }
            Control::Undeliverable { to } => self.on_undeliverable(to),
            // Requests go the other way.
            _ => {}
        }
    }

    /// `welcome.started_over` (2.6 step 5).
    fn on_started_over(&mut self, lib: &mut dyn Library, started_over: StartedOver, status: DeviceStatus, hub: Uuid, epoch: u32) {
        let me = self.cfg.device;
        if started_over.by == me {
            if status == DeviceStatus::Active && hub == me && self.newest_epoch().is_none_or(|e| e < started_over.epoch) {
                // The new hub's first welcome: a new library key at the relay's epoch, and a
                // roster of this device alone (the others pair again).
                self.keys.clear();
                self.meta.roster = None;
                self.relay_epoch = epoch;
                let key = self.generate_key();
                self.add_key(lib, epoch, key);
            }
            return;
        }
        // A device that held a key of an epoch before the start over took part in sync: it
        // shows who started over and offers nothing until the person joins again.
        let behind = self.meta.key.is_some_and(|(e, _)| e < started_over.epoch);
        if status == DeviceStatus::Pending && behind && !self.joining {
            self.held = true;
            let by_name = self.devices.get(&started_over.by).map(|d| d.name.clone());
            self.fx.push(Effect::StartedOver { by: started_over.by, by_name, at: started_over.at, epoch: started_over.epoch });
        }
    }

    fn send_start_over(&mut self, token: String) {
        self.starting_over = true;
        self.send_text(Control::StartOver { token });
    }

    fn emit_devices(&mut self) {
        self.fx.push(Effect::Devices {
            devices: self.devices.values().cloned().collect(),
            online: self.online.iter().copied().collect(),
            hub: self.hub,
        });
    }

    /// `welcome` and `account`: who the hub is and which epoch is current.
    fn set_account(&mut self, lib: &mut dyn Library, hub: Uuid, epoch: u32, welcome: bool) {
        let me = self.cfg.device;
        let hub_changed = self.hub != Some(hub);
        self.relay_epoch = epoch;
        self.hub = Some(hub);
        if hub_changed {
            // A hub change under way is over: this device is the hub now, or someone else is.
            if let Some((asked, _)) = self.hub_asking.take() {
                if hub == me {
                    self.handed_over_by = Some(asked);
                }
                self.hub_change(HubChangeEvent::Settled { peer: asked });
            }
            if hub != me {
                if let Some((device, _)) = self.hub_asked.take() {
                    self.hub_change(HubChangeEvent::Settled { peer: device });
                }
            }
        }
        if hub_changed || welcome {
            if hub != me && self.pinned_key(hub).is_none() && self.meta.roster.is_some() {
                // Sync bodies are sealed whoever routes them; only trust (rekeys) needs the pin.
                self.error(SessionError::UntrustedHub(hub));
            }
            if self.pinned_key(hub).is_some() && self.meta.hub != Some(hub) {
                self.meta.hub = Some(hub);
                self.store_meta(lib);
            }
            if !welcome {
                self.emit_devices();
            }
        }
        if !self.is_active() {
            self.refresh_sealer();
            return;
        }
        if self.is_hub() {
            self.hub_keys(lib, hub_changed || welcome);
        }
        let had = self.sealer_epoch;
        self.refresh_sealer();
        if self.is_hub() && (had != self.sealer_epoch || hub_changed) && self.sealer_epoch.is_some() && !welcome {
            // After a rotation or a hand-over every active device gets the roster (4.4).
            self.send_roster(Address::All);
        }
        self.maybe_rekey();
        if welcome || hub_changed {
            if self.is_hub() {
                // Every peer says hello again to the new hub, and it to them.
                for peer in self.peers.values_mut() {
                    peer.said_hello = false;
                }
            }
            self.start_sessions(lib);
        }
    }

    /// The hub always holds the current key: the first device makes it, and a hub that lacks
    /// the relay's epoch (it lost it, or took over from a hub that rotated) rotates again.
    fn hub_keys(&mut self, lib: &mut dyn Library, check_roster: bool) {
        let me = self.cfg.device;
        let newest = self.newest_epoch();
        match newest {
            None if self.relay_epoch == 0 => {
                let key = self.generate_key();
                self.add_key(lib, 0, key);
            }
            Some(e) if e > self.relay_epoch => {
                // A rotation the relay never confirmed.
                self.send_text(Control::Epoch { epoch: e });
            }
            Some(e) if e == self.relay_epoch => {}
            _ => {
                let next = self.relay_epoch + 1;
                let key = self.generate_key();
                self.add_key(lib, next, key);
                self.send_text(Control::Epoch { epoch: next });
            }
        }
        if check_roster {
            let mut roster = self.meta.roster.clone().unwrap_or(Roster { hub: me, devices: Vec::new() });
            let before = roster.clone();
            roster.hub = me;
            roster.set(me, self.public);
            if self.meta.roster.as_ref() != Some(&roster) || before.hub != me {
                self.meta.roster = Some(roster);
                self.meta.hub = Some(me);
                self.store_meta(lib);
            }
        }
    }

    fn on_presence(&mut self, lib: &mut dyn Library, device: Uuid, online: bool) {
        if device == self.cfg.device {
            return;
        }
        if online {
            self.online.insert(device);
        } else {
            self.online.remove(&device);
            self.peers.remove(&device);
        }
        self.emit_devices();
        if let Some(h) = self.hosting.as_ref().filter(|h| h.device == device && !online) {
            // Before the reveal nothing was shown here, so there is nothing to take back.
            let shown = h.exchange_key.is_some();
            self.hosting = None;
            if shown {
                self.fx.push(Effect::Pairing(PairingEvent::Failed { peer: device, reason: PairingFailure::Unavailable }));
            }
        }
        if self.asking.as_ref().is_some_and(|a| a.hub == device) && !online {
            // The hub forgot the offer with its connection: a new one goes when it is back.
            self.asking = None;
            self.fx.push(Effect::Pairing(PairingEvent::Failed { peer: device, reason: PairingFailure::Unavailable }));
        }
        if !online && self.hub_asking.is_some_and(|(hub, _)| hub == device) {
            // The hub forgot the request with its connection.
            self.hub_asking = None;
            self.hub_change(HubChangeEvent::Failed { peer: device, reason: HubChangeFailure::Unavailable });
        }
        if !online && self.hub_asked.is_some_and(|(asking, _)| asking == device) {
            self.hub_asked = None;
            self.hub_change(HubChangeEvent::Settled { peer: device });
        }
        if Some(device) == self.hub && !self.is_hub() {
            if online {
                self.maybe_rekey();
            } else {
                // The hub left: sync with whoever is here.
                self.start_sessions(lib);
            }
        } else if online && self.is_hub() && self.active_online(device) && self.can_sync() {
            // 3.4 step 5.
            self.send_hello(lib, device);
        }
    }

    fn on_device(&mut self, lib: &mut dyn Library, info: DeviceInfo) {
        let id = info.id;
        let status = info.status;
        let was = self.devices.get(&id).map(|d| d.status);
        self.devices.insert(id, info);
        self.emit_devices();
        if id == self.cfg.device {
            match status {
                DeviceStatus::Revoked => self.forget(lib),
                DeviceStatus::Active if self.status != Some(DeviceStatus::Active) => {
                    self.status = Some(DeviceStatus::Active);
                    self.joining = false;
                    self.refresh_sealer();
                    self.maybe_rekey();
                    self.start_sessions(lib);
                }
                _ => self.status = Some(status),
            }
            return;
        }
        if status == DeviceStatus::Active && was != Some(DeviceStatus::Active) {
            if self.is_hub() && self.roster_for == Some(id) {
                self.roster_for = None;
                self.send_roster(Address::All);
            }
            if self.is_hub() && self.online.contains(&id) && self.can_sync() {
                self.send_hello(lib, id);
            }
        }
        if status == DeviceStatus::Revoked {
            self.peers.remove(&id);
        }
    }

    fn on_undeliverable(&mut self, to: Uuid) {
        if let Some(peer) = self.peers.get_mut(&to) {
            peer.outgoing = None;
            peer.incoming = None;
            peer.ack_since = None;
            peer.said_hello = false;
        }
        if self.asking.as_ref().is_some_and(|a| a.hub == to || to.is_nil()) {
            let hub = self.asking.take().map(|a| a.hub).unwrap_or(to);
            self.fx.push(Effect::Pairing(PairingEvent::Failed { peer: hub, reason: PairingFailure::Unavailable }));
        }
        if self.hub_asking.is_some_and(|(hub, _)| hub == to || to.is_nil()) {
            // 4.4 step 1: the hub is offline; the person may start over instead.
            let hub = self.hub_asking.take().map_or(to, |(hub, _)| hub);
            self.hub_change(HubChangeEvent::Failed { peer: hub, reason: HubChangeFailure::Unavailable });
        }
    }

    // --- Actions ---

    fn on_action(&mut self, lib: &mut dyn Library, action: Action) {
        let me = self.cfg.device;
        match action {
            Action::StartPairing => self.start_pairing(),
            Action::ApprovePairing { device } => self.approve(lib, device),
            Action::RejectPairing { device } => {
                if self.hosting.as_ref().is_some_and(|h| h.device == device) {
                    self.hosting = None;
                    self.send_pair(device, &PairMessage::Error { code: ErrorCode::Rejected });
                    self.send_text(Control::Revoke { device });
                    self.fx.push(Effect::Pairing(PairingEvent::Failed { peer: device, reason: PairingFailure::Rejected }));
                }
            }
            Action::RequestHub => self.request_hub(),
            Action::AnswerHubRequest { allow } => self.answer_hub_request(allow),
            Action::StartOver { token } => {
                if self.stop == Some(PauseReason::Revoked) {
                    return self.error(SessionError::NotAllowed("a removed device can't start over"));
                }
                self.held = false;
                if self.link == Link::Ready {
                    self.send_start_over(token);
                } else {
                    self.start_over_token = Some(token);
                }
            }
            Action::JoinAgain => {
                self.held = false;
                self.joining = true;
                if self.link == Link::Ready && self.status == Some(DeviceStatus::Pending) {
                    self.start_pairing();
                }
            }
            Action::RemoveDevice { device } => {
                if !self.is_hub() || self.link != Link::Ready {
                    return self.error(SessionError::NotAllowed("only the hub removes devices"));
                }
                if device == me {
                    return self.error(SessionError::NotAllowed("the hub hands over before it leaves"));
                }
                self.send_text(Control::Revoke { device });
                self.peers.remove(&device);
                if let Some(roster) = self.meta.roster.as_mut() {
                    roster.remove(device);
                }
                // 4.3: a new key the removed device never sees; the roster follows the
                // relay's `account`.
                let next = self.relay_epoch.max(self.newest_epoch().unwrap_or(0)) + 1;
                let key = self.generate_key();
                self.add_key(lib, next, key);
                self.send_text(Control::Epoch { epoch: next });
            }
            Action::Rename { device, name } => {
                if self.is_active() && self.link == Link::Ready {
                    self.send_text(Control::Rename { device, name: device_name(&name) });
                }
            }
            Action::SyncNow => {
                for peer in self.peers.values_mut() {
                    peer.said_hello = false;
                }
                self.start_sessions(lib);
            }
            Action::LocalChange => self.push_all(lib),
        }
    }

    // --- Changing the hub (4.4) ---

    fn request_hub(&mut self) {
        if !self.is_active() || self.link != Link::Ready || self.is_hub() || self.sealer_epoch.is_none() {
            return self.error(SessionError::NotAllowed("only an active device other than the hub asks to be the hub"));
        }
        let Some(hub) = self.hub else { return };
        let hub_name = self.devices.get(&hub).map(|d| d.name.clone()).unwrap_or_default();
        if self.hub_asking.is_some_and(|(h, _)| h == hub) {
            // One request at a time; the hub answers the first.
            return self.hub_change(HubChangeEvent::Waiting { hub, hub_name });
        }
        if !self.online.contains(&hub) {
            return self.hub_change(HubChangeEvent::Failed { peer: hub, reason: HubChangeFailure::Unavailable });
        }
        // To the hub's id rather than the alias: a kind-1 body is sealed to the address it is
        // sent to, and the receiver opens it as addressed to itself (3.2).
        if !self.send_sync(Address::Device(hub), &SyncMessage::HubRequest) {
            return;
        }
        self.hub_asking = Some((hub, self.now));
        self.hub_change(HubChangeEvent::Waiting { hub, hub_name });
    }

    fn on_hub_request(&mut self, from: Uuid) {
        let active = self.devices.get(&from).is_some_and(|d| d.status == DeviceStatus::Active);
        if !self.is_hub() || !self.is_active() || !active {
            return self.dropped(from, DropReason::Unexpected);
        }
        if self.hub_asked.is_some_and(|(asking, _)| asking != from) {
            self.send_sync(Address::Device(from), &SyncMessage::Error { code: ErrorCode::Busy });
            return;
        }
        // The same device asking again sees the same question.
        self.hub_asked = Some((from, self.now));
        let name = self.devices.get(&from).map(|d| d.name.clone()).unwrap_or_default();
        self.hub_change(HubChangeEvent::Asked { device: from, name });
    }

    fn answer_hub_request(&mut self, allow: bool) {
        if !self.is_hub() || self.link != Link::Ready {
            return self.error(SessionError::NotAllowed("only the hub hands over"));
        }
        let Some((device, _)) = self.hub_asked.take() else {
            return self.error(SessionError::NotAllowed("no request to answer"));
        };
        if allow {
            // The relay's `account` makes it the hub; the answer only ends its wait.
            self.send_text(Control::SetHub { device });
        }
        self.send_sync(Address::Device(device), &SyncMessage::HubAnswer { allow });
        self.hub_change(HubChangeEvent::Settled { peer: device });
    }

    fn on_hub_answer(&mut self, from: Uuid, allow: bool) {
        if allow && self.handed_over_by == Some(from) {
            // The relay's `account` came first and settled it.
            self.handed_over_by = None;
            return;
        }
        if self.hub_asking.is_none_or(|(hub, _)| hub != from) {
            return self.dropped(from, DropReason::Unexpected);
        }
        if !allow {
            self.hub_asking = None;
            self.hub_change(HubChangeEvent::Failed { peer: from, reason: HubChangeFailure::Denied });
        } else if self.is_hub() {
            // The relay's `account` came first.
            self.hub_asking = None;
            self.hub_change(HubChangeEvent::Settled { peer: from });
        }
    }

    // --- Pairing, the new device ---

    fn start_pairing(&mut self) {
        if self.link != Link::Ready || self.status != Some(DeviceStatus::Pending) {
            return self.error(SessionError::NotAllowed("only a pending device pairs"));
        }
        if self.held {
            return self.error(SessionError::NotAllowed("the account was started over: join again first"));
        }
        let Some(hub) = self.hub else { return };
        let Some(info) = self.devices.get(&hub).cloned() else { return };
        if self.asking.as_ref().is_some_and(|a| a.hub == hub) {
            // One offer at a time (4.2): a second one would replace the first on the hub, and
            // the hub's answer to the first would no longer verify here.
            self.fx.push(Effect::Pairing(PairingEvent::Waiting { hub, hub_name: info.name }));
            return;
        }
        if !self.online.contains(&hub) {
            self.fx.push(Effect::Pairing(PairingEvent::Failed { peer: hub, reason: PairingFailure::Unavailable }));
            return;
        }
        if !self.attempt(None) {
            // Offers that keep ending before a code is approved: something keeps cutting them
            // short, and each new one would give it another chance at matching codes.
            self.fx.push(Effect::Pairing(PairingEvent::Failed { peer: hub, reason: PairingFailure::BadSignature }));
            return;
        }
        let eph = Ephemeral::generate(self.rng.as_ref()).unwrap_or_else(|_| rng_failed());
        let party = Party { device: self.cfg.device, key: self.public, eph: eph.public() };
        // 4.2: commit to the X25519 key now, reveal it once the hub has sent its own.
        let commit = crypto::commitment(&party, hub);
        let offer = crypto::offer_bytes(Exchange::Pair, party.device, &party.key, hub, &commit);
        let sig = crypto::sign(&self.cfg.device_key, &offer);
        self.send_pair(hub, &PairMessage::PairOffer { device: party.device, commit: B64(commit), key: B64(party.key), sig: B64(sig) });
        self.asking = Some(Asking {
            hub,
            hub_key: info.key.0,
            hub_name: info.name.clone(),
            party,
            commit,
            eph: Some(eph),
            exchange_key: None,
            started: self.now,
        });
        self.fx.push(Effect::Pairing(PairingEvent::Waiting { hub, hub_name: info.name }));
    }

    /// Counts one pairing attempt (`device`: the one a hub answers), unless
    /// [`MAX_PAIRING_ATTEMPTS`] were made in the last [`PAIRING_TIMEOUT_MS`].
    fn attempt(&mut self, device: Option<Uuid>) -> bool {
        let now = self.now;
        self.attempts.retain(|(at, _)| now < at + PAIRING_TIMEOUT_MS);
        if self.attempts.len() >= MAX_PAIRING_ATTEMPTS {
            return false;
        }
        self.attempts.push_back((now, device));
        true
    }

    /// After `expired`: a new offer to the hub, keeping the time the first one started, so the
    /// whole pairing still ends by [`PAIRING_TIMEOUT_MS`].
    fn offer_again(&mut self, started: u64) {
        if self.now >= started + PAIRING_TIMEOUT_MS {
            let Some(hub) = self.hub else { return };
            return self.fx.push(Effect::Pairing(PairingEvent::Failed { peer: hub, reason: PairingFailure::Timeout }));
        }
        self.start_pairing();
        if let Some(asking) = self.asking.as_mut() {
            asking.started = started;
        }
    }

    // --- Pairing, the hub ---

    fn on_pair_offer(&mut self, from: Uuid, header: &Header, device: Uuid, commit: [u8; 32], key: [u8; 32], sig: [u8; 64]) {
        let me = self.cfg.device;
        let listed = self.devices.get(&from).is_some_and(|d| d.status == DeviceStatus::Pending && d.key.0 == key);
        let offer = crypto::offer_bytes(Exchange::Pair, device, &key, me, &commit);
        if device != from || !listed || crypto::verify(&key, &offer, &sig).is_err() {
            self.dropped(from, DropReason::BadSignature);
            return self.send_pair(from, &PairMessage::Error { code: ErrorCode::BadSignature });
        }
        if !self.fresh(from, header) {
            return;
        }
        let now = self.now;
        let busy = self.hosting.as_ref().is_some_and(|h| h.device != from && !h.awaits_reveal_past(now));
        if !self.is_hub() || busy || self.sealer_epoch.is_none() {
            // One pairing at a time.
            return self.send_pair(from, &PairMessage::Error { code: ErrorCode::Rejected });
        }
        if !self.attempt(Some(from)) {
            // Too many offers answered and not approved: whoever sends them may be trying codes
            // until one matches. The person is warned (once a while), the offer refused.
            if self.attempts_warned_until <= now {
                self.attempts_warned_until = now + PAIRING_TIMEOUT_MS;
                self.fx.push(Effect::Pairing(PairingEvent::Failed { peer: from, reason: PairingFailure::BadSignature }));
            }
            return self.send_pair(from, &PairMessage::Error { code: ErrorCode::Rejected });
        }
        match &self.hosting {
            Some(old) if old.exchange_key.is_some() => {
                // The device asks again (it gave up waiting): its old code no longer means anything.
                self.fx.push(Effect::Pairing(PairingEvent::Withdrawn { peer: old.device }));
            }
            // Another device's offer that was never revealed: it is told, as on a tick.
            Some(old) if old.device != from => self.abandon_unrevealed(),
            // The same device offers again before revealing: an honest one never does (it
            // reveals at once, and a reconnect ends the old offer first). The person is warned.
            Some(_) => self.fx.push(Effect::Pairing(PairingEvent::Failed { peer: from, reason: PairingFailure::BadSignature })),
            None => {}
        }
        // The hub's key is fixed and signed before it sees the device's: it can't pick one to
        // steer the code, and the device can't either, being bound by `commit`.
        let mine = Ephemeral::generate(self.rng.as_ref()).unwrap_or_else(|_| rng_failed());
        let hub = Party { device: me, key: self.public, eph: mine.public() };
        let accept = crypto::sign(&self.cfg.device_key, &crypto::pair_accept_bytes(device, &key, &commit, &hub));
        self.send_pair(from, &PairMessage::PairAccept { eph: B64(hub.eph), sig: B64(accept) });
        self.hosting = Some(Hosting {
            device: from,
            key,
            commit,
            eph: Some(mine),
            hub_eph: hub.eph,
            exchange_key: None,
            tampered: false,
            started: self.now,
        });
    }

    /// Gives up an offer whose reveal didn't come in time. Nothing was shown here; the device is
    /// told it may ask again, so it stops showing a code nobody can approve, or that its reveal
    /// was tampered with on the way.
    fn abandon_unrevealed(&mut self) {
        if let Some(h) = self.hosting.take() {
            let code = if h.tampered { ErrorCode::BadSignature } else { ErrorCode::Expired };
            self.send_pair(h.device, &PairMessage::Error { code });
        }
    }

    fn on_pair_reveal(&mut self, from: Uuid, header: &Header, eph: [u8; 32]) {
        let Some(hosting) = self.hosting.as_ref().filter(|h| h.device == from && h.eph.is_some()) else {
            return self.dropped(from, DropReason::Unexpected);
        };
        let me = self.cfg.device;
        let asking = Party { device: from, key: hosting.key, eph };
        if crypto::commitment(&asking, me) != hosting.commit {
            // Not the key the offer committed to: a forgery, or a replay from an earlier attempt.
            // Dropped without ending this one (only the committed key can ever match); if the
            // real reveal never comes, the reveal timeout ends it. Either way someone is in
            // between: the hub's person is warned once, and the device when it is given up.
            self.dropped(from, DropReason::BadSignature);
            let hosting = self.hosting.as_mut().expect("checked above");
            if !std::mem::replace(&mut hosting.tampered, true) {
                self.fx.push(Effect::Pairing(PairingEvent::Failed { peer: from, reason: PairingFailure::BadSignature }));
            }
            return;
        }
        if !self.fresh(from, header) {
            return;
        }
        let hosting = self.hosting.as_mut().expect("checked above");
        let hub = Party { device: me, key: self.public, eph: hosting.hub_eph };
        let transcript = crypto::transcript(Exchange::Pair, &asking, &hub);
        let Ok(shared) = hosting.eph.take().expect("checked above").agree(&eph) else {
            self.hosting = None;
            self.send_pair(from, &PairMessage::Error { code: ErrorCode::BadSignature });
            self.fx.push(Effect::Pairing(PairingEvent::Failed { peer: from, reason: PairingFailure::BadSignature }));
            return;
        };
        hosting.exchange_key = Some(crypto::exchange_key(Exchange::Pair, &shared, &transcript));
        let code = crypto::pair_code(&shared, &transcript);
        let peer_name = self.devices.get(&from).map(|d| d.name.clone()).unwrap_or_default();
        self.fx.push(Effect::Pairing(PairingEvent::Code { role: Role::Hub, peer: from, peer_name, code: code_text(code) }));
    }

    fn approve(&mut self, lib: &mut dyn Library, device: Uuid) {
        if !self.hosting.as_ref().is_some_and(|h| h.device == device && h.exchange_key.is_some()) {
            return self.error(SessionError::NotAllowed("no pairing with that device"));
        }
        let (Some(epoch), Some(hosting)) = (self.sealer_epoch, self.hosting.take()) else { return };
        let exchange_key = hosting.exchange_key.expect("checked above");
        let library = self.keys[&epoch].0;
        let sealed = crypto::seal_library_key(&exchange_key, epoch, device, &library);
        self.send_pair(device, &PairMessage::PairKey { epoch, sealed: B64(sealed) });
        self.send_text(Control::Approve { device });
        if let Some(roster) = self.meta.roster.as_mut() {
            roster.set(device, hosting.key);
        }
        self.store_meta(lib);
        self.roster_for = Some(device);
        // The person approved it: no longer an attempt to count against the next device.
        self.attempts.retain(|(_, d)| *d != Some(device));
        self.fx.push(Effect::Pairing(PairingEvent::Paired { peer: device }));
    }

    // --- Rekeying ---

    /// 4.3 step 2: an active device holding only an older key asks the hub.
    fn maybe_rekey(&mut self) {
        if self.rekey.is_some() || self.is_hub() || !self.is_active() || self.link != Link::Ready || self.skewed {
            return;
        }
        if self.newest_epoch().is_some_and(|e| e >= self.relay_epoch) {
            return;
        }
        let Some(hub) = self.hub else { return };
        if !self.online.contains(&hub) {
            return;
        }
        let Some(hub_key) = self.pinned_key(hub) else {
            return self.error(SessionError::UntrustedHub(hub));
        };
        let eph = Ephemeral::generate(self.rng.as_ref()).unwrap_or_else(|_| rng_failed());
        let party = Party { device: self.cfg.device, key: self.public, eph: eph.public() };
        let offer = crypto::offer_bytes(Exchange::Rekey, party.device, &party.key, hub, &party.eph);
        let sig = crypto::sign(&self.cfg.device_key, &offer);
        self.send_pair(hub, &PairMessage::RekeyOffer { device: party.device, eph: B64(party.eph), sig: B64(sig) });
        self.rekey = Some(Rekeying { hub, hub_key, party, eph: Some(eph), exchange_key: None, started: self.now });
    }

    fn on_rekey_offer(&mut self, from: Uuid, header: &Header, device: Uuid, eph: [u8; 32], sig: [u8; 64]) {
        let me = self.cfg.device;
        let active = self.devices.get(&from).is_some_and(|d| d.status == DeviceStatus::Active);
        let pinned = self.meta.roster.as_ref().and_then(|r| r.key_of(from));
        let ok = match pinned {
            Some(key) if device == from && active => {
                let asking = Party { device, key, eph };
                crypto::verify(&key, &crypto::offer_bytes(Exchange::Rekey, asking.device, &asking.key, me, &asking.eph), &sig).is_ok()
            }
            _ => false,
        };
        if !ok || !self.is_hub() {
            self.dropped(from, DropReason::BadSignature);
            return self.send_pair(from, &PairMessage::Error { code: ErrorCode::BadSignature });
        }
        if !self.fresh(from, header) {
            return;
        }
        let Some(epoch) = self.newest_epoch() else { return };
        let asking = Party { device, key: pinned.unwrap(), eph };
        let mine = Ephemeral::generate(self.rng.as_ref()).unwrap_or_else(|_| rng_failed());
        let hub = Party { device: me, key: self.public, eph: mine.public() };
        let transcript = crypto::transcript(Exchange::Rekey, &asking, &hub);
        let accept = crypto::sign(&self.cfg.device_key, &crypto::rekey_accept_bytes(&transcript));
        let Ok(shared) = mine.agree(&eph) else {
            return self.send_pair(from, &PairMessage::Error { code: ErrorCode::BadSignature });
        };
        let key = crypto::exchange_key(Exchange::Rekey, &shared, &transcript);
        let sealed = crypto::seal_library_key(&key, epoch, device, &self.keys[&epoch].0);
        self.send_pair(from, &PairMessage::RekeyAccept { eph: B64(hub.eph), sig: B64(accept) });
        self.send_pair(from, &PairMessage::RekeyKey { epoch, sealed: B64(sealed) });
    }

    // --- Binary frames ---

    fn on_binary(&mut self, lib: &mut dyn Library, frame: &[u8]) {
        if self.link != Link::Ready {
            return;
        }
        let delivered = match protocol::decode_delivered(frame) {
            Ok(d) => d,
            Err(_) => return self.dropped(Uuid::nil(), DropReason::Malformed),
        };
        let from = delivered.from;
        self.check_skew(lib, delivered.relay_ms);
        if from == self.cfg.device {
            // The relay echoes frames a device addresses to itself; this one never does.
            return self.dropped(from, DropReason::Unexpected);
        }
        let header = match Header::parse(delivered.body) {
            Ok((header, _)) => header,
            Err(e) if e.update_needed() => return self.peer_is_newer(from, true),
            Err(_) => return self.dropped(from, DropReason::Malformed),
        };
        match header.kind {
            Kind::Sync => self.on_sealed(lib, from, header, delivered.body),
            Kind::Pairing => self.on_pairing(lib, from, header, &delivered.body[protocol::HEADER_LEN..]),
        }
    }

    /// The replay window, checked once a body is known authentic.
    fn fresh(&mut self, from: Uuid, header: &Header) -> bool {
        match self.guard.accept(from, header) {
            Ok(()) => true,
            Err(_) => {
                self.dropped(from, DropReason::Replayed);
                false
            }
        }
    }

    /// A peer wrote something this build can't read (3.3): say so, pause with it, and don't
    /// let its covers into the vector.
    fn peer_is_newer(&mut self, from: Uuid, tell: bool) {
        let peer = self.peers.entry(from).or_default();
        peer.pause = Some(PeerPause::UpdateNeeded);
        peer.incoming = None;
        peer.outgoing = None;
        peer.synced = false;
        if tell {
            if self.sealer_epoch.is_some() && self.is_active() {
                self.send_sync(Address::Device(from), &SyncMessage::Error { code: ErrorCode::UpdateNeeded });
            } else {
                self.send_pair(from, &PairMessage::Error { code: ErrorCode::UpdateNeeded });
            }
        }
    }

    fn on_sealed(&mut self, lib: &mut dyn Library, from: Uuid, header: Header, body: &[u8]) {
        let Some(key) = self.key_for(header.epoch) else {
            if header.epoch > self.newest_epoch().unwrap_or(0) {
                self.maybe_rekey();
            }
            return self.dropped(from, DropReason::UnknownEpoch);
        };
        let plain = match crypto::open_for(&key, from, self.cfg.device, body) {
            Ok((_, plain)) => plain,
            Err(CryptoError::Truncated) => return self.dropped(from, DropReason::Malformed),
            Err(_) => return self.dropped(from, DropReason::Unauthentic),
        };
        if !self.fresh(from, &header) {
            return;
        }
        let message = match SyncMessage::decode(&plain) {
            Ok(m) => m,
            Err(e) if e.update_needed() => return self.peer_is_newer(from, true),
            Err(_) => return self.dropped(from, DropReason::Malformed),
        };
        self.peer_session(from, header.session);
        if self.peers.get(&from).is_some_and(|p| p.pause == Some(PeerPause::UpdateNeeded)) {
            return;
        }
        self.on_sync(lib, from, message);
    }

    fn peer_session(&mut self, from: Uuid, session: [u8; 16]) {
        let peer = self.peers.entry(from).or_default();
        if peer.session != Some(session) {
            if peer.session.is_some() {
                // The peer restarted or rotated: it may not know we said hello, and an answer
                // it was sending may never finish.
                peer.said_hello = false;
                if let Some(i) = peer.incoming.as_mut() {
                    i.broken = true;
                }
            }
            peer.session = Some(session);
        }
    }

    fn on_sync(&mut self, lib: &mut dyn Library, from: Uuid, message: SyncMessage) {
        match message {
            SyncMessage::Hello { schema, vector, platform, app, .. } => {
                // Told even when it can't sync: a newer peer names the version to update to.
                self.fx.push(Effect::PeerHello { device: from, platform, app });
                if self.skewed {
                    self.send_sync(Address::Device(from), &SyncMessage::Error { code: ErrorCode::ClockSkew });
                    return;
                }
                if schema > self.cfg.schema {
                    // The peer is fine; this device is the old one (3.3 Versions).
                    return self.peer_is_newer(from, false);
                }
                if !self.can_sync() {
                    return;
                }
                let peer = self.peers.entry(from).or_default();
                peer.known.merge(&vector);
                peer.synced = true;
                peer.pause = None;
                peer.repulls = 0;
                if !peer.said_hello {
                    self.send_hello(lib, from);
                }
                self.send_pull(lib, from);
                if self.is_hub() {
                    self.send_roster(Address::Device(from));
                }
            }
            SyncMessage::Pull { vector } => {
                if self.skewed {
                    self.send_sync(Address::Device(from), &SyncMessage::Error { code: ErrorCode::ClockSkew });
                    return;
                }
                if !self.can_sync() {
                    return;
                }
                let peer = self.peers.entry(from).or_default();
                peer.known.merge(&vector);
                peer.synced = true;
                peer.pause = None;
                peer.ack_since = None;
                self.start_outgoing(lib, from, vector, false);
            }
            SyncMessage::Changes { groups, covers, last } => self.on_changes(lib, from, groups, covers, last),
            SyncMessage::Ack { vector } => {
                let peer = self.peers.entry(from).or_default();
                peer.known.merge(&vector);
                peer.ack_since = None;
                let dirty = peer.dirty;
                self.fx.push(Effect::Synced { peer: from });
                if dirty {
                    self.push_all(lib);
                }
            }
            SyncMessage::Roster { hub, devices } => self.on_roster(lib, from, hub, devices),
            SyncMessage::HubRequest => self.on_hub_request(from),
            SyncMessage::HubAnswer { allow } => self.on_hub_answer(from, allow),
            SyncMessage::Error { code: ErrorCode::Busy } if self.hub_asking.is_some_and(|(hub, _)| hub == from) => {
                self.hub_asking = None;
                self.hub_change(HubChangeEvent::Failed { peer: from, reason: HubChangeFailure::Busy });
            }
            SyncMessage::Error { code } => {
                let peer = self.peers.entry(from).or_default();
                peer.paused_at = self.now;
                match code {
                    ErrorCode::ClockSkew => peer.pause = Some(PeerPause::Skewed),
                    ErrorCode::UpdateNeeded => peer.pause = Some(PeerPause::Outdated),
                    _ => {}
                }
                if matches!(code, ErrorCode::ClockSkew | ErrorCode::UpdateNeeded) {
                    peer.outgoing = None;
                    peer.ack_since = None;
                    peer.synced = false;
                }
                self.error(SessionError::Peer { device: from, code });
            }
        }
    }

    fn on_changes(&mut self, lib: &mut dyn Library, from: Uuid, groups: Vec<Group>, covers: Vector, last: bool) {
        if self.skewed {
            return self.dropped(from, DropReason::ClockSkew);
        }
        if !self.can_sync() {
            return self.dropped(from, DropReason::Unexpected);
        }
        let peer = self.peers.entry(from).or_default();
        let session = peer.session;
        let incoming = peer.incoming.get_or_insert_with(|| Incoming { session, ..Incoming::default() });
        for group in &groups {
            for clock in group.fields.iter().map(|f| &f.clock).chain(group.gone.iter().map(|g| &g.clock)) {
                let seen = incoming.seen.entry(clock.replica).or_insert(0);
                *seen = (*seen).max(clock.counter);
            }
        }
        incoming.done += groups.len() as u64;
        incoming.held.extend(groups);
        if !last && incoming.held.len() < self.cfg.hold_groups {
            return;
        }
        let groups = std::mem::take(&mut incoming.held);
        let mut changed = false;
        if !groups.is_empty() {
            match lib.apply(&groups) {
                Ok(applied) => {
                    let incoming = self.peers.get_mut(&from).and_then(|p| p.incoming.as_mut()).expect("just made");
                    incoming.deferred += applied.deferred;
                    if !applied.bookmark_ids.is_empty() || applied.structure_changed {
                        changed = true;
                        self.fx.push(Effect::LibraryChanged(applied));
                    }
                }
                Err(e) => {
                    if let Some(i) = self.peers.get_mut(&from).and_then(|p| p.incoming.as_mut()) {
                        i.broken = true;
                    }
                    self.lib_error(e);
                }
            }
        }
        if !last {
            return;
        }
        let incoming = self.peers.get_mut(&from).and_then(|p| p.incoming.take()).unwrap_or_default();
        let mut merged = false;
        if !incoming.broken && incoming.deferred == 0 {
            match lib.merge_vector(&covers) {
                Ok(()) => {
                    merged = true;
                    self.peers.entry(from).or_default().known.merge(&covers);
                }
                Err(e) => self.lib_error(e),
            }
        }
        let vector = match lib.vector() {
            Ok(v) => v,
            Err(e) => return self.lib_error(e),
        };
        self.send_sync(Address::Device(from), &SyncMessage::Ack { vector: vector.clone() });
        self.fx.push(Effect::Synced { peer: from });
        let gap = incoming.seen.iter().any(|(replica, counter)| vector.get(replica) < *counter);
        let peer = self.peers.entry(from).or_default();
        if !merged || gap {
            if peer.repulls < MAX_REPULLS {
                peer.repulls += 1;
                self.send_pull(lib, from);
            }
        } else {
            peer.repulls = 0;
        }
        if changed || merged {
            // What came in goes on to the others (the hub forwards; without a hub, peers do).
            self.push_all(lib);
        }
    }

    fn on_roster(&mut self, lib: &mut dyn Library, from: Uuid, hub: Uuid, devices: Vec<RosterEntry>) {
        // Only the hub vouches for keys, and only for itself as the hub.
        if Some(from) != self.hub || hub != from || self.is_hub() {
            return self.dropped(from, DropReason::Unexpected);
        }
        let roster = Roster { hub, devices };
        if self.meta.roster.as_ref() != Some(&roster) || self.meta.hub != Some(hub) {
            self.meta.roster = Some(roster);
            self.meta.hub = Some(hub);
            self.store_meta(lib);
        }
    }

    fn on_pairing(&mut self, lib: &mut dyn Library, from: Uuid, header: Header, payload: &[u8]) {
        let message = match PairMessage::decode(payload) {
            Ok(m) => m,
            Err(e) if e.update_needed() => return self.peer_is_newer(from, true),
            Err(protocol::Error::Outdated(_)) => {
                // The sender is the one to update; nothing pauses here.
                self.dropped(from, DropReason::Malformed);
                return self.send_pair(from, &PairMessage::Error { code: ErrorCode::UpdateNeeded });
            }
            Err(_) => return self.dropped(from, DropReason::Malformed),
        };
        match message {
            PairMessage::PairOffer { device, commit, key, sig } => self.on_pair_offer(from, &header, device, commit.0, key.0, sig.0),
            PairMessage::PairReveal { eph } => self.on_pair_reveal(from, &header, eph.0),
            PairMessage::RekeyOffer { device, eph, sig } => self.on_rekey_offer(from, &header, device, eph.0, sig.0),
            PairMessage::PairAccept { eph, sig } => {
                let Some(asking) = self.asking.as_mut().filter(|a| a.hub == from && a.eph.is_some()) else {
                    return self.dropped(from, DropReason::Unexpected);
                };
                let hub = Party { device: from, key: asking.hub_key, eph: eph.0 };
                let accept = crypto::pair_accept_bytes(asking.party.device, &asking.party.key, &asking.commit, &hub);
                if crypto::verify(&asking.hub_key, &accept, &sig.0).is_err() {
                    self.asking = None;
                    self.dropped(from, DropReason::BadSignature);
                    self.send_pair(from, &PairMessage::Error { code: ErrorCode::BadSignature });
                    self.fx.push(Effect::Pairing(PairingEvent::Failed { peer: from, reason: PairingFailure::BadSignature }));
                    return;
                }
                if !self.fresh(from, &header) {
                    return;
                }
                // 4.2 step 4: reveal only now, and show the code only after revealing.
                let reveal = self.asking.as_ref().expect("checked above").party.eph;
                self.send_pair(from, &PairMessage::PairReveal { eph: B64(reveal) });
                let asking = self.asking.as_mut().expect("checked above");
                let transcript = crypto::transcript(Exchange::Pair, &asking.party, &hub);
                let Ok(shared) = asking.eph.take().expect("checked above").agree(&eph.0) else {
                    self.asking = None;
                    self.fx.push(Effect::Pairing(PairingEvent::Failed { peer: from, reason: PairingFailure::BadSignature }));
                    return;
                };
                asking.exchange_key = Some(crypto::exchange_key(Exchange::Pair, &shared, &transcript));
                let code = crypto::pair_code(&shared, &transcript);
                let peer_name = asking.hub_name.clone();
                self.fx.push(Effect::Pairing(PairingEvent::Code { role: Role::Asking, peer: from, peer_name, code: code_text(code) }));
            }
            PairMessage::PairKey { epoch, sealed } => {
                let Some(asking) = self.asking.as_ref().filter(|a| a.hub == from) else {
                    return self.dropped(from, DropReason::Unexpected);
                };
                let Some(exchange_key) = asking.exchange_key else {
                    return self.dropped(from, DropReason::Unexpected);
                };
                let Ok(library) = crypto::open_library_key(&exchange_key, epoch, self.cfg.device, &sealed.0) else {
                    return self.dropped(from, DropReason::Unauthentic);
                };
                if !self.fresh(from, &header) {
                    return;
                }
                let asking = self.asking.take().expect("checked above");
                // 4.2 step 7: the hub's key from the transcript is the first pin.
                let mut roster = Roster { hub: from, devices: Vec::new() };
                roster.set(from, asking.hub_key);
                roster.set(self.cfg.device, self.public);
                self.meta.roster = Some(roster);
                self.meta.hub = Some(from);
                self.keys.clear();
                self.add_key(lib, epoch, library);
                self.attempts.clear();
                self.fx.push(Effect::Pairing(PairingEvent::Paired { peer: from }));
                self.start_sessions(lib);
            }
            PairMessage::RekeyAccept { eph, sig } => {
                let Some(rekey) = self.rekey.as_mut().filter(|r| r.hub == from && r.eph.is_some()) else {
                    return self.dropped(from, DropReason::Unexpected);
                };
                // Signed by the current hub's pinned key, never by a key the relay names.
                let hub = Party { device: from, key: rekey.hub_key, eph: eph.0 };
                let transcript = crypto::transcript(Exchange::Rekey, &rekey.party, &hub);
                if Some(from) != self.hub
                    || crypto::verify(&rekey.hub_key, &crypto::rekey_accept_bytes(&transcript), &sig.0).is_err()
                {
                    self.rekey = None;
                    return self.dropped(from, DropReason::BadSignature);
                }
                if !self.fresh(from, &header) {
                    return;
                }
                let rekey = self.rekey.as_mut().expect("checked above");
                match rekey.eph.take().expect("checked above").agree(&eph.0) {
                    Ok(shared) => rekey.exchange_key = Some(crypto::exchange_key(Exchange::Rekey, &shared, &transcript)),
                    Err(_) => self.rekey = None,
                }
            }
            PairMessage::RekeyKey { epoch, sealed } => {
                let Some(exchange_key) = self.rekey.as_ref().filter(|r| r.hub == from).and_then(|r| r.exchange_key) else {
                    return self.dropped(from, DropReason::Unexpected);
                };
                let Ok(library) = crypto::open_library_key(&exchange_key, epoch, self.cfg.device, &sealed.0) else {
                    self.rekey = None;
                    return self.dropped(from, DropReason::Unauthentic);
                };
                if !self.fresh(from, &header) {
                    return;
                }
                self.rekey = None;
                self.add_key(lib, epoch, library);
                // Peers that already moved on can read us again: start over with them.
                for peer in self.peers.values_mut() {
                    peer.said_hello = false;
                    peer.incoming = None;
                    peer.outgoing = None;
                    peer.ack_since = None;
                }
                self.start_sessions(lib);
            }
            PairMessage::Error { code } => {
                if !self.fresh(from, &header) {
                    return;
                }
                if code == ErrorCode::UpdateNeeded {
                    if let Some(peer) = self.peers.get_mut(&from) {
                        peer.pause = Some(PeerPause::Outdated);
                    }
                }
                if let Some(asking) = self.asking.take_if(|a| a.hub == from) {
                    if code == ErrorCode::Expired {
                        // The hub stopped waiting for our reveal; nobody declined. Ask again,
                        // within the time this device gives the whole pairing.
                        return self.offer_again(asking.started);
                    }
                    let reason = match code {
                        ErrorCode::BadSignature => PairingFailure::BadSignature,
                        _ => PairingFailure::Rejected,
                    };
                    self.fx.push(Effect::Pairing(PairingEvent::Failed { peer: from, reason }));
                    // The failure says what went wrong; a peer error after it would replace it on
                    // the screen. `update_needed` still pauses (above) and is reported.
                    if code != ErrorCode::UpdateNeeded {
                        return;
                    }
                } else if code == ErrorCode::Expired {
                    // For an offer this device already gave up on.
                    return self.dropped(from, DropReason::Unexpected);
                } else if self.rekey.as_ref().is_some_and(|r| r.hub == from) {
                    self.rekey = None;
                }
                self.error(SessionError::Peer { device: from, code });
            }
        }
    }
}

/// `changes` batches of one chunk that each deflate under `MAX_PAYLOAD`, halving until they fit;
/// `last` only on the final batch of the final chunk. With their number of groups.
fn pack(groups: Vec<Group>, covers: &Vector, last: bool) -> Result<Vec<(Vec<u8>, u64)>, protocol::Error> {
    let mut out = Vec::new();
    split(groups, covers, last, &mut out)?;
    Ok(out)
}

fn split(groups: Vec<Group>, covers: &Vector, last: bool, out: &mut Vec<(Vec<u8>, u64)>) -> Result<(), protocol::Error> {
    let count = groups.len() as u64;
    let message = SyncMessage::Changes { groups, covers: covers.clone(), last };
    match message.encode() {
        Ok(payload) => {
            debug_assert!(payload.len() <= MAX_PAYLOAD);
            out.push((payload, count));
            Ok(())
        }
        Err(protocol::Error::TooLarge) => {
            let SyncMessage::Changes { mut groups, .. } = message else { unreachable!() };
            if groups.len() <= 1 {
                return Err(protocol::Error::TooLarge);
            }
            let tail = groups.split_off(groups.len() / 2);
            split(groups, covers, false, out)?;
            split(tail, covers, last, out)
        }
        Err(other) => Err(other),
    }
}
