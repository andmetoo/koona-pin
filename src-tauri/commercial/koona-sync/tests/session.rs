//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! Sessions on in-memory libraries, wired through a fake relay that routes as `PROTOCOL.md`
//! says: the hub alias, broadcasts, what a pending device may send, `undeliverable`, presence,
//! approve, revoke, set_hub and epoch. Everything runs in one thread on a fake clock.

mod common;

use common::*;
use koona_sync::crypto::{self, Ephemeral, Sealer};
use koona_sync::library::{load_meta, Library};
use koona_sync::model::Vector;
use koona_sync::protocol::{
    self, close, Address, Control, DeviceInfo, DeviceStatus, Header, Kind, PairMessage, StartedOver, B64,
};
use koona_sync::session::{
    Action, Config, DropReason, Effect, HubChangeEvent, HubChangeFailure, Input, PairingEvent, PairingFailure, Phase,
    PauseReason, Role, Session, SessionError, HUB_REQUEST_TIMEOUT_MS,
};
use ring::rand::SystemRandom;
use rusqlite::types::Value;
use rusqlite::Connection;
use std::collections::{BTreeMap, VecDeque};
use uuid::Uuid;

const SUB: &str = "account-1";
const START: u64 = 1_760_400_000_000;
/// The token of a sign-in by email code just now; any other is stale to the fake relay.
const FRESH_SIGN_IN: &str = "fresh-sign-in";

enum Msg {
    Text(String),
    Binary(Vec<u8>),
    Close(u16),
}

/// What the relay may do to a frame on the way: change it, or deliver it twice.
type Tamper = Box<dyn FnMut(Uuid, Uuid, &mut Vec<u8>) -> usize>;

#[derive(Default)]
struct Relay {
    devices: BTreeMap<Uuid, DeviceInfo>,
    hub: Option<Uuid>,
    epoch: u32,
    /// Device index -> the device it authenticated as.
    conns: BTreeMap<usize, Option<Uuid>>,
    nonces: BTreeMap<usize, [u8; 32]>,
    out: VecDeque<(usize, Msg)>,
    now: u64,
    tamper: Option<Tamper>,
    /// Frames delivered, for tests that replay one: (from, to, frame).
    log: Vec<(Uuid, Uuid, Vec<u8>)>,
    errors: Vec<String>,
    started_over: Option<StartedOver>,
}

impl Relay {
    fn conn_of(&self, device: Uuid) -> Option<usize> {
        self.conns.iter().find(|(_, d)| **d == Some(device)).map(|(i, _)| *i)
    }

    fn online(&self) -> Vec<Uuid> {
        self.conns.values().flatten().copied().collect()
    }

    fn notify(&mut self, message: &Control) {
        let text = protocol::encode_control(message);
        let targets: Vec<usize> = self.conns.iter().filter(|(_, d)| d.is_some()).map(|(i, _)| *i).collect();
        for i in targets {
            self.out.push_back((i, Msg::Text(text.clone())));
        }
    }

    fn send(&mut self, conn: usize, message: &Control) {
        self.out.push_back((conn, Msg::Text(protocol::encode_control(message))));
    }

    fn connect(&mut self, conn: usize) {
        let nonce: [u8; 32] = crypto::random(&SystemRandom::new()).unwrap();
        self.conns.insert(conn, None);
        self.nonces.insert(conn, nonce);
        self.send(conn, &Control::Challenge { nonce: B64(nonce), time: self.now });
    }

    fn disconnect(&mut self, conn: usize) {
        if let Some(Some(device)) = self.conns.remove(&conn) {
            if let Some(d) = self.devices.get_mut(&device) {
                d.last_seen = self.now;
            }
            self.notify(&Control::Presence { device, online: false });
        }
        self.out.retain(|(i, _)| *i != conn);
    }

    /// What was sent to the connection before still arrives, then the close.
    fn close(&mut self, conn: usize, code: u16) {
        if let Some(Some(device)) = self.conns.remove(&conn) {
            // A replaced socket leaves the device online.
            if code != close::REPLACED {
                self.notify(&Control::Presence { device, online: false });
            }
        }
        self.out.push_back((conn, Msg::Close(code)));
    }

    fn text(&mut self, conn: usize, text: &str) {
        let Ok(message) = protocol::decode_control(text) else {
            return self.send(conn, &Control::Error { code: "bad_message".into() });
        };
        let Some(&me) = self.conns.get(&conn) else { return };
        let Some(me) = me else {
            let Control::Hello { device, key, name, sig, .. } = message else { return self.close(conn, close::AUTH) };
            let nonce = self.nonces[&conn];
            if crypto::verify_relay_hello(&key.0, SUB, &nonce, device, &sig.0).is_err() {
                return self.close(conn, close::AUTH);
            }
            let mut registered = None;
            match self.devices.get(&device) {
                Some(d) if d.key != key => return self.close(conn, close::AUTH),
                Some(d) if d.status == DeviceStatus::Revoked => return self.close(conn, close::REVOKED),
                Some(_) => {}
                None => {
                    let first = !self.devices.values().any(|d| d.status == DeviceStatus::Active);
                    let status = if first { DeviceStatus::Active } else { DeviceStatus::Pending };
                    let info = DeviceInfo { id: device, name, key, status, last_seen: self.now };
                    self.devices.insert(device, info.clone());
                    if first {
                        self.hub = Some(device);
                        self.epoch = 0;
                    }
                    registered = Some(info);
                }
            }
            if let Some(old) = self.conn_of(device) {
                self.close(old, close::REPLACED);
            }
            self.conns.insert(conn, Some(device));
            let welcome = Control::Welcome {
                status: self.devices[&device].status,
                hub: self.hub.unwrap(),
                epoch: self.epoch,
                devices: self.devices.values().cloned().collect(),
                online: self.online(),
                time: self.now,
                started_over: self.started_over,
            };
            // welcome, then the `device` notice of a new registration, then presence.
            self.send(conn, &welcome);
            if let Some(info) = registered {
                self.notify(&Control::Device { device: info });
            }
            self.notify(&Control::Presence { device, online: true });
            return;
        };
        let status = self.devices[&me].status;
        let is_hub = self.hub == Some(me);
        let refuse = |relay: &mut Relay, code: &str| {
            relay.errors.push(code.to_string());
            relay.send(conn, &Control::Error { code: code.into() })
        };
        if let Control::StartOver { token } = &message {
            if token != FRESH_SIGN_IN {
                return refuse(self, "stale_sign_in");
            }
            // 2.6 steps 3 and 4.
            self.devices.retain(|id, d| *id == me || d.status == DeviceStatus::Revoked);
            if let Some(d) = self.devices.get_mut(&me) {
                d.status = DeviceStatus::Active;
            }
            self.hub = Some(me);
            self.epoch += 1;
            self.started_over = Some(StartedOver { by: me, at: self.now, epoch: self.epoch });
            let conns: Vec<usize> = self.conns.keys().copied().collect();
            for c in conns {
                self.close(c, close::STARTED_OVER);
            }
            return;
        }
        if status != DeviceStatus::Active {
            return refuse(self, "forbidden");
        }
        match message {
            Control::Approve { device } => {
                if !is_hub {
                    return refuse(self, "forbidden");
                }
                match self.devices.get_mut(&device) {
                    Some(d) if d.status == DeviceStatus::Pending => {
                        d.status = DeviceStatus::Active;
                        let info = d.clone();
                        self.notify(&Control::Device { device: info });
                    }
                    _ => refuse(self, "unknown_device"),
                }
            }
            Control::Revoke { device } => {
                if !is_hub {
                    return refuse(self, "forbidden");
                }
                match self.devices.get_mut(&device) {
                    Some(d) if d.status != DeviceStatus::Revoked && Some(device) != self.hub => {
                        d.status = DeviceStatus::Revoked;
                        let info = d.clone();
                        if let Some(c) = self.conn_of(device) {
                            self.close(c, close::REVOKED);
                        }
                        self.notify(&Control::Device { device: info });
                    }
                    _ => refuse(self, "unknown_device"),
                }
            }
            Control::SetHub { device } => {
                if !is_hub {
                    return refuse(self, "forbidden");
                }
                match self.devices.get(&device) {
                    Some(d) if d.status == DeviceStatus::Active => {
                        self.hub = Some(device);
                        self.notify(&Control::Account { hub: device, epoch: self.epoch });
                    }
                    _ => refuse(self, "unknown_device"),
                }
            }
            Control::Epoch { epoch } => {
                if !is_hub {
                    return refuse(self, "forbidden");
                }
                if epoch <= self.epoch {
                    return refuse(self, "bad_epoch");
                }
                self.epoch = epoch;
                self.notify(&Control::Account { hub: self.hub.unwrap(), epoch });
            }
            Control::Rename { device, name } => {
                if let Some(d) = self.devices.get_mut(&device) {
                    d.name = name;
                    let info = d.clone();
                    self.notify(&Control::Device { device: info });
                }
            }
            _ => refuse(self, "bad_message"),
        }
    }

