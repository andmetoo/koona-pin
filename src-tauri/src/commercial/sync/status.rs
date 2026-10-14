//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! What the interface shows of sync (NP-059, NP-060), made from what the relay client reports:
//! the session's phase and effects, its retries and why it stopped. Kept apart from the worker so
//! it is a plain function of the events, and tested as one. No text for people here: the
//! interface has words for every code.

use super::identity::Identity;
use chrono::{DateTime, Utc};
use koona_sync::net::{Event, Stop};
use koona_sync::protocol::{DeviceInfo, DeviceStatus, ErrorCode};
use koona_sync::session::{
    Effect, HubChangeEvent, HubChangeFailure, PairingEvent, PairingFailure, PauseReason, Phase, Role, SessionError,
};
use koona_sync::Applied;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use ts_rs::TS;
use uuid::Uuid;

/// Payload of `sync-status` and the answer of every sync command.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct SyncStatus {
    /// The person turned sync on on this computer.
    pub enabled: bool,
    /// This build knows a relay: without one there is no sync at all.
    pub available: bool,
    pub phase: SyncPhase,
    pub is_hub: bool,
    /// The hub's device id.
    pub hub: Option<String>,
    /// This computer.
    pub device: SyncDevice,
    /// Every device of the account but the removed ones, this one included.
    pub devices: Vec<SyncDevice>,
    /// A pairing under way: on the new device «Confirm on <hub>», then the code on both.
    pub pairing: Option<PairingPrompt>,
    #[ts(type = "string | null")]
    pub last_sync_at: Option<DateTime<Utc>>,
    /// The last thing that went wrong, until the next action of the person or a success.
    pub error: Option<SyncProblem>,
    /// A change of the main computer under way: on the asking device «Waiting for <hub>», on the
    /// hub «Make <peer> the main computer?» with Allow / Deny.
    pub hub_change: Option<HubChangePrompt>,
    /// Things the person should hear about until they dismiss them, newest first: a computer
    /// added to the account, sync started over from another computer.
    pub notices: Vec<SyncNotice>,
    /// Live bookmarks in this library (the trash aside); none while it isn't open.
    #[ts(type = "number | null")]
    pub bookmarks: Option<u64>,
    /// This computer's clock minus the relay's, ms, from the last `challenge`; none before one.
    #[ts(type = "number | null")]
    pub clock_offset_ms: Option<i64>,
    /// While paused for `update_needed`: the device that runs a newer version, if a peer (not the
    /// relay) said so.
    pub update_from: Option<String>,
    /// Generation of the library key this device holds.
    pub epoch: Option<u32>,
}

/// Answer of `get_sync_account`: what the relay knows of the account before this computer turns
/// sync on, so the first screen can say whether it becomes the main computer or joins one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct SyncAccount {
    /// The main computer's name; none when no computer of the account syncs yet.
    pub main_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct HubChangePrompt {
    pub role: HubChangeRole,
    /// The other device: the hub on the asking device, the asking device on the hub.
    pub peer: String,
    pub peer_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum HubChangeRole {
    /// This device asked to become the main computer.
    Asking,
    /// This is the main computer, asked to hand over.
    Hub,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum SyncNotice {
    /// `name` joined the account, approved on `by_name` (the hub then) at `at`.
    DeviceAdded {
        /// Stable id of the notice, for `dismiss_sync_notice`.
        id: String,
        device: String,
        name: String,
        by_name: Option<String>,
        #[ts(type = "string")]
        at: DateTime<Utc>,
    },
    /// `by_name` started sync over: this device was disconnected and joins again with «Join…».
    StartedOver {
        id: String,
        by: String,
        by_name: Option<String>,
        #[ts(type = "string")]
        at: DateTime<Utc>,
    },
}

impl SyncNotice {
    pub fn id(&self) -> &str {
        match self {
            SyncNotice::DeviceAdded { id, .. } | SyncNotice::StartedOver { id, .. } => id,
        }
    }
}

/// The notices most kept; older ones go.
pub const MAX_NOTICES: usize = 20;

/// The notices and what they are found from, kept across restarts (`sync-notices.json`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Notices {
    /// Newest first.
    #[serde(default)]
    pub list: Vec<SyncNotice>,
    /// The other devices active in the directory last seen; none until the first one after sync
    /// was turned on, which adds no notice.
    #[serde(default)]
    pub known: Option<BTreeSet<Uuid>>,
    /// The epoch of the latest start over told about, so it is told once.
    #[serde(default)]
    pub started_over_epoch: Option<u32>,
}

impl Notices {
    fn add(&mut self, notice: SyncNotice) {
        self.list.retain(|n| n.id() != notice.id());
        self.list.insert(0, notice);
        self.list.truncate(MAX_NOTICES);
    }

    /// Whether a notice of that id was there.
    pub fn dismiss(&mut self, id: &str) -> bool {
        let before = self.list.len();
        self.list.retain(|n| n.id() != id);
        self.list.len() != before
    }

    /// The person chose «Join…»: the start over is dealt with.
    pub fn joined(&mut self) -> bool {
        let before = self.list.len();
        self.list.retain(|n| !matches!(n, SyncNotice::StartedOver { .. }));
        self.list.len() != before
    }
}

/// What this device learned of another by syncing with it: its `hello` and when a transfer with
/// it last finished.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerFacts {
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub app: Option<String>,
    #[serde(default)]
    pub last_sync_at: Option<DateTime<Utc>>,
}

/// The other devices' facts, kept across restarts (`sync-devices.json`) so a device offline
/// still shows them. Not in the library: the relay's directory isn't either.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Peers {
    #[serde(default)]
    pub devices: BTreeMap<Uuid, PeerFacts>,
}

impl Peers {
    /// Whether the facts changed.
    fn hello(&mut self, device: Uuid, platform: String, app: String) -> bool {
        let facts = self.devices.entry(device).or_default();
        let (platform, app) = (Some(platform), Some(app));
        let changed = facts.platform != platform || facts.app != app;
        facts.platform = platform;
        facts.app = app;
        changed
    }

