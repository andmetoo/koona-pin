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
use koona_sync::session::{Effect, PairingEvent, PairingFailure, PauseReason, Phase, Role, SessionError};
use koona_sync::Applied;
use serde::Serialize;
use std::collections::VecDeque;
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
}

/// The facts the status depends on besides the events.
pub struct Context<'a> {
    pub enabled: bool,
    pub service: bool,
    pub plan: bool,
    pub library_ready: bool,
    pub identity: &'a Identity,
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

/// Relay error codes (`PROTOCOL.md` 2.3); any other text in `SessionError::Relay` is the
/// client's own failure to connect, which the phase shows as offline.
fn relay_refused(code: &str) -> bool {
    use koona_sync::protocol::relay_error::*;
    [BAD_MESSAGE, BAD_FRAME, FORBIDDEN, UNKNOWN_DEVICE, BAD_EPOCH].contains(&code)
}

fn problem_of(error: &SessionError) -> Option<SyncProblem> {
    Some(match error {
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
        self.online.clear();
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
            Effect::SendText(_) | Effect::SendBinary(_) => {}
        }
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
        SyncDevice {
            id: info.id.to_string(),
            name: info.name.clone(),
            online: self.online.contains(&info.id),
            is_hub: self.hub == Some(info.id),
            status: device_status(info.status),
            last_seen: Some(info.last_seen),
        }
    }

    pub fn status(&self, ctx: &Context<'_>) -> SyncStatus {
        let me = ctx.identity.device;
        let phase = self.phase_shown(ctx);
        let connected = matches!(phase, SyncPhase::Online | SyncPhase::Pending | SyncPhase::Syncing { .. });
        let device = match self.devices.iter().find(|d| d.id == me) {
            Some(info) => SyncDevice { online: connected, ..self.device(info) },
            None => SyncDevice {
                id: me.to_string(),
                name: ctx.identity.name.clone(),
                online: false,
                is_hub: false,
                status: SyncDeviceStatus::Unregistered,
                last_seen: None,
            },
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
        Context { enabled: true, service: true, plan: true, library_ready: true, identity }
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
    }
}