    fn binary(&mut self, conn: usize, frame: &[u8]) {
        let Some(&Some(from)) = self.conns.get(&conn) else { return };
        let Ok((to, body)) = protocol::decode_outgoing(frame) else {
            return self.send(conn, &Control::Error { code: "bad_frame".into() });
        };
        if body.len() < 2 {
            return self.send(conn, &Control::Error { code: "bad_frame".into() });
        }
        let kind = body[1];
        let sender = self.devices[&from].status;
        let hub = self.hub.unwrap();
        if sender == DeviceStatus::Pending && (kind != 2 || !(to == Address::Hub || to == Address::Device(hub))) {
            return self.send(conn, &Control::Error { code: "bad_frame".into() });
        }
        // Frames to oneself are echoed.
        let deliverable = |relay: &Relay, target: Uuid| {
            relay.conn_of(target).is_some()
                && match relay.devices[&target].status {
                    DeviceStatus::Active => true,
                    DeviceStatus::Pending => kind == 2 && from == hub,
                    DeviceStatus::Revoked => false,
                }
        };
        let targets: Vec<Uuid> = match to {
            Address::Hub => vec![hub],
            Address::All => self
                .devices
                .keys()
                .copied()
                .filter(|d| *d != from && self.devices[d].status == DeviceStatus::Active)
                .collect(),
            Address::Device(id) => vec![id],
        };
        let targets: Vec<Uuid> = targets.into_iter().filter(|t| deliverable(self, *t)).collect();
        if targets.is_empty() {
            if to != Address::All {
                self.send(conn, &Control::Undeliverable { to: to.as_uuid() });
            }
            return;
        }
        for target in targets {
            let mut body = body.to_vec();
            let copies = match self.tamper.as_mut() {
                Some(tamper) => tamper(from, target, &mut body),
                None => 1,
            };
            let delivered = protocol::encode_delivered(from, self.now, &body).unwrap();
            self.log.push((from, target, delivered.clone()));
            let c = self.conn_of(target).unwrap();
            for _ in 0..copies {
                self.out.push_back((c, Msg::Binary(delivered.clone())));
            }
        }
    }
}

struct Device {
    session: Session,
    lib: Connection,
    id: Uuid,
    connected: bool,
    /// Added to the relay's clock for this device's own.
    offset: i64,
    events: Vec<Effect>,
    /// Each binary frame sent, with how many events came before it.
    sent: Vec<(usize, Vec<u8>)>,
}

struct World {
    relay: Relay,
    devices: Vec<Device>,
}

impl World {
    fn new() -> World {
        World { relay: Relay { now: START, ..Relay::default() }, devices: Vec::new() }
    }

    fn add(&mut self, name: &str, replica: u8, chunk_bytes: usize) -> usize {
        // Each chunk applied as it comes, so a broken link leaves part of a snapshot to check.
        self.add_holding(name, replica, chunk_bytes, 1)
    }

    fn add_holding(&mut self, name: &str, replica: u8, chunk_bytes: usize, hold_groups: usize) -> usize {
        let rng = SystemRandom::new();
        let pair = crypto::device_key(&crypto::generate_device_key(&rng).unwrap()).unwrap();
        let id = Uuid::new_v4();
        let mut cfg = Config::new(id, pair, SUB.into(), name.into(), "0.13.0".into());
        cfg.chunk_bytes = chunk_bytes;
        cfg.hold_groups = hold_groups;
        let lib = library(replica_id(replica));
        koona_sync::set_wall_clock(&lib, Some(START)).unwrap();
        self.devices.push(Device {
            session: Session::new(cfg, Box::new(SystemRandom::new())),
            lib,
            id,
            connected: false,
            offset: 0,
            events: Vec::new(),
            sent: Vec::new(),
        });
        self.devices.len() - 1
    }

    fn local_now(&self, i: usize) -> u64 {
        (self.relay.now as i64 + self.devices[i].offset) as u64
    }

    fn feed(&mut self, i: usize, input: Input<'_>) {
        let now = self.local_now(i);
        let d = &mut self.devices[i];
        let effects = d.session.handle(&mut d.lib, now, input);
        self.effects(i, effects);
    }

    fn act(&mut self, i: usize, action: Action) {
        let now = self.local_now(i);
        let d = &mut self.devices[i];
        let effects = d.session.act(&mut d.lib, now, action);
        self.effects(i, effects);
    }

    fn effects(&mut self, i: usize, effects: Vec<Effect>) {
        for effect in effects {
            match effect {
                Effect::SendText(text) => {
                    if self.devices[i].connected {
                        self.relay.text(i, &text)
                    }
                }
                Effect::SendBinary(frame) => {
                    let before = self.devices[i].events.len();
                    self.devices[i].sent.push((before, frame.clone()));
                    if self.devices[i].connected {
                        self.relay.binary(i, &frame)
                    }
                }
                other => self.devices[i].events.push(other),
            }
        }
    }

    fn connect(&mut self, i: usize) {
        self.devices[i].connected = true;
        self.feed(i, Input::Dialing);
        self.feed(i, Input::Connected);
        self.relay.connect(i);
    }