    fn synced(&mut self, device: Uuid, at: DateTime<Utc>) {
        self.devices.entry(device).or_default().last_sync_at = Some(at);
    }

    /// Only the devices of the directory not removed are kept. Whether any went.
    fn keep_only(&mut self, devices: &[DeviceInfo]) -> bool {
        let before = self.devices.len();
        self.devices.retain(|id, _| devices.iter().any(|d| d.id == *id && d.status != DeviceStatus::Revoked));
        self.devices.len() != before
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "state", rename_all = "snake_case")]
#[ts(export)]
pub enum SyncPhase {
    Off,
    Unavailable { reason: UnavailableReason },
    Connecting,
    /// Registered, waiting to be paired from the hub.
    Pending,
    Online,
    /// `done` of about `total` changes under way, both directions.
    Syncing {
        #[ts(type = "number")]
        done: u64,
        #[ts(type = "number")]
        total: u64,
    },
    Paused { reason: PausedReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum UnavailableReason {
    /// This build has no relay.
    NoService,
    /// No active Supporter plan on this computer (or not signed in).
    NotSupporter,
    /// The library is still opening, failed to open, or has no sync tables.
    LibraryNotReady,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum PausedReason {
    /// No connection to the relay; it is retried.
    Offline,
    /// This computer's clock is more than five minutes off.
    ClockSkew,
    /// Another device or the relay is newer: update the app.
    UpdateNeeded,
    /// This device was removed from the account.
    Revoked,
    /// The relay says the plan has no sync (or the account is not in the beta).
    Plan,
    /// The account has the most devices the relay allows.
    DeviceLimit,
    /// The same device connected from another process.
    Replaced,
    /// The relay refused the account's sign-in even after a refresh: sign in again.
    SignedOut,
    /// Sync was started over from another computer: this one joins again with «Join…»
    /// (`join_sync_again`), which pairs it with the new main computer.
    StartedOver,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct SyncDevice {
    pub id: String,
    pub name: String,
    pub online: bool,
    pub is_hub: bool,
    pub status: SyncDeviceStatus,
    /// When it last connected or disconnected, ms since the Unix epoch; none before the relay
    /// listed it.
    #[ts(type = "number | null")]
    pub last_seen: Option<u64>,
    /// `macos`, `windows`, `linux` or another word, as it said in its last sync `hello`; none
    /// before this device has synced with it once.
    pub platform: Option<String>,
    /// Its Koona Pin version, from the same `hello`.
    pub app: Option<String>,
    /// When a transfer with it last finished, either direction.
    #[ts(type = "string | null")]
    pub last_sync_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SyncDeviceStatus {
    /// This computer before the relay has seen it.
    Unregistered,
    Pending,
    Active,
    Revoked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct PairingPrompt {
    pub role: PairingRole,
    /// The other device of the pairing: the hub on the new device, the new device on the hub.
    pub peer: String,
    pub peer_name: String,
    /// Six digits to compare; none while the new device waits for the hub's answer.
    pub code: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum PairingRole {
    /// This is the new device.
    Asking,
    /// This is the hub, which approves.
    Hub,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SyncProblem {
    /// Declined on the hub, or the hub was busy with another device.
    PairingRejected,
    PairingTimeout,
    /// A pairing signature did not verify: someone may be in between.
    PairingBadSignature,
    /// Pairing needs the hub online.
    HubOffline,
    /// The relay names a hub this device has no key for.
    UntrustedHub,
    /// The action needs a role this device doesn't have (only the hub removes devices…).
    NotAllowed,
    /// The relay refused a request.
    RelayRefused,
    /// Another device reported an error.
    PeerError,
    /// Reading or writing the library failed.
    LibraryFailed,
    /// The library was replaced (a restore of another copy): sync stopped for it.
    LibraryReplaced,
    /// The main computer denied the request to become the main one.
    HubChangeDenied,
    /// The main computer did not answer within five minutes.
    HubChangeTimeout,
    /// Starting over needs a sign-in by email code within the last ten minutes.
    StaleSignIn,
}

/// What the worker does after an event, besides showing the new status.
#[derive(Debug, Clone, PartialEq)]
pub enum Reaction {
    /// Remote changes were written: the interface reads them.
    Applied(Applied),
    /// A pending device sends its pairing offer to the hub.
    StartPairing,
    /// A transfer finished: `last_sync_at` moved, worth keeping.
    Synced,
    /// The notices changed: they are kept.
    Notices,
    /// What is known of the other devices changed: it is kept.
    Peers,
}

/// The facts the status depends on besides the events.
pub struct Context<'a> {
    pub enabled: bool,
    pub service: bool,
    pub plan: bool,
    pub library_ready: bool,
    pub identity: &'a Identity,
    /// This build's version, as its `hello` says it.
    pub app: String,
    /// Live bookmarks in the open library.
    pub bookmarks: Option<u64>,
}

/// Lines kept for `copy_sync_report`.
const LOG_LINES: usize = 40;

#[derive(Debug, Default)]
pub struct Model {
    pub phase: Option<Phase>,
    pub stop: Option<Stop>,
    devices: Vec<DeviceInfo>,
    online: Vec<Uuid>,
    hub: Option<Uuid>,
    pub pairing: Option<PairingPrompt>,
    pub error: Option<SyncProblem>,
    pub last_sync_at: Option<DateTime<Utc>>,
    /// Why the last pairing failed: only one that failed for want of the hub is tried again
    /// by itself when the hub comes online; a rejection or a timeout waits for the person.
    last_failure: Option<PairingFailure>,
    pub hub_change: Option<HubChangePrompt>,
    pub notices: Notices,
    /// This device, left out of the devices added.
    pub me: Option<Uuid>,
    pub peers: Peers,
    /// This device's clock minus the relay's, from the last `challenge`.
    clock_offset_ms: Option<i64>,
    /// The peer that pauses the session for an update.
    update_from: Option<Uuid>,
    /// Of the newest library key the session holds.
    epoch: Option<u32>,
    log: VecDeque<String>,
}

fn pairing_problem(reason: PairingFailure) -> SyncProblem {
    match reason {
        PairingFailure::Rejected => SyncProblem::PairingRejected,
        PairingFailure::BadSignature => SyncProblem::PairingBadSignature,
        PairingFailure::Timeout => SyncProblem::PairingTimeout,
        PairingFailure::Unavailable => SyncProblem::HubOffline,
    }
}

fn hub_change_problem(reason: HubChangeFailure) -> SyncProblem {
    match reason {
        // As with pairing, a hub busy with another device is a no for now.
        HubChangeFailure::Denied | HubChangeFailure::Busy => SyncProblem::HubChangeDenied,
        HubChangeFailure::Timeout => SyncProblem::HubChangeTimeout,
        HubChangeFailure::Unavailable => SyncProblem::HubOffline,
    }
}

fn time_of(ms: u64, now: DateTime<Utc>) -> DateTime<Utc> {
    i64::try_from(ms).ok().and_then(DateTime::from_timestamp_millis).unwrap_or(now)
}

/// Relay error codes (`PROTOCOL.md` 2.3); any other text in `SessionError::Relay` is the
/// client's own failure to connect, which the phase shows as offline.
fn relay_refused(code: &str) -> bool {
    use koona_sync::protocol::relay_error::*;
    [BAD_MESSAGE, BAD_FRAME, FORBIDDEN, UNKNOWN_DEVICE, BAD_EPOCH].contains(&code)
}

fn problem_of(error: &SessionError) -> Option<SyncProblem> {
    Some(match error {
        SessionError::Relay(code) if code == koona_sync::protocol::relay_error::STALE_SIGN_IN => SyncProblem::StaleSignIn,
        SessionError::Relay(code) if relay_refused(code) => SyncProblem::RelayRefused,
        SessionError::Relay(_) => return None,
        SessionError::Library(_) => SyncProblem::LibraryFailed,
        // A peer whose clock is off, or that is older, sorts itself out; the phase says when
        // this device must update.
        SessionError::Peer { code: ErrorCode::ClockSkew | ErrorCode::UpdateNeeded, .. } => return None,
        SessionError::Peer { .. } => SyncProblem::PeerError,
        SessionError::UntrustedHub(_) => SyncProblem::UntrustedHub,
        SessionError::NotAllowed(_) => SyncProblem::NotAllowed,
    })
}

fn device_status(status: DeviceStatus) -> SyncDeviceStatus {
    match status {
        DeviceStatus::Pending => SyncDeviceStatus::Pending,
        DeviceStatus::Active => SyncDeviceStatus::Active,
        DeviceStatus::Revoked => SyncDeviceStatus::Revoked,
    }
}

fn paused(reason: PauseReason) -> PausedReason {
    match reason {
        PauseReason::ClockSkew => PausedReason::ClockSkew,
        PauseReason::UpdateNeeded => PausedReason::UpdateNeeded,
        PauseReason::Revoked => PausedReason::Revoked,
        PauseReason::Plan => PausedReason::Plan,
        PauseReason::DeviceLimit => PausedReason::DeviceLimit,
        PauseReason::Offline => PausedReason::Offline,
        PauseReason::StartedOver => PausedReason::StartedOver,
    }
}

fn stopped(stop: &Stop) -> Option<PausedReason> {
    Some(match stop {
        Stop::Shutdown => return None,
        Stop::Auth => PausedReason::SignedOut,
        Stop::Plan(_) => PausedReason::Plan,
        Stop::Revoked => PausedReason::Revoked,
        Stop::UpdateNeeded => PausedReason::UpdateNeeded,
        Stop::DeviceLimit => PausedReason::DeviceLimit,
        Stop::Replaced => PausedReason::Replaced,
    })
}

impl Model {
    fn note(&mut self, now: DateTime<Utc>, line: String) {
        if self.log.len() == LOG_LINES {
            self.log.pop_front();
        }
        self.log.push_back(format!("{} {line}", now.format("%Y-%m-%dT%H:%M:%SZ")));
    }

    pub fn log(&self) -> impl Iterator<Item = &String> {
        self.log.iter()
    }

    /// A new client starts: what the old one said no longer holds.
    pub fn restart(&mut self) {
        self.phase = None;
        self.stop = None;
        self.pairing = None;
        self.hub_change = None;
        self.online.clear();
        self.update_from = None;
    }

    fn hub_online(&self) -> bool {
        self.hub.is_some_and(|hub| self.online.contains(&hub))
    }

    pub fn on_event(&mut self, event: Event, now: DateTime<Utc>) -> Vec<Reaction> {
        let mut out = Vec::new();
        match event {
            Event::Closed { code, reason } => {
                let code = code.map_or("none".to_string(), |c| c.to_string());
                self.note(now, format!("closed: {code} {}", reason.as_deref().unwrap_or("")));
            }
            Event::Retrying(delay) => self.note(now, format!("retrying in {} s", delay.as_secs())),
            Event::Stopped(stop) => {
                self.note(now, format!("stopped: {stop:?}"));
                self.phase = None;
                self.pairing = None;
                self.hub_change = None;
                self.online.clear();
                self.stop = (stop != Stop::Shutdown).then_some(stop);
            }
            Event::Session(effect) => self.on_effect(effect, now, &mut out),
        }
        out
    }

    fn on_effect(&mut self, effect: Effect, now: DateTime<Utc>, out: &mut Vec<Reaction>) {
        match effect {
            Effect::Status(phase) => {
                self.note(now, format!("phase {phase:?}"));
                let was = self.phase.replace(phase);
                if phase == Phase::Pending && was != Some(Phase::Pending) && self.pairing.is_none() {
                    out.push(Reaction::StartPairing);
                }
                if matches!(was, Some(Phase::Syncing { .. })) && phase == Phase::Online {
                    self.last_sync_at = Some(now);
                    out.push(Reaction::Synced);
                }
            }
            Effect::Devices { devices, online, hub } => {
                let hub_was_online = self.hub_online();
                if self.notice_added(&devices, hub, now) {
                    out.push(Reaction::Notices);
                }
                if self.peers.keep_only(&devices) {
                    out.push(Reaction::Peers);
                }
                self.devices = devices;
                self.online = online;
                self.hub = hub;
                let retry = self.last_failure.is_none_or(|f| f == PairingFailure::Unavailable);
                if self.phase == Some(Phase::Pending) && self.pairing.is_none() && !hub_was_online && self.hub_online() && retry {
                    out.push(Reaction::StartPairing);
                }
            }
            Effect::Pairing(event) => match event {
                PairingEvent::Waiting { hub, hub_name } => {
                    self.note(now, "pairing: waiting for the hub".into());
                    self.error = None;
                    self.pairing = Some(PairingPrompt { role: PairingRole::Asking, peer: hub.to_string(), peer_name: hub_name, code: None });
                }
                PairingEvent::Code { role, peer, peer_name, code } => {
                    self.note(now, format!("pairing: code shown ({role:?})"));
                    self.error = None;
                    let role = match role {
                        Role::Asking => PairingRole::Asking,
                        Role::Hub => PairingRole::Hub,
                    };
                    self.pairing = Some(PairingPrompt { role, peer: peer.to_string(), peer_name, code: Some(code) });
                }
                PairingEvent::Paired { peer } => {
                    self.note(now, format!("pairing: paired {peer}"));
                    self.pairing = None;
                    self.error = None;
                    self.last_failure = None;
                }
                PairingEvent::Failed { peer, reason } => {
                    self.note(now, format!("pairing: failed with {peer}: {reason:?}"));
                    self.pairing = None;
                    self.last_failure = Some(reason);
                    self.error = Some(pairing_problem(reason));
                }
            },
            Effect::HubChange(event) => match event {
                HubChangeEvent::Waiting { hub, hub_name } => {
                    self.note(now, "hub change: waiting for the hub".into());
                    self.error = None;
                    self.hub_change = Some(HubChangePrompt { role: HubChangeRole::Asking, peer: hub.to_string(), peer_name: hub_name });
                }
                HubChangeEvent::Asked { device, name } => {
                    self.note(now, format!("hub change: asked by {device}"));
                    self.hub_change = Some(HubChangePrompt { role: HubChangeRole::Hub, peer: device.to_string(), peer_name: name });
                }
                HubChangeEvent::Settled { peer } => {
                    self.note(now, format!("hub change: settled with {peer}"));
                    self.hub_change = None;
                }
                HubChangeEvent::Failed { peer, reason } => {
                    self.note(now, format!("hub change: failed with {peer}: {reason:?}"));
                    self.hub_change = None;
                    self.error = Some(hub_change_problem(reason));
                }
            },
            Effect::StartedOver { by, by_name, at, epoch } => {
                self.note(now, format!("started over by {by} to epoch {epoch}"));
                if self.notices.started_over_epoch.is_none_or(|e| epoch > e) {
                    self.notices.started_over_epoch = Some(epoch);
                    let at = time_of(at, now);
                    self.notices.add(SyncNotice::StartedOver { id: format!("started-over-{epoch}"), by: by.to_string(), by_name, at });
                    out.push(Reaction::Notices);
                }
            }
            Effect::LibraryChanged(applied) => {
                self.last_sync_at = Some(now);
                out.push(Reaction::Applied(applied));
            }
            Effect::Error(error) => {
                self.note(now, format!("error: {error:?}"));
                if let Some(problem) = problem_of(&error) {
                    self.error = Some(problem);
                }
            }
            Effect::Dropped { from, reason } => self.note(now, format!("dropped a frame from {from}: {reason:?}")),
            Effect::PeerHello { device, platform, app } => {
                if Some(device) != self.me && self.peers.hello(device, platform, app) {
                    out.push(Reaction::Peers);
                }
            }
            Effect::Synced { peer } => {
                if Some(peer) != self.me {
                    self.peers.synced(peer, now);
                    out.push(Reaction::Peers);
                }
            }
            Effect::ClockOffset(offset) => self.clock_offset_ms = Some(offset),
            Effect::KeyEpoch(epoch) => {
                self.note(now, format!("key epoch {epoch:?}"));
                self.epoch = epoch;
            }
            Effect::UpdateFrom(device) => {
                if let Some(device) = device {
                    self.note(now, format!("update needed for {device}"));
                }
                self.update_from = device;
            }
            Effect::SendText(_) | Effect::SendBinary(_) => {}
        }
    }

    /// Devices that became active since the directory was last seen (a `device` notice, or a
    /// `welcome` after a restart) are told about, but neither this one nor the ones of the first
    /// directory after sync was turned on. Whether the notices changed.
    fn notice_added(&mut self, devices: &[DeviceInfo], hub: Option<Uuid>, now: DateTime<Utc>) -> bool {
        let active: BTreeSet<Uuid> =
            devices.iter().filter(|d| d.status == DeviceStatus::Active && Some(d.id) != self.me).map(|d| d.id).collect();
        let mut changed = false;
        if let Some(known) = &self.notices.known {
            let by_name = hub.and_then(|hub| devices.iter().find(|d| d.id == hub)).map(|d| d.name.clone());
            let added: Vec<&DeviceInfo> = devices.iter().filter(|d| active.contains(&d.id) && !known.contains(&d.id)).collect();
            for device in added {
                self.notices.add(SyncNotice::DeviceAdded {
                    id: format!("device-added-{}", device.id),
                    device: device.id.to_string(),
                    name: device.name.clone(),
                    by_name: by_name.clone(),
                    at: now,
                });
                changed = true;
            }
        }
        if self.notices.known.as_ref() != Some(&active) {
            self.notices.known = Some(active);
            changed = true;
        }
        changed
    }

    fn phase_shown(&self, ctx: &Context<'_>) -> SyncPhase {
        if !ctx.enabled {
            return SyncPhase::Off;
        }
        let unavailable = |reason| SyncPhase::Unavailable { reason };
        if !ctx.service {
            return unavailable(UnavailableReason::NoService);
        }
        if !ctx.plan {
            return unavailable(UnavailableReason::NotSupporter);
        }
        if !ctx.library_ready {
            return unavailable(UnavailableReason::LibraryNotReady);
        }
        if let Some(reason) = self.stop.as_ref().and_then(stopped) {
            return SyncPhase::Paused { reason };
        }
        match self.phase {
            None | Some(Phase::Connecting) => SyncPhase::Connecting,
            Some(Phase::Pending) => SyncPhase::Pending,
            Some(Phase::Online) => SyncPhase::Online,
            Some(Phase::Syncing { done, total }) => SyncPhase::Syncing { done, total },
            Some(Phase::Paused { reason }) => SyncPhase::Paused { reason: paused(reason) },
        }
    }

    fn device(&self, info: &DeviceInfo) -> SyncDevice {
        let facts = self.peers.devices.get(&info.id).cloned().unwrap_or_default();
        SyncDevice {
            id: info.id.to_string(),
            name: info.name.clone(),
            online: self.online.contains(&info.id),
            is_hub: self.hub == Some(info.id),
            status: device_status(info.status),
            last_seen: Some(info.last_seen),
            platform: facts.platform,
            app: facts.app,
            last_sync_at: facts.last_sync_at,
        }
    }

    pub fn status(&self, ctx: &Context<'_>) -> SyncStatus {
        let me = ctx.identity.device;
        let phase = self.phase_shown(ctx);
        let connected = matches!(phase, SyncPhase::Online | SyncPhase::Pending | SyncPhase::Syncing { .. });
        // This device says what it runs itself.
        let own = |device: SyncDevice| SyncDevice {
            platform: Some(koona_sync::protocol::platform().to_string()),
            app: Some(koona_sync::protocol::hello_app(&ctx.app)),
            last_sync_at: self.last_sync_at,
            ..device
        };
        let device = own(match self.devices.iter().find(|d| d.id == me) {
            Some(info) => SyncDevice { online: connected, ..self.device(info) },
            None => SyncDevice {
                id: me.to_string(),
                name: ctx.identity.name.clone(),
                online: false,
                is_hub: false,
                status: SyncDeviceStatus::Unregistered,
                last_seen: None,
                platform: None,
                app: None,
                last_sync_at: None,
            },
        });
        // Only a peer's newer version pauses with a name; the relay's 4004 has none.
        let update_from = match (phase, self.phase) {
            (SyncPhase::Paused { reason: PausedReason::UpdateNeeded }, Some(Phase::Paused { reason: PauseReason::UpdateNeeded }))
                if self.stop.is_none() =>
            {
                self.update_from.map(|d| d.to_string())
            }
            _ => None,
        };
        let devices = self
            .devices
            .iter()
            .filter(|d| d.status != DeviceStatus::Revoked)
            .map(|d| if d.id == me { device.clone() } else { self.device(d) })
            .collect();
        SyncStatus {
            enabled: ctx.enabled,
            available: ctx.service,
            phase,
            is_hub: self.hub == Some(me),
            hub: self.hub.map(|h| h.to_string()),
            device,
            devices,
            pairing: if ctx.enabled { self.pairing.clone() } else { None },
            last_sync_at: self.last_sync_at,
            error: if ctx.enabled { self.error } else { None },
            hub_change: if ctx.enabled { self.hub_change.clone() } else { None },
            notices: if ctx.enabled { self.notices.list.clone() } else { Vec::new() },
            bookmarks: ctx.bookmarks,
            clock_offset_ms: self.clock_offset_ms,
            update_from,
            epoch: self.epoch,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use koona_sync::protocol::B64;
    use std::time::Duration;

    fn uid(n: u128) -> Uuid {
        Uuid::from_u128(n)
    }

    fn info(id: Uuid, name: &str, status: DeviceStatus) -> DeviceInfo {
        DeviceInfo { id, name: name.into(), key: B64([7; 32]), status, last_seen: 1_760_400_000_000 }
    }

    fn ctx(identity: &Identity) -> Context<'_> {
        Context { enabled: true, service: true, plan: true, library_ready: true, identity, app: "0.13.0".into(), bookmarks: Some(42) }
    }

    fn at(s: u64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_760_400_000 + s as i64, 0).unwrap()
    }

    #[test]
    fn the_phase_says_first_what_stands_in_the_way() {
        let me = Identity::new("Studio Mac");
        let model = Model::default();
        let off = Context { enabled: false, ..ctx(&me) };
        assert_eq!(model.status(&off).phase, SyncPhase::Off);
        let no_url = Context { service: false, plan: false, ..ctx(&me) };
        assert_eq!(model.status(&no_url).phase, SyncPhase::Unavailable { reason: UnavailableReason::NoService });
        assert!(!model.status(&no_url).available);
        let no_plan = Context { plan: false, ..ctx(&me) };
        assert_eq!(model.status(&no_plan).phase, SyncPhase::Unavailable { reason: UnavailableReason::NotSupporter });
        let closed = Context { library_ready: false, ..ctx(&me) };
        assert_eq!(model.status(&closed).phase, SyncPhase::Unavailable { reason: UnavailableReason::LibraryNotReady });
        assert_eq!(model.status(&ctx(&me)).phase, SyncPhase::Connecting);
        let shown = model.status(&ctx(&me));
        assert_eq!(shown.device.status, SyncDeviceStatus::Unregistered);
        assert_eq!(shown.device.name, "Studio Mac");
    }

    #[test]
    fn the_session_phase_and_the_directory_are_shown() {
        let me = Identity::new("Studio Mac");
        let laptop = uid(2);
        let mut model = Model::default();
        model.on_event(Event::Session(Effect::Status(Phase::Online)), at(0));
        model.on_event(
            Event::Session(Effect::Devices {
                devices: vec![
                    info(me.device, "Studio Mac", DeviceStatus::Active),
                    info(laptop, "Laptop", DeviceStatus::Active),
                    info(uid(3), "Old phone", DeviceStatus::Revoked),
                ],
                online: vec![me.device],
                hub: Some(me.device),
            }),
            at(1),
        );
        let shown = model.status(&ctx(&me));
        assert_eq!(shown.phase, SyncPhase::Online);
        assert!(shown.is_hub);
        assert_eq!(shown.hub, Some(me.device.to_string()));
        assert_eq!(shown.devices.len(), 2, "removed devices are left out");
        assert!(shown.device.online && shown.device.is_hub);
        let other = shown.devices.iter().find(|d| d.id == laptop.to_string()).unwrap();
        assert!(!other.online && !other.is_hub);
        assert_eq!(other.status, SyncDeviceStatus::Active);
        assert_eq!(other.last_seen, Some(1_760_400_000_000));
    }

    #[test]
    fn a_finished_transfer_and_remote_changes_move_the_last_sync() {
        let me = Identity::new("Mac");
        let mut model = Model::default();
        model.on_event(Event::Session(Effect::Status(Phase::Online)), at(0));
        assert_eq!(model.last_sync_at, None);
        model.on_event(Event::Session(Effect::Status(Phase::Syncing { done: 3, total: 10 })), at(1));
        assert_eq!(model.status(&ctx(&me)).phase, SyncPhase::Syncing { done: 3, total: 10 });
        assert_eq!(model.on_event(Event::Session(Effect::Status(Phase::Online)), at(2)), vec![Reaction::Synced]);
        assert_eq!(model.last_sync_at, Some(at(2)));
        let applied = Applied { bookmark_ids: vec![1, 2], structure_changed: false, deferred: 0 };
        assert_eq!(model.on_event(Event::Session(Effect::LibraryChanged(applied.clone())), at(5)), vec![Reaction::Applied(applied)]);
        assert_eq!(model.last_sync_at, Some(at(5)));
    }

    #[test]
    fn devices_show_what_they_run_and_when_they_last_synced_even_offline() {
        let me = Identity::new("Studio Mac");
        let (laptop, old) = (uid(2), uid(3));
        let mut model = Model { me: Some(me.device), ..Model::default() };
        let directory = |online: Vec<Uuid>, old_status| {
            Event::Session(Effect::Devices {
                devices: vec![
                    info(me.device, "Studio Mac", DeviceStatus::Active),
                    info(laptop, "Laptop", DeviceStatus::Active),
                    info(old, "Old phone", old_status),
                ],
                online,
                hub: Some(me.device),
            })
        };
        model.on_event(directory(vec![me.device, laptop], DeviceStatus::Active), at(0));
        let hello = |device, app: &str| Event::Session(Effect::PeerHello { device, platform: "windows".into(), app: app.into() });
        assert_eq!(model.on_event(hello(laptop, "0.13.0"), at(1)), vec![Reaction::Peers]);
        assert!(model.on_event(hello(laptop, "0.13.0"), at(2)).is_empty(), "the same hello keeps nothing new");
        model.on_event(hello(old, "0.12.0"), at(2));
        assert_eq!(model.on_event(Event::Session(Effect::Synced { peer: laptop }), at(3)), vec![Reaction::Peers]);
        model.last_sync_at = Some(at(3));

        let shown = model.status(&ctx(&me));
        let other = shown.devices.iter().find(|d| d.id == laptop.to_string()).unwrap();
        assert_eq!((other.platform.as_deref(), other.app.as_deref(), other.last_sync_at), (Some("windows"), Some("0.13.0"), Some(at(3))));
        assert_eq!(shown.device.platform.as_deref(), Some(koona_sync::protocol::platform()), "this device's own");
        assert_eq!((shown.device.app.as_deref(), shown.device.last_sync_at), (Some("0.13.0"), Some(at(3))));
        assert_eq!(shown.bookmarks, Some(42));

        // Kept across a restart: the laptop offline still shows them.
        let kept: Peers = serde_json::from_str(&serde_json::to_string(&model.peers).unwrap()).unwrap();
        let mut again = Model { me: Some(me.device), peers: kept, ..Model::default() };
        again.on_event(directory(vec![me.device], DeviceStatus::Active), at(4));
        let other = again.status(&ctx(&me)).devices.into_iter().find(|d| d.id == laptop.to_string()).unwrap();
        assert!(!other.online);
        assert_eq!((other.app.as_deref(), other.last_sync_at), (Some("0.13.0"), Some(at(3))));

        // A removed device is forgotten.
        assert!(again.on_event(directory(vec![me.device], DeviceStatus::Revoked), at(5)).contains(&Reaction::Peers));
        assert!(!again.peers.devices.contains_key(&old));
    }

    #[test]
    fn the_clock_the_key_and_the_newer_peer_are_shown() {
        let me = Identity::new("Laptop");
        let hub = uid(9);
        let mut model = Model::default();
        assert_eq!((model.status(&ctx(&me)).clock_offset_ms, model.status(&ctx(&me)).epoch), (None, None));
        model.on_event(Event::Session(Effect::ClockOffset(-1_250)), at(0));
        model.on_event(Event::Session(Effect::KeyEpoch(Some(3))), at(0));
        let shown = model.status(&ctx(&me));
        assert_eq!((shown.clock_offset_ms, shown.epoch), (Some(-1_250), Some(3)));

        model.on_event(Event::Session(Effect::UpdateFrom(Some(hub))), at(1));
        model.on_event(Event::Session(Effect::Status(Phase::Paused { reason: PauseReason::UpdateNeeded })), at(1));
        assert_eq!(model.status(&ctx(&me)).update_from, Some(hub.to_string()));
        model.on_event(Event::Session(Effect::Status(Phase::Online)), at(2));
        assert_eq!(model.status(&ctx(&me)).update_from, None, "only while paused for it");
        // The relay's 4004 names nobody.
        model.on_event(Event::Stopped(Stop::UpdateNeeded), at(3));
        assert_eq!(model.status(&ctx(&me)).phase, SyncPhase::Paused { reason: PausedReason::UpdateNeeded });
        assert_eq!(model.status(&ctx(&me)).update_from, None);
    }

    #[test]
    fn a_pending_device_offers_once_and_again_only_when_the_hub_comes_back() {
        let me = Identity::new("Laptop");
        let hub = uid(9);
        let mut model = Model::default();
        let devices = |online: Vec<Uuid>| {
            Event::Session(Effect::Devices {
                devices: vec![info(hub, "Studio Mac", DeviceStatus::Active), info(me.device, "Laptop", DeviceStatus::Pending)],
                online,
                hub: Some(hub),
            })
        };
        model.on_event(devices(vec![me.device]), at(0));
        assert_eq!(model.on_event(Event::Session(Effect::Status(Phase::Pending)), at(0)), vec![Reaction::StartPairing]);
        model.on_event(Event::Session(Effect::Pairing(PairingEvent::Failed { peer: hub, reason: PairingFailure::Unavailable })), at(1));
        assert_eq!(model.status(&ctx(&me)).error, Some(SyncProblem::HubOffline));
        assert_eq!(model.on_event(devices(vec![me.device, hub]), at(2)), vec![Reaction::StartPairing], "the hub came online");
        model.on_event(Event::Session(Effect::Pairing(PairingEvent::Waiting { hub, hub_name: "Studio Mac".into() })), at(3));
        let prompt = model.status(&ctx(&me)).pairing.unwrap();
        assert_eq!((prompt.role, prompt.code), (PairingRole::Asking, None));
        assert_eq!(model.status(&ctx(&me)).error, None);
        model.on_event(
            Event::Session(Effect::Pairing(PairingEvent::Code { role: Role::Asking, peer: hub, peer_name: "Studio Mac".into(), code: "042917".into() })),
            at(4),
        );
        assert_eq!(model.status(&ctx(&me)).pairing.unwrap().code.as_deref(), Some("042917"));
        // Declined on the hub: nothing again by itself, even when the hub reconnects.
        model.on_event(Event::Session(Effect::Pairing(PairingEvent::Failed { peer: hub, reason: PairingFailure::Rejected })), at(5));
        model.on_event(devices(vec![me.device]), at(6));
        assert!(model.on_event(devices(vec![me.device, hub]), at(7)).is_empty());
        assert_eq!(model.status(&ctx(&me)).error, Some(SyncProblem::PairingRejected));
        assert_eq!(model.status(&ctx(&me)).pairing, None);
    }

    #[test]
    fn a_stop_shows_as_a_pause_until_a_new_client() {
        let me = Identity::new("Mac");
        let mut model = Model::default();
        model.on_event(Event::Session(Effect::Status(Phase::Online)), at(0));
        model.on_event(Event::Retrying(Duration::from_secs(4)), at(1));
        model.on_event(Event::Stopped(Stop::Plan(Some("not_in_beta".into()))), at(2));
        assert_eq!(model.status(&ctx(&me)).phase, SyncPhase::Paused { reason: PausedReason::Plan });
        model.on_event(Event::Stopped(Stop::Auth), at(3));
        assert_eq!(model.status(&ctx(&me)).phase, SyncPhase::Paused { reason: PausedReason::SignedOut });
        model.restart();
        assert_eq!(model.status(&ctx(&me)).phase, SyncPhase::Connecting);
        model.on_event(Event::Stopped(Stop::Shutdown), at(4));
        assert_eq!(model.stop, None, "a shutdown of ours is not a pause");
        model.on_event(Event::Session(Effect::Status(Phase::Paused { reason: PauseReason::ClockSkew })), at(5));
        assert_eq!(model.status(&ctx(&me)).phase, SyncPhase::Paused { reason: PausedReason::ClockSkew });
        assert!(model.log().count() >= 5, "the report has the story");
    }

    #[test]
    fn only_refusals_are_shown_as_errors_not_failed_dials() {
        let me = Identity::new("Mac");
        let mut model = Model::default();
        model.on_event(Event::Session(Effect::Error(SessionError::Relay("connection refused".into()))), at(0));
        assert_eq!(model.status(&ctx(&me)).error, None);
        model.on_event(Event::Session(Effect::Error(SessionError::Relay("forbidden".into()))), at(1));
        assert_eq!(model.status(&ctx(&me)).error, Some(SyncProblem::RelayRefused));
        model.on_event(Event::Session(Effect::Error(SessionError::Library("disk I/O error".into()))), at(2));
        assert_eq!(model.status(&ctx(&me)).error, Some(SyncProblem::LibraryFailed));
        let off = Context { enabled: false, ..ctx(&me) };
        assert_eq!(model.status(&off).error, None, "nothing to say with sync off");
        model.on_event(Event::Session(Effect::Error(SessionError::Relay("stale_sign_in".into()))), at(3));
        assert_eq!(model.status(&ctx(&me)).error, Some(SyncProblem::StaleSignIn));
    }

    fn hub_change(event: HubChangeEvent) -> Event {
        Event::Session(Effect::HubChange(event))
    }

    #[test]
    fn a_hub_change_is_shown_on_both_sides_until_it_settles() {
        let me = Identity::new("Laptop");
        let hub = uid(9);
        let mut model = Model::default();
        model.on_event(hub_change(HubChangeEvent::Waiting { hub, hub_name: "Studio Mac".into() }), at(0));
        let prompt = model.status(&ctx(&me)).hub_change.unwrap();
        assert_eq!((prompt.role, prompt.peer, prompt.peer_name), (HubChangeRole::Asking, hub.to_string(), "Studio Mac".to_string()));
        model.on_event(hub_change(HubChangeEvent::Failed { peer: hub, reason: HubChangeFailure::Denied }), at(1));
        assert_eq!(model.status(&ctx(&me)).hub_change, None);
        assert_eq!(model.status(&ctx(&me)).error, Some(SyncProblem::HubChangeDenied));
        model.on_event(hub_change(HubChangeEvent::Waiting { hub, hub_name: "Studio Mac".into() }), at(2));
        assert_eq!(model.status(&ctx(&me)).error, None, "asking again clears the last answer");
        for (reason, problem) in [
            (HubChangeFailure::Timeout, SyncProblem::HubChangeTimeout),
            (HubChangeFailure::Unavailable, SyncProblem::HubOffline),
            (HubChangeFailure::Busy, SyncProblem::HubChangeDenied),
        ] {
            model.on_event(hub_change(HubChangeEvent::Failed { peer: hub, reason }), at(3));
            assert_eq!(model.status(&ctx(&me)).error, Some(problem));
        }

        // On the hub: the question, then nothing once answered.
        let laptop = uid(2);
        model.on_event(hub_change(HubChangeEvent::Asked { device: laptop, name: "Laptop".into() }), at(4));
        let prompt = model.status(&ctx(&me)).hub_change.unwrap();
        assert_eq!((prompt.role, prompt.peer_name.as_str()), (HubChangeRole::Hub, "Laptop"));
        let off = Context { enabled: false, ..ctx(&me) };
        assert_eq!(model.status(&off).hub_change, None);
        model.on_event(hub_change(HubChangeEvent::Settled { peer: laptop }), at(5));
        assert_eq!(model.status(&ctx(&me)).hub_change, None);
        model.on_event(hub_change(HubChangeEvent::Asked { device: laptop, name: "Laptop".into() }), at(6));
        model.restart();
        assert_eq!(model.status(&ctx(&me)).hub_change, None, "a new client asks nothing yet");
    }

    #[test]
    fn devices_added_are_told_but_not_this_one_nor_the_first_directory() {
        let me = Identity::new("Studio Mac");
        let (laptop, phone) = (uid(2), uid(3));
        let mut model = Model { me: Some(me.device), ..Model::default() };
        let devices = |list: Vec<DeviceInfo>| Event::Session(Effect::Devices { devices: list, online: vec![me.device], hub: Some(me.device) });
        let mine = info(me.device, "Studio Mac", DeviceStatus::Active);

        // The first directory after sync was turned on.
        let reactions = model.on_event(devices(vec![mine.clone(), info(laptop, "Laptop", DeviceStatus::Active)]), at(0));
        assert_eq!(reactions, vec![Reaction::Notices], "what is known is kept");
        assert!(model.status(&ctx(&me)).notices.is_empty());

        // A pending device is not added yet; approved, it is.
        model.on_event(devices(vec![mine.clone(), info(laptop, "Laptop", DeviceStatus::Active), info(phone, "Phone", DeviceStatus::Pending)]), at(1));
        assert!(model.status(&ctx(&me)).notices.is_empty());
        let reactions = model.on_event(devices(vec![mine.clone(), info(laptop, "Laptop", DeviceStatus::Active), info(phone, "Phone", DeviceStatus::Active)]), at(2));
        assert_eq!(reactions, vec![Reaction::Notices]);
        let notices = model.status(&ctx(&me)).notices;
        assert_eq!(
            notices,
            vec![SyncNotice::DeviceAdded {
                id: format!("device-added-{phone}"),
                device: phone.to_string(),
                name: "Phone".into(),
                by_name: Some("Studio Mac".into()),
                at: at(2),
            }]
        );
        // The same directory again tells nothing.
        assert!(model.on_event(devices(vec![mine.clone(), info(laptop, "Laptop", DeviceStatus::Active), info(phone, "Phone", DeviceStatus::Active)]), at(3)).is_empty());

        // Kept across a restart; dismissed by id.
        let kept: Notices = serde_json::from_str(&serde_json::to_string(&model.notices).unwrap()).unwrap();
        assert_eq!(kept, model.notices);
        let mut again = Model { me: Some(me.device), notices: kept, ..Model::default() };
        assert!(again.notices.dismiss(&format!("device-added-{phone}")));
        assert!(!again.notices.dismiss("device-added-none"));
        assert!(again.status(&ctx(&me)).notices.is_empty());

        // Never more than the most kept, newest first.
        for n in 0..(MAX_NOTICES as u128 + 5) {
            again.notices.add(SyncNotice::DeviceAdded { id: format!("n{n}"), device: uid(100 + n).to_string(), name: "x".into(), by_name: None, at: at(9) });
        }
        assert_eq!(again.notices.list.len(), MAX_NOTICES);
        assert_eq!(again.notices.list[0].id(), format!("n{}", MAX_NOTICES + 4));
    }

    #[test]
    fn a_start_over_elsewhere_is_told_once_and_shown_as_a_pause() {
        let me = Identity::new("Laptop");
        let phone = uid(3);
        let mut model = Model { me: Some(me.device), ..Model::default() };
        let started = |epoch| Event::Session(Effect::StartedOver { by: phone, by_name: Some("Phone".into()), at: 1_760_400_005_000, epoch });
        assert_eq!(model.on_event(started(4), at(0)), vec![Reaction::Notices]);
        assert!(model.on_event(started(4), at(1)).is_empty(), "the same start over, seen again after a restart");
        model.on_event(Event::Session(Effect::Status(Phase::Paused { reason: PauseReason::StartedOver })), at(1));
        let shown = model.status(&ctx(&me));
        assert_eq!(shown.phase, SyncPhase::Paused { reason: PausedReason::StartedOver });
        assert_eq!(
            shown.notices,
            vec![SyncNotice::StartedOver {
                id: "started-over-4".into(),
                by: phone.to_string(),
                by_name: Some("Phone".into()),
                at: DateTime::from_timestamp(1_760_400_005, 0).unwrap(),
            }]
        );
        assert!(model.on_event(Event::Session(Effect::Status(Phase::Paused { reason: PauseReason::StartedOver })), at(2)).is_empty(), "no pairing offer while held");
        assert!(model.notices.joined());
        assert!(model.status(&ctx(&me)).notices.is_empty());
        assert_eq!(model.on_event(started(5), at(3)), vec![Reaction::Notices], "a later start over is told again");
    }
}