    /// The network goes away under the device.
    fn drop_link(&mut self, i: usize) {
        self.relay.disconnect(i);
        self.devices[i].connected = false;
        self.feed(i, Input::Closed { code: None, reason: None });
    }

    /// Delivers one message or one pump; false when nothing is left to do.
    fn step(&mut self) -> bool {
        if let Some((i, msg)) = self.relay.out.pop_front() {
            if !self.devices[i].connected {
                return true;
            }
            match msg {
                Msg::Text(text) => self.feed(i, Input::Text(&text)),
                Msg::Binary(frame) => self.feed(i, Input::Binary(&frame)),
                Msg::Close(code) => {
                    self.devices[i].connected = false;
                    self.feed(i, Input::Closed { code: Some(code), reason: None });
                }
            }
            return true;
        }
        for i in 0..self.devices.len() {
            if self.devices[i].connected && self.devices[i].session.wants_pump() {
                self.feed(i, Input::Pump);
                return true;
            }
        }
        false
    }

    fn run(&mut self) {
        let mut steps = 0;
        while self.step() {
            steps += 1;
            assert!(steps < 200_000, "the sessions never settle");
        }
    }

    fn tick(&mut self, ms: u64) {
        self.relay.now += ms;
        for i in 0..self.devices.len() {
            if self.devices[i].connected {
                koona_sync::set_wall_clock(&self.devices[i].lib, Some(self.local_now(i))).unwrap();
                self.feed(i, Input::Tick);
            }
        }
        self.run();
    }

    fn phase(&self, i: usize) -> Phase {
        self.devices[i].session.phase()
    }

    fn codes(&self, i: usize) -> Vec<(Role, String)> {
        self.devices[i]
            .events
            .iter()
            .filter_map(|e| match e {
                Effect::Pairing(PairingEvent::Code { role, code, .. }) => Some((*role, code.clone())),
                _ => None,
            })
            .collect()
    }

    fn hub_events(&self, i: usize) -> Vec<HubChangeEvent> {
        self.devices[i]
            .events
            .iter()
            .filter_map(|e| match e {
                Effect::HubChange(event) => Some(event.clone()),
                _ => None,
            })
            .collect()
    }

    fn last_hub_event(&self, i: usize) -> Option<HubChangeEvent> {
        self.hub_events(i).pop()
    }

    /// Device `asking` asks the hub `hub` to hand over and the person on the hub answers.
    fn hand_over(&mut self, asking: usize, hub: usize, allow: bool) {
        self.act(asking, Action::RequestHub);
        self.run();
        let id = self.devices[asking].id;
        assert!(matches!(self.last_hub_event(hub), Some(HubChangeEvent::Asked { device, .. }) if device == id));
        self.act(hub, Action::AnswerHubRequest { allow });
        self.run();
    }

    fn dropped(&self, i: usize, reason: DropReason) -> usize {
        self.devices[i].events.iter().filter(|e| matches!(e, Effect::Dropped { reason: r, .. } if *r == reason)).count()
    }

    /// Pairs device `i` through the hub `hub`, comparing the digits on both screens.
    fn pair(&mut self, i: usize, hub: usize) {
        self.connect(i);
        self.run();
        assert_eq!(self.phase(i), Phase::Pending);
        self.act(i, Action::StartPairing);
        self.run();
        let (asking, hosting) = (self.codes(i), self.codes(hub));
        let (Some(a), Some(h)) = (asking.last(), hosting.last()) else { panic!("no code shown") };
        assert_eq!((a.0, h.0), (Role::Asking, Role::Hub));
        assert_eq!(a.1, h.1, "both screens show the same digits");
        assert_eq!(a.1.len(), 6);
        let device = self.devices[i].id;
        self.act(hub, Action::ApprovePairing { device });
        self.run();
        assert!(self.devices[i].events.iter().any(|e| matches!(e, Effect::Pairing(PairingEvent::Paired { .. }))));
        assert_eq!(self.phase(i), Phase::Online);
    }

    fn lib(&self, i: usize) -> &Connection {
        &self.devices[i].lib
    }

    fn assert_converged(&self, which: &[usize]) {
        let first = dump(self.lib(which[0]));
        for &i in &which[1..] {
            assert_eq!(dump(self.lib(i)), first, "library {i} differs from library {}", which[0]);
            assert_eq!(held(self.lib(i)), held(self.lib(which[0])), "vector of {i}");
            check_invariants(self.lib(i));
        }
    }
}

/// The vector without replicas of which nothing is held.
fn held(conn: &Connection) -> Vector {
    let mut v = vector(conn);
    v.0.retain(|_, c| *c > 0);
    v
}

fn fill(conn: &Connection, n: usize, prefix: &str) {
    for k in 0..n {
        let id = add_bookmark(conn, Uuid::new_v4(), &format!("https://{prefix}.example/{k}"), &format!("{prefix} {k}")).unwrap();
        set_bookmark(conn, id, "notes", Value::Text(format!("notes of {prefix} {k} ").repeat(8)));
        if k % 3 == 0 {
            tag(conn, id, Uuid::new_v4(), &format!("{prefix}-tag-{}", k % 7));
        }
    }
}

fn count(conn: &Connection) -> i64 {
    one(conn, "SELECT count(*) FROM bookmarks")
}

#[test]
fn the_first_device_is_the_hub_and_a_new_one_pairs_and_gets_the_library() {
    let mut w = World::new();
    let a = w.add("Studio Mac", 1, 4 << 10);
    let b = w.add("Laptop", 2, 4 << 10);
    fill(w.lib(a), 300, "a");
    w.connect(a);
    w.run();
    assert_eq!(w.phase(a), Phase::Online);
    assert!(w.devices[a].session.is_hub());
    assert_eq!(w.devices[a].session.epochs(), (0, Some(0)));
    assert!(load_meta(w.lib(a)).unwrap().key.is_some(), "the hub made the library key");

    // Pairing, then the snapshot in many small chunks; the link breaks part way.
    w.connect(b);
    w.run();
    assert_eq!(w.phase(b), Phase::Pending);
    w.act(b, Action::StartPairing);
    w.run();
    assert_eq!(w.codes(a)[0].1, w.codes(b)[0].1);
    let device = w.devices[b].id;
    w.act(a, Action::ApprovePairing { device });
    let mut steps = 0;
    while count(w.lib(b)) < 100 {
        assert!(w.step(), "the snapshot stopped");
        steps += 1;
        assert!(steps < 100_000);
    }
    assert!(matches!(w.phase(b), Phase::Syncing { .. }), "{:?}", w.phase(b));
    w.drop_link(b);
    let partial = count(w.lib(b));
    assert!(partial > 0 && partial < 300);
    assert_ne!(vector(w.lib(b)), vector(w.lib(a)), "covers are not merged before the last batch");
    w.run();

    w.connect(b);
    w.run();
    assert_eq!(count(w.lib(b)), 300);
    assert_eq!(w.phase(b), Phase::Online);
    w.assert_converged(&[a, b]);
    let meta = load_meta(w.lib(b)).unwrap();
    assert_eq!(meta.key, load_meta(w.lib(a)).unwrap().key, "the new device holds the library key");
    assert_eq!(meta.roster.unwrap().devices.len(), 2, "the roster names both devices");
    let changed = w.devices[b].events.iter().filter(|e| matches!(e, Effect::LibraryChanged(_))).count();
    assert!(changed > 10, "the snapshot came in many batches");

    // Edits on both sides meet.
    let x = add_bookmark(w.lib(a), Uuid::new_v4(), "https://both.example/1", "from a").unwrap();
    w.act(a, Action::LocalChange);
    fill(w.lib(b), 5, "b");
    w.act(b, Action::LocalChange);
    w.run();
    set_bookmark(w.lib(a), x, "title", Value::Text("renamed on a".into()));
    w.act(a, Action::LocalChange);
    w.run();
    w.assert_converged(&[a, b]);
    assert_eq!(count(w.lib(a)), 306);
}

#[test]
fn a_snapshot_in_many_chunks_is_applied_once_at_its_end() {
    let mut w = World::new();
    let a = w.add("Studio Mac", 1, 4 << 10);
    let b = w.add_holding("Laptop", 2, 4 << 10, koona_sync::session::HOLD_GROUPS);
    fill(w.lib(a), 300, "a");
    w.connect(a);
    w.run();
    w.connect(b);
    w.run();
    w.act(b, Action::StartPairing);
    w.run();
    let device = w.devices[b].id;
    w.act(a, Action::ApprovePairing { device });
    w.run();
    assert_eq!(count(w.lib(b)), 300);
    w.assert_converged(&[a, b]);
    let changed = w.devices[b].events.iter().filter(|e| matches!(e, Effect::LibraryChanged(_))).count();
    assert_eq!(changed, 1, "the chunks were held and applied in one transaction");
}

/// The interface asks to pair when the device turns pending and again when it sees the hub
/// online, which can both come from one `welcome` (found by the end-to-end test): one offer
/// goes, and the pairing completes.
#[test]
fn asking_twice_sends_one_offer() {
    let mut w = World::new();
    let a = w.add("Studio Mac", 1, 4 << 10);
    let b = w.add("Laptop", 2, 4 << 10);
    w.connect(a);
    w.run();
    w.connect(b);
    w.run();
    let hub = w.devices[a].id;
    let devices = w.devices[b].events.iter().find_map(|e| match e {
        Effect::Devices { hub, .. } => Some(*hub),
        _ => None,
    });
    assert_eq!(devices, Some(Some(hub)), "the first directory a new device shows names the hub");
    w.act(b, Action::StartPairing);
    w.act(b, Action::StartPairing);
    w.run();
    assert_eq!(w.codes(a).len(), 1, "the hub got one offer");
    assert_eq!(w.codes(b).len(), 1);
    assert_eq!(w.codes(a)[0].1, w.codes(b)[0].1);
    assert_eq!(w.dropped(b, DropReason::BadSignature), 0);
    let device = w.devices[b].id;
    w.act(a, Action::ApprovePairing { device });
    w.run();
    assert_eq!(w.phase(b), Phase::Online);
}

#[test]
fn a_rejected_or_tampered_pairing_gets_no_key() {
    let mut w = World::new();
    let a = w.add("Hub", 1, 64 << 10);
    let b = w.add("Stranger", 2, 64 << 10);
    let c = w.add("Victim", 3, 64 << 10);
    w.connect(a);
    w.run();

    // The digits differ on the screens (the person says so): Reject.
    w.connect(b);
    w.run();
    w.act(b, Action::StartPairing);
    w.run();
    let device = w.devices[b].id;
    w.act(a, Action::RejectPairing { device });
    w.run();
    assert!(w.devices[b].events.iter().any(|e| matches!(
        e,
        Effect::Pairing(PairingEvent::Failed { reason: PairingFailure::Rejected, .. })
    )));
    assert_eq!(w.phase(b), Phase::Paused { reason: PauseReason::Revoked });
    assert!(load_meta(w.lib(b)).unwrap().key.is_none());

    // The relay swaps the hub's X25519 key in `pair_accept`: the hub's signature no longer holds.
    w.relay.tamper = Some(Box::new(|_, _, body: &mut Vec<u8>| {
        if body[1] == Kind::Pairing as u8 {
            if let Ok(PairMessage::PairAccept { sig, .. }) = PairMessage::decode(&body[protocol::HEADER_LEN..]) {
                let mut forged = body[..protocol::HEADER_LEN].to_vec();
                forged.extend(PairMessage::PairAccept { eph: B64([9; 32]), sig }.encode().unwrap());
                *body = forged;
            }
        }
        1
    }));
    w.connect(c);
    w.run();
    w.act(c, Action::StartPairing);
    w.run();
    assert!(w.devices[c].events.iter().any(|e| matches!(
        e,
        Effect::Pairing(PairingEvent::Failed { reason: PairingFailure::BadSignature, .. })
    )));
    assert!(w.codes(c).is_empty(), "no code is shown for a forged answer");
    assert!(load_meta(w.lib(c)).unwrap().key.is_none());
}

#[test]
fn a_reveal_other_than_the_committed_key_is_refused() {
    // A relay playing the hub would choose its key after seeing the device's, to grind the
    // codes into matching. With the commitment it sees only `commit` before `pair_accept`, and a
    // device key swapped afterwards in `pair_reveal` doesn't match it: the hub shows no code.
    let mut w = World::new();
    let a = w.add("Hub", 1, 64 << 10);
    let b = w.add("Victim", 2, 64 << 10);
    w.connect(a);
    w.run();
    let relays_key = Ephemeral::generate(&SystemRandom::new()).unwrap().public();
    w.relay.tamper = Some(Box::new(move |_, _, body: &mut Vec<u8>| {
        if body[1] == Kind::Pairing as u8 {
            if let Ok(PairMessage::PairReveal { .. }) = PairMessage::decode(&body[protocol::HEADER_LEN..]) {
                let mut forged = body[..protocol::HEADER_LEN].to_vec();
                forged.extend(PairMessage::PairReveal { eph: B64(relays_key) }.encode().unwrap());
                *body = forged;
            }
        }
        1
    }));
    w.connect(b);
    w.run();
    w.act(b, Action::StartPairing);
    w.run();
    assert!(w.codes(a).is_empty(), "the hub shows no code for a key the offer didn't commit to");
    assert!(w.devices[a].events.iter().any(|e| matches!(
        e,
        Effect::Pairing(PairingEvent::Failed { reason: PairingFailure::BadSignature, .. })
    )));
    assert_eq!(w.dropped(a, DropReason::BadSignature), 1);
    let device = w.devices[b].id;
    w.act(a, Action::ApprovePairing { device });
    w.run();
    assert!(load_meta(w.lib(b)).unwrap().key.is_none());
}

/// The pairing message in a frame a device sent, if it is one.
fn sent_pairing(frame: &[u8]) -> Option<PairMessage> {
    let (_, body) = protocol::decode_outgoing(frame).ok()?;
    (body[1] == Kind::Pairing as u8).then(|| PairMessage::decode(&body[protocol::HEADER_LEN..]).ok())?
}

#[test]
fn each_side_shows_its_code_only_after_the_reveal() {
    let mut w = World::new();
    let a = w.add("Hub", 1, 64 << 10);
    let b = w.add("Laptop", 2, 64 << 10);
    let c = w.add("Phone", 3, 64 << 10);
    w.connect(a);
    w.run();
    w.connect(b);
    w.connect(c);
    w.run();
    let idb = w.devices[b].id;
    // The relay holds back the laptop's reveal.
    w.relay.tamper = Some(Box::new(move |from, _, body: &mut Vec<u8>| {
        let reveal = from == idb && matches!(PairMessage::decode(&body[protocol::HEADER_LEN..]), Ok(PairMessage::PairReveal { .. }));
        usize::from(!reveal)
    }));
    w.act(b, Action::StartPairing);
    w.run();

    // The laptop sent its reveal before it showed its code; the hub, without it, shows nothing.
    let (before_reveal, _) = w.devices[b].sent.iter().find(|(_, f)| matches!(sent_pairing(f), Some(PairMessage::PairReveal { .. }))).unwrap().clone();
    let shown = w.devices[b].events.iter().position(|e| matches!(e, Effect::Pairing(PairingEvent::Code { .. }))).unwrap();
    assert!(shown >= before_reveal, "the code came after the reveal");
    assert_eq!(w.codes(b).len(), 1);
    assert!(w.codes(a).is_empty(), "no code on the hub before the reveal");

    // The silent offer holds the hub for a while, then no longer.
    w.act(c, Action::StartPairing);
    w.run();
    assert!(w.devices[c].events.iter().any(|e| matches!(e, Effect::Pairing(PairingEvent::Failed { reason: PairingFailure::Rejected, .. }))));
    w.tick(koona_sync::session::REVEAL_TIMEOUT_MS);
    w.act(c, Action::StartPairing);
    w.run();
    let (on_phone, on_hub) = (w.codes(c), w.codes(a));
    assert_eq!(on_hub.len(), 1, "the hub showed a code for the phone only");
    assert_eq!(on_phone.last().unwrap().1, on_hub[0].1);
    let phone = w.devices[c].id;
    w.act(a, Action::ApprovePairing { device: phone });
    w.run();
    assert!(load_meta(w.lib(c)).unwrap().key.is_some());
}

#[test]
fn a_replayed_reveal_does_not_end_the_pairing() {
    let mut w = World::new();
    let a = w.add("Hub", 1, 64 << 10);
    let b = w.add("Laptop", 2, 64 << 10);
    w.connect(a);
    w.run();
    w.connect(b);
    w.run();
    let (ida, idb) = (w.devices[a].id, w.devices[b].id);
    // The relay holds the laptop's reveal back for now.
    let held = std::rc::Rc::new(std::cell::RefCell::new(None));
    let hold = held.clone();
    w.relay.tamper = Some(Box::new(move |from, _, body: &mut Vec<u8>| {
        if from == idb && matches!(PairMessage::decode(&body[protocol::HEADER_LEN..]), Ok(PairMessage::PairReveal { .. })) {
            *hold.borrow_mut() = Some(body.clone());
            return 0;
        }
        1
    }));
    w.act(b, Action::StartPairing);
    w.run();
    assert!(w.codes(a).is_empty());

    // Under the offer's header (an old `seq`), a reveal with another key is a replay: dropped,
    // and the hub keeps waiting for the real one.
    let offer = w.relay.log.iter().find(|(from, to, _)| *from == idb && *to == ida).unwrap().2.clone();
    let delivered = protocol::decode_delivered(&offer).unwrap();
    let mut replayed = delivered.body[..protocol::HEADER_LEN].to_vec();
    replayed.extend(PairMessage::PairReveal { eph: B64([9; 32]) }.encode().unwrap());
    w.feed(a, Input::Binary(&protocol::encode_delivered(idb, delivered.relay_ms, &replayed).unwrap()));
    w.run();
    assert_eq!(w.dropped(a, DropReason::Replayed), 1);
    assert!(!w.devices[a].events.iter().any(|e| matches!(e, Effect::Pairing(PairingEvent::Failed { .. }))));

    let reveal = held.borrow_mut().take().unwrap();
    w.feed(a, Input::Binary(&protocol::encode_delivered(idb, w.relay.now, &reveal).unwrap()));
    w.run();
    assert_eq!(w.codes(a).len(), 1);
    assert_eq!(w.codes(a)[0].1, w.codes(b)[0].1);
    w.act(a, Action::ApprovePairing { device: idb });
    w.run();
    assert!(load_meta(w.lib(b)).unwrap().key.is_some(), "the pairing went through");
}

#[test]
fn a_v1_offer_is_told_to_update_and_the_hub_does_not_pause() {
    let mut w = World::new();
    let a = w.add("Hub", 1, 64 << 10);
    let b = w.add("Old", 2, 64 << 10);
    w.connect(a);
    w.run();
    w.connect(b);
    w.run();
    // What a v1 build sends: its X25519 key in the clear, no commitment.
    let (ida, idb) = (w.devices[a].id, w.devices[b].id);
    let offer = serde_json::json!({"t": "pair_offer", "device": idb, "eph": B64([7; 32]), "key": B64([8; 32]), "sig": B64([9; 64])});
    let header = Header { kind: Kind::Pairing, epoch: 0, session: [3; 16], seq: 0 };
    let mut body = header.encode().to_vec();
    body.extend(protocol::encode_payload(&offer).unwrap());
    let frame = protocol::encode_delivered(idb, w.relay.now, &body).unwrap();
    w.feed(a, Input::Binary(&frame));
    w.run();
    assert!(w.codes(a).is_empty());
    assert_ne!(w.phase(a), Phase::Paused { reason: PauseReason::UpdateNeeded });
    assert!(w.devices[b].events.iter().any(|e| matches!(
        e,
        Effect::Error(koona_sync::session::SessionError::Peer { device, code: protocol::ErrorCode::UpdateNeeded }) if *device == ida
    )));
}

#[test]
fn peers_sync_without_the_hub_and_meet_it_again() {
    let mut w = World::new();
    let a = w.add("Hub", 1, 64 << 10);
    let b = w.add("Laptop", 2, 64 << 10);
    let c = w.add("Phone", 3, 64 << 10);
    fill(w.lib(a), 20, "a");
    w.connect(a);
    w.run();
    w.pair(b, a);
    w.pair(c, a);
    w.run();
    w.assert_converged(&[a, b, c]);

    // Through the hub.
    fill(w.lib(b), 3, "b");
    w.act(b, Action::LocalChange);
    w.run();
    w.assert_converged(&[a, b, c]);

    // The hub goes away; the others sync directly.
    w.drop_link(a);
    w.run();
    fill(w.lib(b), 4, "b2");
    w.act(b, Action::LocalChange);
    fill(w.lib(c), 4, "c");
    w.act(c, Action::LocalChange);
    w.run();
    w.assert_converged(&[b, c]);
    assert_eq!(count(w.lib(c)), 31);

    w.connect(a);
    w.run();
    w.assert_converged(&[a, b, c]);
    assert_eq!(count(w.lib(a)), 31);
}

#[test]
fn a_removed_device_is_cut_off_by_a_new_key() {
    let mut w = World::new();
    let a = w.add("Hub", 1, 64 << 10);
    let b = w.add("Laptop", 2, 64 << 10);
    let c = w.add("Lost phone", 3, 64 << 10);
    w.connect(a);
    w.run();
    w.pair(b, a);
    w.pair(c, a);
    let (_, old_key) = load_meta(w.lib(c)).unwrap().key.unwrap();

    let device = w.devices[c].id;
    w.act(a, Action::RemoveDevice { device });
    w.run();
    assert_eq!(w.phase(c), Phase::Paused { reason: PauseReason::Revoked });
    assert!(load_meta(w.lib(c)).unwrap().key.is_none(), "a revoked device forgets the key");
    assert_eq!(w.devices[a].session.epochs(), (1, Some(1)));
    assert_eq!(w.devices[b].session.epochs(), (1, Some(1)), "the other device rekeyed");
    let roster = load_meta(w.lib(b)).unwrap().roster.unwrap();
    assert!(roster.key_of(device).is_none(), "the roster drops the removed device");

    w.relay.log.clear();
    fill(w.lib(a), 3, "after");
    w.act(a, Action::LocalChange);
    w.run();
    w.assert_converged(&[a, b]);
    // Whatever the relay hands it, the old key opens nothing sent since.
    let (from, to, frame) = w.relay.log.iter().find(|(_, to, _)| *to == w.devices[b].id).unwrap().clone();
    let delivered = protocol::decode_delivered(&frame).unwrap();
    let (header, _) = Header::parse(delivered.body).unwrap();
    assert_eq!(header.epoch, 1);
    assert!(crypto::open_for(&old_key, from, to, delivered.body).is_err());
    assert!(crypto::open_for(&old_key, from, device, delivered.body).is_err());
    // And it can't come back.
    w.connect(c);
    w.run();
    assert_eq!(w.phase(c), Phase::Paused { reason: PauseReason::Revoked });

    // A new hub takes over from the roster and serves a rekey later.
    w.hand_over(b, a, true);
    assert!(w.devices[b].session.is_hub());
    fill(w.lib(a), 2, "under b");
    w.act(a, Action::LocalChange);
    w.run();
    w.assert_converged(&[a, b]);
}

#[test]
fn a_clock_far_off_pauses_sync_until_it_is_right() {
    let mut w = World::new();
    let a = w.add("Hub", 1, 64 << 10);
    let b = w.add("Laptop", 2, 64 << 10);
    w.connect(a);
    w.run();
    w.pair(b, a);
    w.drop_link(b);
    w.run();

    w.devices[b].offset = 10 * 60 * 1000;
    fill(w.lib(a), 5, "a");
    w.connect(b);
    w.run();
    assert_eq!(w.phase(b), Phase::Paused { reason: PauseReason::ClockSkew });
    assert_eq!(count(w.lib(b)), 0, "nothing is applied with a wrong clock");
    w.act(a, Action::LocalChange);
    w.run();
    assert_eq!(count(w.lib(b)), 0);

    // The clock is fixed; the hub greets it again and it checks the next frame's time.
    w.devices[b].offset = 0;
    w.tick(61_000);
    w.run();
    assert_eq!(w.phase(b), Phase::Online);
    w.assert_converged(&[a, b]);
}

#[test]
fn a_newer_peer_pauses_sync_with_it() {
    let mut w = World::new();
    let a = w.add("Hub", 1, 64 << 10);
    let b = w.add("Laptop", 2, 64 << 10);
    w.connect(a);
    w.run();
    w.pair(b, a);
    let before = vector(w.lib(b));

    // A body as a newer build would seal it: a message this build doesn't know.
    let (epoch, key) = load_meta(w.lib(a)).unwrap().key.unwrap();
    let (ida, idb) = (w.devices[a].id, w.devices[b].id);
    let mut sealer = Sealer::new(key, epoch, ida, &SystemRandom::new()).unwrap();
    let payload = protocol::encode_payload(&serde_json::json!({"t": "merge", "vector": {}})).unwrap();
    let body = sealer.seal(Address::Device(idb), &payload);
    let frame = protocol::encode_delivered(ida, w.relay.now, &body).unwrap();
    w.feed(b, Input::Binary(&frame));
    w.run();
    assert_eq!(w.phase(b), Phase::Paused { reason: PauseReason::UpdateNeeded });
    assert!(w.devices[a].events.iter().any(|e| matches!(
        e,
        Effect::Error(koona_sync::session::SessionError::Peer { code: protocol::ErrorCode::UpdateNeeded, .. })
    )));

    // No changes from that peer are taken while paused.
    fill(w.lib(a), 3, "a");
    w.act(a, Action::LocalChange);
    w.run();
    assert_eq!(vector(w.lib(b)), before);
    assert_eq!(count(w.lib(b)), 0);
}

#[test]
fn tampered_and_replayed_frames_are_dropped() {
    let mut w = World::new();
    let a = w.add("Hub", 1, 64 << 10);
    let b = w.add("Laptop", 2, 64 << 10);
    w.connect(a);
    w.run();
    w.pair(b, a);

    // Every third sync frame to b has a bit flipped, every other one comes twice.
    let mut n = 0;
    w.relay.tamper = Some(Box::new(move |_, _, body: &mut Vec<u8>| {
        if body[1] != Kind::Sync as u8 {
            return 1;
        }
        n += 1;
        if n % 3 == 0 {
            let last = body.len() - 1;
            body[last] ^= 1;
        }
        if n % 2 == 0 {
            2
        } else {
            1
        }
    }));
    fill(w.lib(a), 10, "a");
    w.act(a, Action::LocalChange);
    w.run();
    fill(w.lib(b), 10, "b");
    w.act(b, Action::LocalChange);
    w.run();
    let dropped = w.dropped(a, DropReason::Unauthentic) + w.dropped(b, DropReason::Unauthentic);
    let replayed = w.dropped(a, DropReason::Replayed) + w.dropped(b, DropReason::Replayed);
    assert!(dropped > 0 && replayed > 0, "{dropped} {replayed}");

    // A frame replayed later, outside any tampering.
    w.relay.tamper = None;
    let (_, to, frame) = w.relay.log.iter().rev().find(|(_, to, _)| *to == w.devices[b].id).unwrap().clone();
    assert_eq!(to, w.devices[b].id);
    let before = w.dropped(b, DropReason::Replayed) + w.dropped(b, DropReason::Unauthentic);
    w.feed(b, Input::Binary(&frame));
    assert_eq!(w.dropped(b, DropReason::Replayed) + w.dropped(b, DropReason::Unauthentic), before + 1);

    // Clean syncs settle what the tampering broke.
    w.act(b, Action::SyncNow);
    w.run();
    w.act(a, Action::SyncNow);
    w.run();
    w.assert_converged(&[a, b]);
}

#[test]
fn the_library_keeps_the_session_meta() {
    let mut conn = library(replica_id(1));
    let meta = koona_sync::library::Meta {
        key: Some((3, [7; 32])),
        hub: Some(Uuid::from_u128(5)),
        roster: Some(koona_sync::library::Roster {
            hub: Uuid::from_u128(5),
            devices: vec![protocol::RosterEntry { id: Uuid::from_u128(5), key: B64([1; 32]) }],
        }),
    };
    conn.store_meta(&meta).unwrap();
    assert_eq!(conn.load_meta().unwrap(), meta);
    conn.store_meta(&Default::default()).unwrap();
    assert_eq!(conn.load_meta().unwrap(), Default::default());
    let _: Vector = conn.vector().unwrap();
}

#[test]
fn a_peer_on_a_newer_schema_pauses_without_an_error() {
    let mut w = World::new();
    let a = w.add("Hub", 1, 64 << 10);
    let b = w.add("Laptop", 2, 64 << 10);
    w.connect(a);
    w.run();
    w.pair(b, a);
    let (epoch, key) = load_meta(w.lib(a)).unwrap().key.unwrap();
    let (ida, idb) = (w.devices[a].id, w.devices[b].id);
    let mut sealer = Sealer::new(key, epoch, ida, &SystemRandom::new()).unwrap();
    let hello = protocol::SyncMessage::Hello {
        proto: 1,
        schema: koona_sync::library::SCHEMA + 1,
        vector: Vector::default(),
        hub: true,
        platform: "windows".into(),
        app: "0.14.0".into(),
    };
    let body = sealer.seal(Address::Device(idb), &hello.encode().unwrap());
    let frame = protocol::encode_delivered(ida, w.relay.now, &body).unwrap();
    let errors = |w: &World| w.devices[a].events.iter().filter(|e| matches!(e, Effect::Error(_))).count();
    let before = errors(&w);
    w.feed(b, Input::Binary(&frame));
    w.run();
    assert_eq!(w.phase(b), Phase::Paused { reason: PauseReason::UpdateNeeded });
    assert_eq!(errors(&w), before, "the newer peer is fine and is told nothing");
    assert_eq!(w.devices[b].session.update_from(), Some(ida));
    let events = &w.devices[b].events;
    assert!(events.contains(&Effect::UpdateFrom(Some(ida))), "the interface names the newer peer");
    let told = events.iter().rev().find_map(|e| match e {
        Effect::PeerHello { device, platform, app } if *device == ida => Some((platform.clone(), app.clone())),
        _ => None,
    });
    assert_eq!(told, Some(("windows".to_string(), "0.14.0".to_string())), "and the version it runs");

    // It goes offline: nothing pauses this device any more.
    w.drop_link(a);
    w.run();
    assert_eq!(w.devices[b].session.update_from(), None);
    assert_eq!(w.devices[b].events.iter().rev().find(|e| matches!(e, Effect::UpdateFrom(_))), Some(&Effect::UpdateFrom(None)));
}

#[test]
fn peers_say_what_they_run_and_each_finished_transfer_is_told() {
    let mut w = World::new();
    let a = w.add("Hub", 1, 64 << 10);
    let b = w.add("Laptop", 2, 64 << 10);
    fill(w.lib(a), 5, "a");
    w.connect(a);
    w.run();
    assert!(w.devices[a].events.contains(&Effect::KeyEpoch(Some(0))), "the hub's first key");
    w.pair(b, a);
    w.run();
    let (ida, idb) = (w.devices[a].id, w.devices[b].id);
    let platform = protocol::platform().to_string();
    let hello_from = |w: &World, i: usize, from: Uuid| {
        w.devices[i].events.iter().any(|e| matches!(e, Effect::PeerHello { device, platform: p, app } if *device == from && *p == platform && app == "0.13.0"))
    };
    assert!(hello_from(&w, a, idb) && hello_from(&w, b, ida));
    assert!(w.devices[b].events.contains(&Effect::KeyEpoch(Some(0))), "the paired device holds the key");
    let synced = |w: &World, i: usize, peer: Uuid| w.devices[i].events.iter().filter(|e| **e == Effect::Synced { peer }).count();
    assert!(synced(&w, a, idb) > 0 && synced(&w, b, ida) > 0, "both directions finished");

    // A push and its ack: both ends tell again.
    let (before_a, before_b) = (synced(&w, a, idb), synced(&w, b, ida));
    fill(w.lib(b), 2, "b");
    w.act(b, Action::LocalChange);
    w.run();
    assert!(synced(&w, a, idb) > before_a, "the hub applied the push");
    assert!(synced(&w, b, ida) > before_b, "the laptop's push was acknowledged");

    // The offset of this device's clock from the relay's, from each challenge.
    w.drop_link(b);
    w.devices[b].offset = 1_500;
    w.connect(b);
    w.run();
    assert_eq!(w.devices[b].events.iter().rev().find(|e| matches!(e, Effect::ClockOffset(_))), Some(&Effect::ClockOffset(1_500)));
}

/// Three devices with `a` the hub, every one paired.
fn three() -> (World, usize, usize, usize) {
    let mut w = World::new();
    let a = w.add("Studio Mac", 1, 64 << 10);
    let b = w.add("Laptop", 2, 64 << 10);
    let c = w.add("Phone", 3, 64 << 10);
    fill(w.lib(a), 10, "a");
    w.connect(a);
    w.run();
    w.pair(b, a);
    w.pair(c, a);
    w.run();
    (w, a, b, c)
}

#[test]
fn the_hub_hands_over_only_when_its_person_allows() {
    let (mut w, a, b, c) = three();
    let (ida, idb, idc) = (w.devices[a].id, w.devices[b].id, w.devices[c].id);

    // Denied: nothing changes.
    w.hand_over(b, a, false);
    assert_eq!(w.last_hub_event(b), Some(HubChangeEvent::Failed { peer: ida, reason: HubChangeFailure::Denied }));
    assert_eq!(w.last_hub_event(a), Some(HubChangeEvent::Settled { peer: idb }));
    assert!(w.devices[a].session.is_hub());
    assert!(w.relay.errors.is_empty(), "{:?}", w.relay.errors);
    assert!(matches!(w.hub_events(b)[0], HubChangeEvent::Waiting { hub, ref hub_name } if hub == ida && hub_name == "Studio Mac"));
    assert!(
        matches!(&w.hub_events(a)[0], HubChangeEvent::Asked { device, name } if *device == idb && name == "Laptop"),
        "the hub asks its person, naming the device"
    );

    // Allowed: `b` is the hub and sends its roster to the others.
    w.hand_over(b, a, true);
    assert_eq!(w.last_hub_event(b), Some(HubChangeEvent::Settled { peer: ida }));
    // The relay's `account` comes before the hub's answer (set_hub goes first); the answer
    // that follows is expected, not a drop.
    assert_eq!(w.dropped(b, DropReason::Unexpected), 0, "{:?}", w.devices[b].events);
    for i in [a, b, c] {
        assert_eq!(w.devices[i].session.hub(), Some(idb));
    }
    let roster = load_meta(w.lib(c)).unwrap().roster.unwrap();
    assert_eq!(roster.hub, idb, "the new hub's roster reached the others");
    for id in [ida, idb, idc] {
        assert!(roster.key_of(id).is_some());
    }
    assert!(w.relay.errors.is_empty(), "{:?}", w.relay.errors);
    fill(w.lib(c), 3, "c");
    w.act(c, Action::LocalChange);
    w.run();
    w.assert_converged(&[a, b, c]);

    // Only the hub hands over now: the old one has no request to answer.
    w.act(a, Action::AnswerHubRequest { allow: true });
    assert!(matches!(w.devices[a].events.last(), Some(Effect::Error(SessionError::NotAllowed(_)))));
}

#[test]
fn a_second_request_while_the_hub_asks_is_busy() {
    let (mut w, a, b, c) = three();
    let (ida, idb) = (w.devices[a].id, w.devices[b].id);
    w.act(b, Action::RequestHub);
    w.run();
    w.act(c, Action::RequestHub);
    w.run();
    assert_eq!(w.last_hub_event(c), Some(HubChangeEvent::Failed { peer: ida, reason: HubChangeFailure::Busy }));
    let asked: Vec<_> = w.hub_events(a).into_iter().filter(|e| matches!(e, HubChangeEvent::Asked { .. })).collect();
    assert_eq!(asked.len(), 1, "the hub shows the first request only");
    // Asking again is the same request.
    w.act(b, Action::RequestHub);
    w.run();
    assert!(matches!(w.last_hub_event(b), Some(HubChangeEvent::Waiting { .. })));
    w.act(a, Action::AnswerHubRequest { allow: true });
    w.run();
    assert_eq!(w.devices[c].session.hub(), Some(idb));
}

#[test]
fn an_offline_or_silent_hub_ends_the_request() {
    let (mut w, a, b, c) = three();
    let (ida, idb) = (w.devices[a].id, w.devices[b].id);

    // No answer in five minutes: both sides give up.
    w.act(b, Action::RequestHub);
    w.run();
    w.tick(HUB_REQUEST_TIMEOUT_MS - 1000);
    assert!(matches!(w.last_hub_event(b), Some(HubChangeEvent::Waiting { .. })));
    w.tick(1000);
    assert_eq!(w.last_hub_event(b), Some(HubChangeEvent::Failed { peer: ida, reason: HubChangeFailure::Timeout }));
    assert_eq!(w.last_hub_event(a), Some(HubChangeEvent::Settled { peer: idb }));
    assert!(w.devices[a].session.is_hub());

    // The relay can't deliver the request: the hub is offline.
    w.relay.conns.remove(&a);
    w.devices[a].connected = false;
    w.act(c, Action::RequestHub);
    w.run();
    assert_eq!(w.last_hub_event(c), Some(HubChangeEvent::Failed { peer: ida, reason: HubChangeFailure::Unavailable }));

    // The hub known to be offline: refused at once.
    w.relay.notify(&Control::Presence { device: ida, online: false });
    w.run();
    w.act(b, Action::RequestHub);
    assert_eq!(w.last_hub_event(b), Some(HubChangeEvent::Failed { peer: ida, reason: HubChangeFailure::Unavailable }));
}

fn started_over(w: &World, i: usize) -> Vec<(Uuid, Option<String>, u32)> {
    w.devices[i]
        .events
        .iter()
        .filter_map(|e| match e {
            Effect::StartedOver { by, by_name, epoch, .. } => Some((*by, by_name.clone(), *epoch)),
            _ => None,
        })
        .collect()
}

#[test]
fn starting_over_makes_this_device_the_hub_with_a_new_key_and_holds_the_others() {
    let (mut w, a, b, c) = three();
    let idc = w.devices[c].id;
    fill(w.lib(b), 4, "b");
    w.act(b, Action::LocalChange);
    w.run();
    w.assert_converged(&[a, b, c]);
    let (old_epoch, old_key) = load_meta(w.lib(c)).unwrap().key.unwrap();

    // A sign-in that is not fresh changes nothing.
    w.act(c, Action::StartOver { token: "an-old-token".into() });
    w.run();
    assert!(w.devices[c].events.iter().any(|e| matches!(e, Effect::Error(SessionError::Relay(code)) if code == "stale_sign_in")));
    assert_eq!(w.phase(a), Phase::Online);

    // `b` is offline meanwhile; `c` asks while its own link is down too, and it goes once welcomed.
    w.drop_link(b);
    w.drop_link(c);
    w.run();
    w.act(c, Action::StartOver { token: FRESH_SIGN_IN.into() });
    w.connect(c);
    w.run();
    assert_eq!(w.phase(a), Phase::Paused { reason: PauseReason::StartedOver }, "the hub was disconnected (4005)");
    assert_eq!(w.phase(c), Phase::Paused { reason: PauseReason::Offline });

    // The device that started over comes back as the hub, alone, with a new key.
    w.connect(c);
    w.run();
    assert_eq!(w.phase(c), Phase::Online);
    assert!(w.devices[c].session.is_hub());
    assert_eq!(w.devices[c].session.epochs(), (old_epoch + 1, Some(old_epoch + 1)));
    let meta = load_meta(w.lib(c)).unwrap();
    assert_ne!(meta.key.unwrap().1, old_key);
    assert_eq!(meta.roster.unwrap().devices.len(), 1, "the roster names the new hub alone");
    assert!(started_over(&w, c).is_empty());

    // The others come back pending and hold: no offer goes to the new hub.
    let codes_on_c = w.codes(c).len();
    w.connect(a);
    w.connect(b);
    w.run();
    for i in [a, b] {
        assert_eq!(w.phase(i), Phase::Paused { reason: PauseReason::StartedOver });
        assert_eq!(started_over(&w, i), vec![(idc, Some("Phone".to_string()), old_epoch + 1)]);
    }
    w.act(b, Action::StartPairing);
    w.run();
    assert_eq!(w.codes(c).len(), codes_on_c, "nothing is offered until the person joins");
    // Held across reconnects.
    w.drop_link(b);
    w.connect(b);
    w.run();
    assert_eq!(w.phase(b), Phase::Paused { reason: PauseReason::StartedOver });

    // Joining pairs with the new hub; the libraries merge back.
    fill(w.lib(a), 2, "a2");
    for i in [a, b] {
        w.act(i, Action::JoinAgain);
        w.run();
        let (asking, hosting) = (w.codes(i), w.codes(c));
        assert_eq!(asking.last().unwrap().0, Role::Asking);
        assert_eq!(asking.last().unwrap().1, hosting.last().unwrap().1);
        let device = w.devices[i].id;
        w.act(c, Action::ApprovePairing { device });
        w.run();
        assert_eq!(w.phase(i), Phase::Online);
    }
    w.act(c, Action::SyncNow);
    w.run();
    w.assert_converged(&[a, b, c]);
    assert_eq!(count(w.lib(c)), 16);
    assert_eq!(load_meta(w.lib(a)).unwrap().key, load_meta(w.lib(c)).unwrap().key);
    assert_eq!(load_meta(w.lib(c)).unwrap().roster.unwrap().devices.len(), 3);
}
