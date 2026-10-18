//! Sync v1 end to end (Р-68): real app libraries (the test fixtures, migrated to schema 10 by the
//! app's own open code) behind the app's `DbLibrary`, each driven by the real relay client
//! `koona_sync::net::client` against the real relay running locally (`wrangler dev --local`).
//!
//! Ignored: it needs the relay. How to run it: `commercial/koona-sync/E2E.md`.
//!
//! The test mints its own credentials: an ES256 token signed by a key whose JWKS it serves
//! itself on 127.0.0.1 (the relay's `SUPABASE_JWKS_URL`), and a Supporter lease signed by the
//! fixed test plan key below (the relay's `PLAN_PUBLIC_KEY`). Each run is a new account.

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use chrono::Utc;
use koona_sync::net::{self, ClientConfig, CredentialSource, Credentials, Event, Handle, Stop};
use koona_sync::session::{Action, Config, Effect, HubChangeEvent, HubChangeFailure, PairingEvent, PauseReason, Phase, Role, Session, SessionError};
use koonapin_lib::commercial::sync::status::{Model, Reaction};
use koonapin_lib::commercial::sync::worker::{self, DbLibrary};
use koonapin_lib::db::{self, BookmarkQuery, DbState, Purge, Source};
use koonapin_lib::feeds;
use koonapin_lib::{library, test_libraries};
use ring::rand::SystemRandom;
use ring::signature::{EcdsaKeyPair, Ed25519KeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::task::JoinHandle;
use uuid::Uuid;

/// The seed of the test plan key. Its public key, the relay's `PLAN_PUBLIC_KEY`, is
/// `fqDjvVLiB8nTsOumXAcE5m/KLY4WWhdSGLF0/EFg5BM=` (checked below).
const PLAN_SEED: [u8; 32] = [0x4b; 32];
const PLAN_PUBLIC: &str = "fqDjvVLiB8nTsOumXAcE5m/KLY4WWhdSGLF0/EFg5BM=";
const DEFAULT_RELAY: &str = "ws://127.0.0.1:8787/v1/sync";
const DEFAULT_JWKS_PORT: u16 = 8799;
/// How long a step may take to converge before the test fails.
const CONVERGE: Duration = Duration::from_secs(90);
const SNAPSHOT: usize = 10_000;

/// When the run began, for the times in the trace and the log.
static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

fn since_start(at: Instant) -> (f64, Instant) {
    let start = *START.get_or_init(Instant::now);
    (at.saturating_duration_since(start).as_secs_f64(), start)
}

// ── Credentials ──────────────────────────────────────────────────────────────

/// The key that signs the tokens: one for the whole run (both tests share the JWKS server and the
/// relay's JWKS cache), each test an account of its own.
struct Signer {
    rng: SystemRandom,
    es: EcdsaKeyPair,
    kid: String,
}

static SIGNER: std::sync::OnceLock<Signer> = std::sync::OnceLock::new();

/// The run's signer; the first call starts the JWKS server on `jwks_port`.
fn signer(jwks_port: u16) -> &'static Signer {
    SIGNER.get_or_init(|| {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
        let es = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng).unwrap();
        // A new kid every run: the relay fetches the JWKS again for a kid it doesn't know.
        let signer = Signer { rng, es, kid: format!("e2e-{}", Uuid::new_v4().simple()) };
        serve_jwks(jwks_port, signer.jwks());
        signer
    })
}

impl Signer {
    fn jwks(&self) -> String {
        // An uncompressed P-256 point: 0x04 || x || y.
        let point = self.es.public_key().as_ref();
        serde_json::json!({"keys": [{
            "kty": "EC", "crv": "P-256", "kid": self.kid, "alg": "ES256", "use": "sig",
            "x": URL_SAFE_NO_PAD.encode(&point[1..33]), "y": URL_SAFE_NO_PAD.encode(&point[33..65]),
        }]})
        .to_string()
    }
}

/// One account: a `sub` and an email of its own, its tokens signed by the run's signer.
struct Keys {
    signer: &'static Signer,
    plan: Ed25519KeyPair,
    issuer: String,
    sub: String,
    email: String,
}

impl Keys {
    fn new(jwks_port: u16) -> Keys {
        let plan = Ed25519KeyPair::from_seed_unchecked(&PLAN_SEED).unwrap();
        assert_eq!(STANDARD.encode(plan.public_key().as_ref()), PLAN_PUBLIC);
        let sub = Uuid::new_v4().to_string();
        Keys {
            signer: signer(jwks_port),
            plan,
            issuer: format!("http://127.0.0.1:{jwks_port}/auth/v1"),
            email: format!("e2e-{}@example.com", &sub[..8]),
            sub,
        }
    }

    fn token(&self) -> String {
        self.sign(serde_json::json!({
            "iss": self.issuer, "aud": "authenticated", "sub": self.sub, "email": self.email,
            "exp": Utc::now().timestamp() + 3600,
        }))
    }

    /// The token of a sign-in by email code at `at` (Unix seconds), as Supabase's `verify` gives
    /// it: what `start_over` sends (PROTOCOL.md 2.6).
    fn sign_in(&self, at: i64) -> String {
        self.sign(serde_json::json!({
            "iss": self.issuer, "aud": "authenticated", "sub": self.sub, "email": self.email,
            "exp": Utc::now().timestamp() + 3600, "amr": [{"method": "otp", "timestamp": at}],
        }))
    }

    fn sign(&self, claims: serde_json::Value) -> String {
        let header = serde_json::json!({"alg": "ES256", "kid": self.signer.kid, "typ": "JWT"});
        let signed = format!("{}.{}", URL_SAFE_NO_PAD.encode(header.to_string()), URL_SAFE_NO_PAD.encode(claims.to_string()));
        let sig = self.signer.es.sign(&self.signer.rng, signed.as_bytes()).unwrap();
        format!("{signed}.{}", URL_SAFE_NO_PAD.encode(sig.as_ref()))
    }

    fn lease(&self) -> String {
        let now = Utc::now();
        let payload = serde_json::json!({
            "v": 1, "email": self.email,
            "plan": {"plan": "supporter", "status": "active", "interval": "year",
                     "valid_until": "2099-01-01T00:00:00Z", "renews_at": null},
            "issued_at": now.to_rfc3339(), "offline_until": (now + chrono::Duration::days(1)).to_rfc3339(),
        })
        .to_string();
        let signature = STANDARD.encode(self.plan.sign(payload.as_bytes()).as_ref());
        STANDARD.encode(serde_json::json!({"payload": payload, "signature": signature}).to_string())
    }
}

/// The JWKS for the relay: every request gets it. On threads of its own, so it outlives the
/// runtime of the test that started it.
fn serve_jwks(port: u16, body: String) {
    use std::io::{Read, Write};
    let listener =
        std::net::TcpListener::bind(("127.0.0.1", port)).unwrap_or_else(|e| panic!("the JWKS server needs 127.0.0.1:{port}: {e}"));
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let body = body.clone();
            std::thread::spawn(move || {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut request = Vec::new();
                let mut buf = [0u8; 1024];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => return,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                    }
                }
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.shutdown(std::net::Shutdown::Write);
            });
        }
    });
}

// ── Counting what reaches the relay ──────────────────────────────────────────

/// One message a device sent to the relay, as the relay's rate limit counts it.
struct Sent {
    at: Instant,
    conn: usize,
    text: Option<String>,
    len: usize,
}

type DeviceOf = Arc<Mutex<std::collections::BTreeMap<usize, String>>>;

/// A TCP proxy in front of the relay that reads the WebSocket frames the devices send, so the
/// test sees what the relay's account-wide rate limit sees. It changes no byte.
struct Meter {
    url: String,
    sent: Arc<Mutex<Vec<Sent>>>,
    /// Connection -> device id, from its `hello`.
    devices: DeviceOf,
    last: Mutex<usize>,
    task: JoinHandle<()>,
}

impl Meter {
    async fn start(relay: &str) -> Meter {
        let rest = relay.strip_prefix("ws://").expect("the meter needs a ws:// relay");
        let (authority, path) = match rest.split_once('/') {
            Some((a, p)) => (a.to_string(), format!("/{p}")),
            None => (rest.to_string(), "/".to_string()),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}{path}", listener.local_addr().unwrap());
        let sent = Arc::new(Mutex::new(Vec::new()));
        let devices: DeviceOf = Arc::new(Mutex::new(Default::default()));
        let task = {
            let (sent, devices) = (sent.clone(), devices.clone());
            tokio::spawn(async move {
                let mut conn = 0;
                loop {
                    let Ok((client, _)) = listener.accept().await else { return };
                    conn += 1;
                    let Ok(server) = tokio::net::TcpStream::connect(&authority).await else { continue };
                    tokio::spawn(meter_conn(conn, client, server, sent.clone(), devices.clone()));
                }
            })
        };
        Meter { url, sent, devices, last: Mutex::new(0), task }
    }

    /// What was sent since the last step: printed, the busiest second too when the relay's
    /// bucket ran dry.
    fn step(&self, what: &str) {
        let now = self.sent.lock().unwrap().len();
        let from = std::mem::replace(&mut *self.last.lock().unwrap(), now);
        let (lowest, busiest, count) = self.report(from);
        eprintln!("[e2e]   {what}: {count} messages to the relay, at most {busiest} in a second, bucket low {lowest:.1}");
        if lowest < 0.0 {
            self.print_busiest(from);
        }
    }

    /// The relay's message bucket (a burst of 20, 20 a second) replayed over what was sent since
    /// `from`: the lowest it went (below 0 is a 4008), the busiest second, and the count.
    fn report(&self, from: usize) -> (f64, usize, usize) {
        let sent = self.sent.lock().unwrap();
        let from = from.min(sent.len());
        // The bucket over the whole run, as the relay keeps it; only the lows since `from` count.
        let (mut tokens, mut lowest, mut last) = (20.0f64, 20.0f64, None::<Instant>);
        let mut busiest = 0;
        for (i, s) in sent.iter().enumerate() {
            if let Some(last) = last {
                tokens = (tokens + (s.at - last).as_secs_f64() * 20.0).min(20.0);
            }
            last = Some(s.at);
            tokens -= 1.0;
            if i >= from {
                lowest = lowest.min(tokens);
                busiest = busiest.max(sent[i..].iter().take_while(|t| t.at - s.at < Duration::from_secs(1)).count());
            }
        }
        (lowest, busiest, sent.len() - from)
    }

    /// The messages of the busiest second since `from`, for a failure.
    fn print_busiest(&self, from: usize) {
        let sent = self.sent.lock().unwrap();
        let devices = self.devices.lock().unwrap();
        let sent = &sent[from.min(sent.len())..];
        let in_second = |i: usize| sent[i..].iter().take_while(|t| t.at - sent[i].at < Duration::from_secs(1)).count();
        let Some(start) = (0..sent.len()).max_by_key(|&i| in_second(i)) else { return };
        let base = sent[start].at;
        for s in sent[start..].iter().take_while(|t| t.at - base < Duration::from_secs(1)) {
            let device: String = devices.get(&s.conn).map_or("?".into(), |d| d.chars().take(8).collect());
            eprintln!("  +{:>4} ms {device:<8} {:>7} B {}", (s.at - base).as_millis(), s.len, s.text.as_deref().unwrap_or("binary"));
        }
    }
}

impl Meter {
    /// Everything sent, one line a message, for a look after a run.
    fn write_trace(&self, path: &Path) {
        let sent = self.sent.lock().unwrap();
        let devices = self.devices.lock().unwrap();
        let first = since_start(Instant::now()).1;
        let lines: Vec<String> = sent
            .iter()
            .map(|s| {
                let device: String = devices.get(&s.conn).map_or("?".into(), |d| d.chars().take(8).collect());
                format!("{:>9.3} conn {:>3} {device:<8} {:>7} B {}", (s.at - first).as_secs_f64(), s.conn, s.len, s.text.as_deref().unwrap_or("binary"))
            })
            .collect();
        std::fs::write(path, lines.join("
")).unwrap();
    }
}

impl Drop for Meter {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn meter_conn(conn: usize, client: tokio::net::TcpStream, server: tokio::net::TcpStream, sent: Arc<Mutex<Vec<Sent>>>, devices: DeviceOf) {
    let (mut client_read, mut client_write) = client.into_split();
    let (mut server_read, mut server_write) = server.into_split();
    let down = tokio::spawn(async move {
        let _ = tokio::io::copy(&mut server_read, &mut client_write).await;
        let _ = client_write.shutdown().await;
    });
    let mut buf = vec![0u8; 64 << 10];
    let mut pending: Vec<u8> = Vec::new();
    let mut upgraded = false;
    loop {
        let n = match client_read.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        if server_write.write_all(&buf[..n]).await.is_err() {
            break;
        }
        pending.extend_from_slice(&buf[..n]);
        if !upgraded {
            let Some(end) = pending.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
            pending.drain(..end + 4);
            upgraded = true;
        }
        // Client frames are masked: FIN and opcode, the mask bit and length, the mask, the payload.
        while pending.len() >= 2 {
            let opcode = pending[0] & 0x0f;
            let (len, mut at) = match pending[1] & 0x7f {
                126 if pending.len() >= 4 => (u16::from_be_bytes([pending[2], pending[3]]) as usize, 4),
                127 if pending.len() >= 10 => (u64::from_be_bytes(pending[2..10].try_into().unwrap()) as usize, 10),
                126 | 127 => break,
                len => (len as usize, 2),
            };
            let mut mask = [0u8; 4];
            if pending[1] & 0x80 != 0 {
                if pending.len() < at + 4 {
                    break;
                }
                mask.copy_from_slice(&pending[at..at + 4]);
                at += 4;
            }
            if pending.len() < at + len {
                break;
            }
            let payload: Vec<u8> = pending[at..at + len].iter().enumerate().map(|(i, b)| b ^ mask[i % 4]).collect();
            pending.drain(..at + len);
            if opcode == 1 || opcode == 2 {
                let text = (opcode == 1).then(|| String::from_utf8_lossy(&payload).into_owned());
                if let Some(json) = text.as_deref().and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok()) {
                    if json["t"] == "hello" {
                        devices.lock().unwrap().insert(conn, json["device"].as_str().unwrap_or_default().to_string());
                    }
                }
                let text = text.map(|t| t.chars().take(60).collect());
                sent.lock().unwrap().push(Sent { at: Instant::now(), conn, text, len });
            }
        }
    }
    let _ = server_write.shutdown().await;
    let _ = down.await;
}

// ── Devices ──────────────────────────────────────────────────────────────────

struct Run {
    handle: Handle,
    done: Arc<AtomicBool>,
    tasks: Vec<JoinHandle<()>>,
}

struct Device {
    name: &'static str,
    id: Uuid,
    pkcs8: Vec<u8>,
    db: Arc<DbState>,
    replica: Uuid,
    /// The library key beside the library, as the app keeps it beside the identity.
    key_file: PathBuf,
    log: Arc<Mutex<Vec<Event>>>,
    run: Option<Run>,
}

fn open(path: &Path) -> Connection {
    library::open(&library::Paths::new(path.to_path_buf())).map_err(|e| e.detail.clone()).unwrap().conn
}

impl Device {
    /// The person turns sync on: the library becomes a replica (`prepare_library`, as
    /// `enable_sync` does).
    fn new(name: &'static str, conn: Connection) -> Device {
        let replica = worker::prepare_library(&conn).unwrap();
        let key_file = Path::new(conn.path().expect("a library on disk")).with_file_name("sync-key.json");
        let rng = SystemRandom::new();
        Device {
            name,
            id: Uuid::new_v4(),
            pkcs8: koona_sync::crypto::generate_device_key(&rng).unwrap(),
            db: Arc::new(DbState::new(conn)),
            replica,
            key_file,
            log: Arc::new(Mutex::new(Vec::new())),
            run: None,
        }
    }

    fn with<T>(&self, work: impl FnOnce(&Connection) -> T) -> T {
        let conn = self.db.conn.lock().unwrap();
        work(&conn)
    }

    /// A client as the app's worker starts one: the session over `DbLibrary`, its events through
    /// the status model (which asks to pair when pending), and the watcher of local changes.
    fn start(&mut self, keys: &Arc<Keys>, url: &str) {
        assert!(self.run.is_none());
        let key = koona_sync::crypto::device_key(&self.pkcs8).unwrap();
        let config = Config::new(self.id, key, keys.sub.clone(), self.name.to_string(), "0.12.0".to_string());
        let session = Session::new(config, Box::new(SystemRandom::new()));
        let counter = self.with(worker::start_counter);
        let library = DbLibrary::new(self.db.clone(), self.replica, Arc::new(AtomicBool::new(false))).with_key_file(self.key_file.clone(), keys.sub.clone());
        let credentials: CredentialSource = {
            let keys = keys.clone();
            Arc::new(move |_refresh| {
                let credentials = Credentials { token: keys.token(), lease: keys.lease() };
                Box::pin(async move { Ok(credentials) })
            })
        };
        let mut config = ClientConfig::new(url);
        // The keepalive every few seconds instead of 30, so a run of half a minute sends some.
        config.ping_every = Duration::from_secs(5);
        let (handle, mut events, work) = net::client(config, session, library, credentials);
        let done = Arc::new(AtomicBool::new(false));
        let pump = {
            let (log, handle, done, name) = (self.log.clone(), handle.clone(), done.clone(), self.name);
            tokio::spawn(async move {
                let mut model = Model::default();
                while let Some(event) = events.recv().await {
                    if let Event::Closed { code, reason } = &event {
                        eprintln!("[e2e] {:.3} {name}: connection closed, code {code:?}, reason {reason:?}", since_start(Instant::now()).0);
                    }
                    for reaction in model.on_event(event.clone(), Utc::now()) {
                        if reaction == Reaction::StartPairing {
                            handle.act(Action::StartPairing);
                        }
                    }
                    log.lock().unwrap().push(event);
                }
                done.store(true, Ordering::SeqCst);
            })
        };
        let tasks = vec![tokio::spawn(work), pump, tokio::spawn(worker::watch(self.db.clone(), handle.clone(), done.clone(), counter))];
        self.run = Some(Run { handle, done, tasks });
    }

    /// The app quits (or loses the network for good): the client stops.
    async fn stop(&mut self) {
        let Some(run) = self.run.take() else { return };
        run.handle.shutdown();
        run.done.store(true, Ordering::SeqCst);
        for task in run.tasks {
            let _ = tokio::time::timeout(Duration::from_secs(10), task).await;
        }
    }

    fn act(&self, action: Action) {
        assert!(self.run.as_ref().expect("running").handle.act(action), "{}: the client stopped", self.name);
    }

    fn mark(&self) -> usize {
        self.log.lock().unwrap().len()
    }

    /// The first event from `from` on that `find` picks.
    async fn wait<T>(&self, from: usize, what: &str, find: impl FnMut(&Event) -> Option<T>) -> T {
        self.wait_at(from, what, find).await.1
    }

    /// As `wait`, with the place of the event in the log: the next wait can start after it.
    async fn wait_at<T>(&self, from: usize, what: &str, mut find: impl FnMut(&Event) -> Option<T>) -> (usize, T) {
        let started = Instant::now();
        loop {
            {
                let log = self.log.lock().unwrap();
                let from = from.min(log.len());
                if let Some(found) = log[from..].iter().enumerate().find_map(|(i, e)| find(e).map(|t| (from + i + 1, t))) {
                    return found;
                }
            }
            if started.elapsed() > CONVERGE {
                self.print_log(40);
                panic!("{}: no {what} in {CONVERGE:?}", self.name);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// Whether any event from `from` on is one `find` picks.
    fn saw(&self, from: usize, find: impl FnMut(&Event) -> bool) -> bool {
        let log = self.log.lock().unwrap();
        log[from.min(log.len())..].iter().any(find)
    }

    /// The device's latest phase.
    fn phase(&self) -> Option<Phase> {
        let log = self.log.lock().unwrap();
        log.iter().rev().find_map(|e| if let Event::Session(Effect::Status(p)) = e { Some(*p) } else { None })
    }

    async fn wait_phase(&self, from: usize, phase: Phase) -> usize {
        self.wait_at(from, &format!("{phase:?}"), |e| matches!(e, Event::Session(Effect::Status(p)) if *p == phase).then_some(()))
            .await
            .0
    }

    async fn wait_hub_change(&self, from: usize, what: &str, find: impl Fn(&HubChangeEvent) -> bool) -> usize {
        self.wait_at(from, what, |e| matches!(e, Event::Session(Effect::HubChange(h)) if find(h)).then_some(())).await.0
    }

    /// The pinned roster, as `sync_meta` keeps it.
    fn roster(&self) -> Option<koona_sync::library::Roster> {
        self.with(|conn| koona_sync::library::load_meta(conn).unwrap().roster)
    }

    fn print_log(&self, last: usize) {
        let log = self.log.lock().unwrap();
        eprintln!("--- {} ({}), last {} of {} events", self.name, self.id, last.min(log.len()), log.len());
        for event in &log[log.len().saturating_sub(last)..] {
            eprintln!("  {event:?}");
        }
    }

    /// The connections that ended other than by a shutdown, with the relay's close code.
    fn closes(&self) -> Vec<(Option<u16>, Option<String>)> {
        let log = self.log.lock().unwrap();
        log.iter().filter_map(|e| if let Event::Closed { code, reason } = e { Some((*code, reason.clone())) } else { None }).collect()
    }

    /// What the relay refused, and the frames dropped: none in a healthy run.
    fn trouble(&self) -> Vec<String> {
        let log = self.log.lock().unwrap();
        log.iter()
            .filter(|e| matches!(e, Event::Session(Effect::Error(_) | Effect::Dropped { .. })))
            .map(|e| format!("{e:?}"))
            .collect()
    }

    fn dump(&self) -> Vec<String> {
        self.with(dump)
    }

    fn id_of(&self, url: &str) -> i64 {
        self.with(|conn| conn.query_row("SELECT id FROM bookmarks WHERE url = ?1", [url], |r| r.get(0)))
            .unwrap_or_else(|e| panic!("{}: no {url}: {e}", self.name))
    }

    fn collection(&self, name: &str) -> i64 {
        self.with(|conn| conn.query_row("SELECT id FROM collections WHERE name = ?1", [name], |r| r.get(0))).unwrap()
    }

    /// A value the session keeps. The library key and its epoch are in the key file, never in the
    /// library (its copies would carry them): checked here on every read.
    fn meta(&self, key: &str) -> Option<String> {
        let in_library: Option<String> = self.with(|conn| {
            conn.query_row("SELECT CAST(value AS TEXT) FROM sync_meta WHERE key = ?1", [key], |r| r.get(0)).optional().unwrap()
        });
        if key != "library_key" && key != "key_epoch" {
            return in_library;
        }
        assert_eq!(in_library, None, "{}: the {key} is in the library", self.name);
        let text = std::fs::read_to_string(&self.key_file).ok()?;
        let stored: serde_json::Value = serde_json::from_str(&text).unwrap();
        Some(match key {
            "key_epoch" => stored["epoch"].to_string(),
            _ => stored["key"].as_str().unwrap().to_string(),
        })
    }

    fn collection_order(&self) -> Vec<String> {
        self.with(|conn| db::get_collections(conn).unwrap().into_iter().map(|c| c.name).collect())
    }

    fn search(&self, words: &str) -> Vec<String> {
        self.with(|conn| {
            let query = BookmarkQuery { search: Some(words.to_string()), ..Default::default() };
            db::get_bookmarks(conn, &query).unwrap().items.into_iter().map(|b| b.url).collect()
        })
    }

    fn urls(&self) -> Vec<String> {
        self.with(|conn| column(conn, "SELECT url FROM bookmarks ORDER BY url"))
    }
}

/// The bookmark with this address, inside a `with`: the library's lock is not reentrant.
fn id(conn: &Connection, url: &str) -> i64 {
    conn.query_row("SELECT id FROM bookmarks WHERE url = ?1", [url], |r| r.get(0)).unwrap_or_else(|e| panic!("no {url}: {e}"))
}

fn column(conn: &Connection, sql: &str) -> Vec<String> {
    conn.prepare(sql).unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
}

/// The synced state keyed by uid: what every device must agree on. Local ids, revisions and
/// clocks are left out; collections and tags by uid, bookmarks with their collection's uid and
/// their tags' names.
fn dump(conn: &Connection) -> Vec<String> {
    let mut out = Vec::new();
    let mut rows = |sql: &str| {
        let mut stmt = conn.prepare(sql).unwrap();
        let n = stmt.column_count();
        let lines: Vec<String> = stmt
            .query_map([], |r| {
                Ok((0..n).map(|i| format!("{:?}", r.get::<_, rusqlite::types::Value>(i).unwrap())).collect::<Vec<_>>().join(" | "))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        out.extend(lines);
    };
    rows("SELECT 'collection', uid, name, color, icon, position_key FROM collections ORDER BY uid");
    rows("SELECT 'tag', uid, name FROM tags ORDER BY uid");
    rows(
        "SELECT 'bookmark', b.uid, b.url, b.title, b.description, b.image_url, b.favicon_url, b.notes, b.is_favorite,
                (SELECT uid FROM collections WHERE id = b.collection_id), b.triaged_at, b.deleted_at, b.source,
                b.source_name, b.created_at,
                (SELECT group_concat(name, ',') FROM (SELECT t.name FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
                                                      WHERE bt.bookmark_id = b.id ORDER BY t.name))
         FROM bookmarks b ORDER BY b.uid",
    );
    rows("SELECT 'feed', uid, url, title, destination FROM feeds ORDER BY uid");
    rows("SELECT 'tombstone', uid, kind, merged_into FROM tombstones ORDER BY uid");
    out
}

/// No two records hold one address or one name (NP-061).
fn assert_unique(device: &Device) {
    device.with(|conn| {
        for (what, sql) in [
            ("url", "SELECT url FROM bookmarks GROUP BY url HAVING count(*) > 1"),
            ("collection", "SELECT name FROM collections GROUP BY name HAVING count(*) > 1"),
            ("tag", "SELECT name FROM tags GROUP BY name HAVING count(*) > 1"),
        ] {
            let twice = column(conn, sql);
            assert!(twice.is_empty(), "{}: the same {what} twice: {twice:?}", device.name);
        }
        let broken: i64 = conn.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get(0)).unwrap();
        assert_eq!(broken, 0, "{}: a reference to a record that is not there", device.name);
    });
}

/// Waits until every device holds the same synced state; returns how long it took.
async fn converge(meter: &Meter, what: &str, devices: &[&Device]) -> Duration {
    let started = Instant::now();
    let mut agreed_since: Option<Instant> = None;
    loop {
        let dumps: Vec<Vec<String>> = devices.iter().map(|d| d.dump()).collect();
        if dumps.windows(2).all(|w| w[0] == w[1]) {
            // The same twice in a row, a little apart: not a moment between two batches.
            match agreed_since {
                Some(at) if at.elapsed() >= Duration::from_millis(300) => {
                    let took = at - started;
                    eprintln!("[e2e] {what}: converged in {:.2} s ({} rows)", took.as_secs_f64(), dumps[0].len());
                    meter.step(what);
                    return took;
                }
                Some(_) => {}
                None => agreed_since = Some(Instant::now()),
            }
        } else {
            agreed_since = None;
        }
        if started.elapsed() > CONVERGE {
            for (device, dump) in devices.iter().zip(&dumps) {
                device.print_log(30);
                let first = &dumps[0];
                let only: Vec<&String> = dump.iter().filter(|l| !first.contains(l)).take(10).collect();
                let lacks: Vec<&String> = first.iter().filter(|l| !dump.contains(l)).take(10).collect();
                eprintln!("  {}: {} rows; not on {}: {only:#?}; lacks: {lacks:#?}", device.name, dump.len(), devices[0].name);
            }
            panic!("{what}: no convergence in {CONVERGE:?}");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// A pending device pairs: both screens show the same six digits, the hub approves.
async fn pair(hub: &Device, new: &mut Device, keys: &Arc<Keys>, url: &str) -> String {
    let (hub_mark, new_mark) = (hub.mark(), new.mark());
    new.start(keys, url);
    confirm_pairing(hub, new, hub_mark, new_mark).await
}

/// The pairing of a pending device that is offering itself (after `start`, or `JoinAgain`):
/// the same six digits on both screens, the hub approves.
async fn confirm_pairing(hub: &Device, new: &Device, hub_mark: usize, new_mark: usize) -> String {
    let new_id = new.id;
    let asking = new
        .wait(new_mark, "pairing code on the new device", |e| match e {
            Event::Session(Effect::Pairing(PairingEvent::Code { role: Role::Asking, code, .. })) => Some(code.clone()),
            _ => None,
        })
        .await;
    let (name, shown) = hub
        .wait(hub_mark, "pairing code on the hub", |e| match e {
            Event::Session(Effect::Pairing(PairingEvent::Code { role: Role::Hub, peer, peer_name, code })) if *peer == new_id => {
                Some((peer_name.clone(), code.clone()))
            }
            _ => None,
        })
        .await;
    assert_eq!(asking.len(), 6);
    assert_eq!(asking, shown, "both screens show the same digits");
    assert_eq!(name, new.name);
    hub.act(Action::ApprovePairing { device: new_id });
    new.wait(new_mark, "paired", |e| matches!(e, Event::Session(Effect::Pairing(PairingEvent::Paired { .. }))).then_some(()))
        .await;
    asking
}

// ── Libraries ────────────────────────────────────────────────────────────────

/// The hub's library: the fixture with its sample rows at schema 9, opened (and so migrated to
/// 10) by the app, and a few bookmarks saved since.
fn library_a(path: &Path) -> Connection {
    let conn = test_libraries::fresh_at(path, 9);
    test_libraries::sample_rows(&conn);
    test_libraries::finish(conn);
    let conn = open(path);
    let tags = vec!["rust".to_string(), "from-a".to_string()];
    for i in 1..=5 {
        let url = format!("https://a.example/{i}");
        db::insert_or_update_bookmark(&conn, &url, &format!("Saved on A {i}"), None, None, None, "a.example", Some(1), Some(&tags), Source::App)
            .unwrap();
    }
    conn
}

/// Another computer's library: the fixture at schema 9 with starter collections of its own uids
/// (the same names as the hub's), migrated, then a few bookmarks and collections saved as the
/// app saves them, some with addresses and names the others have too.
fn library_other(path: &Path, urls: &[&str], collections: &[&str], tags: &[&str]) -> Connection {
    let conn = test_libraries::fresh_at(path, 9);
    for id in 1..=3 {
        conn.execute("UPDATE collections SET uid = ?1 WHERE id = ?2", params![db::new_uid(), id]).unwrap();
    }
    test_libraries::finish(conn);
    let conn = open(path);
    for name in collections {
        db::create_collection(&conn, name, None, None).unwrap();
    }
    let tags: Vec<String> = tags.iter().map(|t| t.to_string()).collect();
    for url in urls {
        let domain = url.split('/').nth(2).unwrap();
        db::insert_or_update_bookmark(&conn, url, &format!("Saved at {url}"), None, None, None, domain, None, Some(&tags), Source::Chrome)
            .unwrap();
    }
    conn
}

/// `count` bookmarks saved in one transaction, as an import writes them.
fn many(conn: &Connection, count: usize) {
    let tx = conn.unchecked_transaction().unwrap();
    let collections: Vec<i64> =
        tx.prepare("SELECT id FROM collections").unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
    let words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "theta", "kappa"];
    for i in 0..count {
        let url = format!("https://bulk{}.example.org/articles/{i}/{}", i % 37, words[i % words.len()]);
        let title = format!("{} {} article number {i}", words[i % 8], words[(i / 8) % 8]);
        let tags = vec![words[i % 5].to_string(), format!("batch-{}", i % 3)];
        let domain = format!("bulk{}.example.org", i % 37);
        let collection = (i % 4 != 0).then(|| collections[i % collections.len()]);
        db::insert_or_update_bookmark(&tx, &url, &title, Some("A description long enough to look like a real one."), None, None, &domain, collection, Some(&tags), Source::Import)
            .unwrap();
    }
    tx.commit().unwrap();
}

// ── The scenario ─────────────────────────────────────────────────────────────

/// One upgrade with a token and no lease: the relay verifies the token (fetching the JWKS for
/// the run's new kid) and refuses for the lease, before any account is touched. Without it,
/// two first connections at once race the relay's refetch of the JWKS, and the one that comes
/// while the other's fetch is under way is closed with 4001 `token_kid`.
async fn warm_up(relay: &str, keys: &Keys) {
    let rest = relay.strip_prefix("ws://").expect("a ws:// relay");
    let (authority, path) = rest.split_once('/').map_or((rest, "/".to_string()), |(a, p)| (a, format!("/{p}")));
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {authority}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\
         Authorization: Bearer {}\r\nX-Koona-Proto: 1\r\n\r\n",
        keys.token()
    );
    let probe = async {
        let mut stream = tokio::net::TcpStream::connect(authority).await.ok()?;
        stream.write_all(request.as_bytes()).await.ok()?;
        let mut response = Vec::new();
        let mut buf = [0u8; 1024];
        while !response.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = stream.read(&mut buf).await.ok()?;
            if n == 0 {
                break;
            }
            response.extend_from_slice(&buf[..n]);
        }
        Some(String::from_utf8_lossy(&response).lines().next().unwrap_or_default().to_string())
    };
    let status = tokio::time::timeout(Duration::from_secs(10), probe).await.ok().flatten();
    eprintln!("[e2e] the relay checked the run's token: {status:?}");
}

/// A test's account, its meter in front of the relay, and the folder of its libraries.
struct Setup {
    meter: Meter,
    url: String,
    keys: Arc<Keys>,
    folder: PathBuf,
}

impl Setup {
    async fn new() -> Setup {
        let relay = std::env::var("KOONAPIN_E2E_RELAY").unwrap_or_else(|_| DEFAULT_RELAY.to_string());
        // The devices dial the meter, which passes everything on to the relay.
        since_start(Instant::now());
        let meter = Meter::start(&relay).await;
        let url = meter.url.clone();
        let jwks_port = std::env::var("KOONAPIN_E2E_JWKS_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_JWKS_PORT);
        let keys = Arc::new(Keys::new(jwks_port));
        // The tests start together; the relay learns the run's kid once, before any device dials.
        static WARM: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();
        WARM.get_or_init(|| warm_up(&relay, &keys)).await;
        let folder: PathBuf = std::env::temp_dir().join(format!("koonapin-e2e-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(&folder).unwrap();
        eprintln!("[e2e] relay {relay} through {url}, account {}, libraries in {}", keys.sub, folder.display());
        Setup { meter, url, keys, folder }
    }

    /// The path of a device's library.
    fn place(&self, name: &str) -> PathBuf {
        let dir = self.folder.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("koonapin.db")
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs the relay running locally: see commercial/koona-sync/E2E.md"]
async fn three_devices_sync_through_the_local_relay() {
    let setup = Setup::new().await;
    let (meter, url, keys, folder) = (&setup.meter, setup.url.clone(), setup.keys.clone(), setup.folder.clone());
    let place = |name: &str| setup.place(name);

    // ── 1. A turns sync on and becomes the hub; B and C pair and merge ───────
    let mut a = Device::new("Studio Mac", library_a(&place("a")));
    let shared = ["https://example.com/notes", "https://shared.example/one"];
    let b_urls = [shared[0], shared[1], "https://b.example/1", "https://b.example/2", "https://b.example/3", "https://b.example/4"];
    let c_urls = [shared[0], shared[1], "https://c.example/1", "https://c.example/2", "https://c.example/3", "https://c.example/4"];
    let mut b = Device::new("Laptop", library_other(&place("b"), &b_urls, &["Reading", "Cooking"], &["rust", "from-b"]));
    let mut c = Device::new("Office PC", library_other(&place("c"), &c_urls, &["Reading", "Travel"], &["rust", "from-c"]));
    for device in [&a, &b, &c] {
        eprintln!("[e2e] {} is {}", device.name, device.id);
    }
    let mut expected_urls: Vec<String> = [a.urls(), b.urls(), c.urls()].concat();
    expected_urls.sort();
    expected_urls.dedup();

    let a_mark = a.mark();
    a.start(&keys, &url);
    a.wait(a_mark, "online", |e| matches!(e, Event::Session(Effect::Status(koona_sync::session::Phase::Online))).then_some(()))
        .await;
    assert_eq!(a.meta("hub"), Some(a.id.to_string()), "the first device is the hub");
    assert_eq!(a.meta("key_epoch").as_deref(), Some("0"));

    let started = Instant::now();
    let code = pair(&a, &mut b, &keys, &url).await;
    eprintln!("[e2e] B paired with code {code} in {:.2} s", started.elapsed().as_secs_f64());
    converge(&meter, "A and B merged", &[&a, &b]).await;
    let started = Instant::now();
    let code = pair(&a, &mut c, &keys, &url).await;
    eprintln!("[e2e] C paired with code {code} in {:.2} s", started.elapsed().as_secs_f64());
    converge(&meter, "A, B and C merged", &[&a, &b, &c]).await;
    for device in [&a, &b, &c] {
        assert_unique(device);
        assert_eq!(device.urls(), expected_urls, "{}: every address once", device.name);
        let names = device.collection_order();
        for name in ["Development", "Reading", "Cooking", "Travel"] {
            assert_eq!(names.iter().filter(|n| *n == name).count(), 1, "{}: {name} once in {names:?}", device.name);
        }
    }

    // ── 2. Edits everywhere converge everywhere ──────────────────────────────
    let edits = Instant::now();
    a.with(|conn| db::update_bookmark(conn, id(conn, "https://b.example/1"), Some("Zephyr quantum notebook".into()), None, None, None, None))
        .unwrap();
    b.with(|conn| db::update_bookmark(conn, id(conn, shared[0]), None, None, None, None, Some(vec!["e2e".into(), "merged".into()])))
        .unwrap();
    let cooking = c.collection("Cooking");
    c.with(|conn| db::update_bookmark(conn, id(conn, shared[1]), None, None, None, Some(Some(cooking)), None)).unwrap();
    a.with(|conn| db::trash_bookmark(conn, id(conn, "https://c.example/1"))).unwrap();
    b.with(|conn| db::create_collection(conn, "Inbox Zero", Some("#123456"), None)).unwrap();
    let mut order: Vec<i64> = c.with(|conn| db::get_collections(conn).unwrap().into_iter().map(|x| x.id).collect());
    order.reverse();
    c.with(|conn| db::reorder_collections(conn, &order)).unwrap();
    converge(&meter, "edits, round 1", &[&a, &b, &c]).await;

    b.with(|conn| db::restore_bookmark(conn, id(conn, "https://c.example/1"), false)).unwrap();
    let doomed = c.id_of("https://c.example/2");
    let doomed_uid: String = c.with(|conn| conn.query_row("SELECT uid FROM bookmarks WHERE id = ?1", [doomed], |r| r.get(0))).unwrap();
    c.with(|conn| {
        db::trash_bookmark(conn, doomed).unwrap();
        db::purge_trash(conn, Purge::One(doomed)).unwrap();
    });
    a.with(|conn| db::update_bookmark(conn, id(conn, "https://b.example/2"), None, Some("Read on the train".into()), Some(true), None, None))
        .unwrap();
    let order: Vec<i64> = a.with(|conn| {
        let mut ids: Vec<i64> = db::get_collections(conn).unwrap().into_iter().map(|x| x.id).collect();
        let moved = ids.remove(0);
        ids.insert(2, moved);
        ids
    });
    a.with(|conn| db::reorder_collections(conn, &order)).unwrap();
    converge(&meter, "edits, round 2", &[&a, &b, &c]).await;
    eprintln!("[e2e] both rounds of edits converged in {:.2} s", edits.elapsed().as_secs_f64());

    // ── 2b. Feeds (NP-130): followed on two devices at once, renamed, moved, left ──
    let feed_url = |s: &str| url::Url::parse(s).unwrap();
    let (news, blog) = ("https://news.example/feed.xml", "https://blog.example/atom.xml");
    a.with(|conn| feeds::subscribe(conn, &feed_url(news), None, feeds::FeedDestination::Feeds)).unwrap();
    b.with(|conn| feeds::subscribe(conn, &feed_url(news), Some("News on B".into()), feeds::FeedDestination::Inbox)).unwrap();
    let left = c.with(|conn| feeds::subscribe(conn, &feed_url(blog), None, feeds::FeedDestination::Notify)).unwrap();
    converge(&meter, "feeds followed", &[&a, &b, &c]).await;
    for device in [&a, &b, &c] {
        let urls = device.with(|conn| column(conn, "SELECT url FROM feeds ORDER BY url"));
        assert_eq!(urls, [blog, news], "{}: one feed per address", device.name);
    }
    let news_uid = a.with(|conn| conn.query_row("SELECT uid FROM feeds WHERE url = ?1", [news], |r| r.get::<_, String>(0))).unwrap();
    c.with(|conn| feeds::update(conn, &news_uid, Some("The news".into()), Some(feeds::FeedDestination::Notify))).unwrap();
    a.with(|conn| feeds::unsubscribe(conn, &left.uid)).unwrap();
    converge(&meter, "feeds changed and left", &[&a, &b, &c]).await;
    for device in [&a, &b, &c] {
        let list = device.with(|conn| feeds::feeds(conn)).unwrap();
        assert_eq!(list.len(), 1, "{}: the left feed is gone", device.name);
        assert_eq!((list[0].title.as_deref(), list[0].destination), (Some("The news"), feeds::FeedDestination::Notify), "{}", device.name);
    }
    let order = a.collection_order();
    for device in [&a, &b, &c] {
        assert_unique(device);
        assert_eq!(device.search("quantum"), ["https://b.example/1"], "{}: the search finds the synced title", device.name);
        assert_eq!(device.collection_order(), order, "{}: the sidebar's order", device.name);
        device.with(|conn| {
            let gone: bool = conn.query_row("SELECT EXISTS (SELECT 1 FROM bookmarks WHERE uid = ?1)", [&doomed_uid], |r| r.get(0)).unwrap();
            assert!(!gone, "{}: the purged bookmark is gone", device.name);
            let tomb: i64 = conn.query_row("SELECT count(*) FROM tombstones WHERE uid = ?1", [&doomed_uid], |r| r.get(0)).unwrap();
            assert_eq!(tomb, 1, "{}: its tombstone", device.name);
            let restored: Option<String> =
                conn.query_row("SELECT deleted_at FROM bookmarks WHERE url = 'https://c.example/1'", [], |r| r.get(0)).unwrap();
            assert_eq!(restored, None, "{}: restored from the trash", device.name);
            let tags: String = conn
                .query_row(
                    "SELECT group_concat(t.name, ',') FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
                     JOIN bookmarks b ON b.id = bt.bookmark_id WHERE b.url = ?1 ORDER BY t.name",
                    [shared[0]],
                    |r| r.get(0),
                )
                .unwrap();
            let mut tags: Vec<&str> = tags.split(',').collect();
            tags.sort();
            assert_eq!(tags, ["e2e", "merged"], "{}: the tags set on B", device.name);
        });
    }

    // ── 3. The hub goes away; B and C go on; A comes back and catches up ─────
    a.stop().await;
    let away = Instant::now();
    b.with(|conn| db::update_bookmark(conn, id(conn, "https://c.example/3"), Some("Edited by B while the hub is away".into()), None, None, None, None))
        .unwrap();
    c.with(|conn| {
        db::create_collection(conn, "Hub away", None, None).unwrap();
        db::update_bookmark(conn, id(conn, "https://b.example/3"), None, None, None, None, Some(vec!["away".into()])).unwrap();
    });
    a.with(|conn| db::update_bookmark(conn, id(conn, "https://c.example/4"), Some("Edited on A offline".into()), None, None, None, None))
        .unwrap();
    converge(&meter, "B and C without the hub", &[&b, &c]).await;
    eprintln!("[e2e] B and C converged without the hub in {:.2} s", away.elapsed().as_secs_f64());
    let back = Instant::now();
    a.start(&keys, &url);
    converge(&meter, "A back", &[&a, &b, &c]).await;
    eprintln!("[e2e] A caught up in {:.2} s", back.elapsed().as_secs_f64());
    assert_eq!(c.search("offline").len(), 1, "A's offline edit reached C");

    // ── 4. A removes C; B rekeys; C hears nothing more ───────────────────────
    let c_mark = c.mark();
    let removal = Instant::now();
    a.act(Action::RemoveDevice { device: c.id });
    let stop = c.wait(c_mark, "a stop", |e| if let Event::Stopped(stop) = e { Some(stop.clone()) } else { None }).await;
    assert_eq!(stop, Stop::Revoked);
    c.stop().await;
    assert_eq!(c.meta("library_key"), None, "C forgot the library key");
    let rekeyed = Instant::now();
    loop {
        if a.meta("key_epoch").as_deref() == Some("1") && b.meta("key_epoch").as_deref() == Some("1") {
            break;
        }
        assert!(rekeyed.elapsed() < CONVERGE, "B never got the new key: A {:?}, B {:?}", a.meta("key_epoch"), b.meta("key_epoch"));
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    eprintln!("[e2e] C revoked and B rekeyed in {:.2} s", removal.elapsed().as_secs_f64());
    let c_after = c.dump();
    a.with(|conn| db::update_bookmark(conn, id(conn, "https://b.example/4"), Some("After the removal".into()), None, None, None, None))
        .unwrap();
    b.with(|conn| db::create_collection(conn, "After C left", None, None)).unwrap();
    converge(&meter, "A and B after the removal", &[&a, &b]).await;
    assert_eq!(c.dump(), c_after, "nothing reached C after its removal");
    assert!(a.search("removal").len() == 1 && b.search("removal").len() == 1);

    // ── 5. A snapshot of 10,000 bookmarks to a new device ────────────────────
    let made = Instant::now();
    a.with(|conn| many(conn, SNAPSHOT));
    eprintln!("[e2e] {SNAPSHOT} bookmarks saved on A in {:.2} s", made.elapsed().as_secs_f64());
    let pushed = converge(&meter, "10,000 bookmarks pushed from A to B", &[&a, &b]).await;
    let mut d = Device::new("New Mac", test_libraries::fresh(&place("d")));
    let paired = Instant::now();
    pair(&a, &mut d, &keys, &url).await;
    let pairing = paired.elapsed();
    let snapshot = converge(&meter, "10,000 bookmarks to the new device", &[&a, &b, &d]).await;
    let total: i64 = d.with(|conn| conn.query_row("SELECT count(*) FROM bookmarks", [], |r| r.get(0))).unwrap();
    assert!(total as usize >= SNAPSHOT);
    assert_unique(&d);
    assert_eq!(d.search("quantum"), ["https://b.example/1"]);
    eprintln!(
        "[e2e] snapshot: {total} bookmarks; push A->B {:.2} s; new device paired in {:.2} s, snapshot in {:.2} s",
        pushed.as_secs_f64(),
        pairing.as_secs_f64(),
        snapshot.as_secs_f64()
    );

    // No connection was dropped or refused on the way (a 4008 shows as a retry of 15 s or more).
    let closes: Vec<(&str, Vec<(Option<u16>, Option<String>)>)> = [&a, &b, &c, &d].iter().map(|x| (x.name, x.closes())).collect();
    let trouble: Vec<(&str, Vec<String>)> = [&a, &b, &c, &d].iter().map(|x| (x.name, x.trouble())).collect();
    eprintln!("[e2e] errors and drops: {trouble:#?}");
    a.stop().await;
    b.stop().await;
    d.stop().await;
    let trace = std::env::temp_dir().join("koonapin-e2e-trace.txt");
    meter.write_trace(&trace);
    eprintln!("[e2e] what the devices sent: {}", trace.display());
    eprintln!("[e2e] connections closed: {closes:?}");
    // No connection was refused or dropped on the way, 4008 above all; C's ended with 4003.
    let expected = vec![("Studio Mac", vec![]), ("Laptop", vec![]), ("Office PC", vec![(Some(4003), Some("revoked".to_string()))]), ("New Mac", vec![])];
    assert_eq!(closes, expected);
    // Nothing refused by the relay (a keepalive it doesn't know is a bad_message); the only
    // frames dropped are those sealed under the new epoch before a device had its key.
    for (name, trouble) in &trouble {
        let unexpected: Vec<&String> = trouble.iter().filter(|t| !t.contains("reason: UnknownEpoch")).collect();
        assert!(unexpected.is_empty(), "{name}: {unexpected:#?}");
    }
    let pings = meter.sent.lock().unwrap().iter().filter(|s| s.text.as_deref() == Some(r#"{"t":"ping"}"#)).count();
    assert!(pings > 0, "the keepalive went out");
    drop((a, b, c, d));
    let _ = std::fs::remove_dir_all(&folder);
}

// ── Changing the hub and starting over ───────────────────────────────────────

/// The person on another device asks to be the main computer: denied, then allowed; with the hub
/// gone, starting over from another device, the others held until they join again.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs the relay running locally: see commercial/koona-sync/E2E.md"]
async fn the_hub_hands_over_and_the_account_starts_over() {
    let setup = Setup::new().await;
    let (meter, url, keys) = (&setup.meter, setup.url.clone(), setup.keys.clone());
    let mut a = Device::new("Desk Mac", library_a(&setup.place("a")));
    let b_urls = ["https://example.com/notes", "https://hand.example/b1", "https://hand.example/b2"];
    let c_urls = ["https://example.com/notes", "https://hand.example/c1", "https://hand.example/c2"];
    let mut b = Device::new("Travel Laptop", library_other(&setup.place("b"), &b_urls, &["Reading"], &["from-b"]));
    let mut c = Device::new("Home PC", library_other(&setup.place("c"), &c_urls, &["Travel"], &["from-c"]));
    let mut d = Device::new("Spare Mac", test_libraries::fresh(&setup.place("d")));
    for device in [&a, &b, &c, &d] {
        eprintln!("[e2e] {} is {}", device.name, device.id);
    }
    let a_mark = a.mark();
    a.start(&keys, &url);
    a.wait_phase(a_mark, Phase::Online).await;
    pair(&a, &mut b, &keys, &url).await;
    pair(&a, &mut c, &keys, &url).await;
    pair(&a, &mut d, &keys, &url).await;
    converge(meter, "four devices merged", &[&a, &b, &c, &d]).await;

    // ── 6. B asks to be the hub: A denies, then allows ──────────────────────
    let handover = Instant::now();
    let (am, bm) = (a.mark(), b.mark());
    b.act(Action::RequestHub);
    b.wait_hub_change(bm, "the wait for the hub's answer", |h| matches!(h, HubChangeEvent::Waiting { hub, hub_name } if *hub == a.id && hub_name == a.name))
        .await;
    a.wait_hub_change(am, "the question on the hub", |h| matches!(h, HubChangeEvent::Asked { device, name } if *device == b.id && name == b.name))
        .await;
    a.act(Action::AnswerHubRequest { allow: false });
    b.wait_hub_change(bm, "denied", |h| *h == HubChangeEvent::Failed { peer: a.id, reason: HubChangeFailure::Denied }).await;
    a.wait_hub_change(am, "settled on the hub", |h| *h == HubChangeEvent::Settled { peer: b.id }).await;
    // Give a stray `account` a moment to show.
    tokio::time::sleep(Duration::from_millis(500)).await;
    for device in [&a, &b, &c, &d] {
        assert_eq!(device.meta("hub"), Some(a.id.to_string()), "{}: A is still the hub", device.name);
        assert!(
            !device.saw(am.min(bm), |e| matches!(e, Event::Session(Effect::Devices { hub: Some(h), .. }) if *h != a.id)),
            "{}: no other hub announced",
            device.name
        );
    }

    let marks: Vec<usize> = [&a, &b, &c, &d].iter().map(|x| x.mark()).collect();
    b.act(Action::RequestHub);
    a.wait_hub_change(marks[0], "the question again", |h| matches!(h, HubChangeEvent::Asked { device, .. } if *device == b.id)).await;
    a.act(Action::AnswerHubRequest { allow: true });
    b.wait_hub_change(marks[1], "settled on the new hub", |h| *h == HubChangeEvent::Settled { peer: a.id }).await;
    for (device, mark) in [&a, &b, &c, &d].iter().zip(&marks) {
        device
            .wait(*mark, "the relay's new hub", |e| matches!(e, Event::Session(Effect::Devices { hub: Some(h), .. }) if *h == b.id).then_some(()))
            .await;
    }
    // B's roster reaches the others, naming every device.
    let started = Instant::now();
    loop {
        let rosters: Vec<_> = [&a, &c, &d].iter().map(|x| (x.roster(), x.meta("hub"))).collect();
        let done = rosters.iter().all(|(roster, hub)| {
            roster.as_ref().is_some_and(|r| r.hub == b.id && [a.id, b.id, c.id, d.id].iter().all(|id| r.key_of(*id).is_some()))
                && hub.as_deref() == Some(&*b.id.to_string())
        });
        if done {
            break;
        }
        assert!(started.elapsed() < CONVERGE, "the new hub's roster never arrived: {rosters:?}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(b.roster().is_some_and(|r| r.hub == b.id), "B pinned its own roster");
    eprintln!("[e2e] the hub handed over to B in {:.2} s", handover.elapsed().as_secs_f64());
    a.with(|conn| db::update_bookmark(conn, id(conn, "https://hand.example/c1"), Some("Edited on A under the new hub".into()), None, None, None, None))
        .unwrap();
    c.with(|conn| db::create_collection(conn, "After the handover", None, None)).unwrap();
    d.with(|conn| db::update_bookmark(conn, id(conn, "https://hand.example/b1"), None, None, None, None, Some(vec!["handover".into()])))
        .unwrap();
    converge(meter, "edits under the new hub", &[&a, &b, &c, &d]).await;

    // The hub away: a request ends at once as unavailable.
    let (cm, am) = (c.mark(), a.mark());
    b.stop().await;
    for (device, mark) in [(&c, cm), (&a, am)] {
        device
            .wait(mark, "B offline", |e| matches!(e, Event::Session(Effect::Devices { online, .. }) if !online.contains(&b.id)).then_some(()))
            .await;
    }
    let cm = c.mark();
    c.act(Action::RequestHub);
    c.wait_hub_change(cm, "unavailable", |h| *h == HubChangeEvent::Failed { peer: b.id, reason: HubChangeFailure::Unavailable }).await;

    // ── 7. With the hub gone, C starts over ─────────────────────────────────
    let epoch: u32 = c.meta("key_epoch").unwrap().parse().unwrap();
    let old_key = c.meta("library_key").unwrap();
    let marks: Vec<usize> = [&a, &c, &d].iter().map(|x| x.mark()).collect();
    // A sign-in an hour old is refused, and nothing changes.
    c.act(Action::StartOver { token: keys.sign_in(Utc::now().timestamp() - 3600) });
    c.wait(marks[1], "stale_sign_in", |e| {
        matches!(e, Event::Session(Effect::Error(SessionError::Relay(code))) if code == "stale_sign_in").then_some(())
    })
    .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    for (device, mark) in [&a, &c, &d].iter().zip(&marks) {
        assert!(!device.saw(*mark, |e| matches!(e, Event::Closed { .. })), "{}: no connection closed", device.name);
        assert_eq!(device.meta("key_epoch"), Some(epoch.to_string()), "{}: the epoch", device.name);
        assert_eq!(device.meta("hub"), Some(b.id.to_string()), "{}: the hub", device.name);
    }
    assert_eq!(c.meta("library_key"), Some(old_key.clone()));

    let start_over = Instant::now();
    let b_before = b.dump();
    c.act(Action::StartOver { token: keys.sign_in(Utc::now().timestamp()) });
    let after_close = c.wait_at(marks[1], "4005 on C", |e| matches!(e, Event::Closed { code: Some(4005), .. }).then_some(())).await.0;
    c.wait_phase(after_close, Phase::Online).await;
    let started = Instant::now();
    while c.meta("key_epoch") != Some((epoch + 1).to_string()) {
        assert!(started.elapsed() < CONVERGE, "C never took the new epoch: {:?}", c.meta("key_epoch"));
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(c.meta("hub"), Some(c.id.to_string()), "C is the hub");
    assert_ne!(c.meta("library_key"), Some(old_key.clone()), "C made a new library key");
    let roster = c.roster().unwrap();
    assert_eq!((roster.hub, roster.devices.len()), (c.id, 1), "C's roster names C alone");
    eprintln!("[e2e] C started over in {:.2} s", start_over.elapsed().as_secs_f64());

    // A and D were disconnected too; they come back pending and hold, offering nothing.
    let c_codes = c.mark();
    for (device, mark) in [(&a, marks[0]), (&d, marks[2])] {
        let after = device.wait_at(mark, "4005", |e| matches!(e, Event::Closed { code: Some(4005), .. }).then_some(())).await.0;
        let (by, by_name, at_epoch) = device
            .wait(after, "the start over shown", |e| match e {
                Event::Session(Effect::StartedOver { by, by_name, epoch, .. }) => Some((*by, by_name.clone(), *epoch)),
                _ => None,
            })
            .await;
        assert_eq!((by, by_name.as_deref(), at_epoch), (c.id, Some(c.name), epoch + 1), "{}: who started over", device.name);
        device.wait_phase(after, Phase::Paused { reason: PauseReason::StartedOver }).await;
    }
    tokio::time::sleep(Duration::from_secs(1)).await;
    let pairing_on_c = |from: usize| c.saw(from, |e| matches!(e, Event::Session(Effect::Pairing(PairingEvent::Code { .. }))));
    assert!(!pairing_on_c(c_codes), "no pairing offer reached the new hub");
    for device in [&a, &d] {
        assert_eq!(device.phase(), Some(Phase::Paused { reason: PauseReason::StartedOver }), "{}: held", device.name);
        assert_eq!(device.meta("key_epoch"), Some(epoch.to_string()), "{}: still the old key", device.name);
    }

    // Edits on both sides meanwhile; A joins again, pairs with C, and its library merges back.
    a.with(|conn| db::update_bookmark(conn, id(conn, "https://hand.example/b2"), Some("Edited on A while held".into()), None, None, None, None))
        .unwrap();
    c.with(|conn| db::create_collection(conn, "Started over", None, None)).unwrap();
    let d_held = d.dump();
    let (cm, am) = (c.mark(), a.mark());
    a.act(Action::JoinAgain);
    let code = confirm_pairing(&c, &a, cm, am).await;
    eprintln!("[e2e] A joined again with code {code}");
    converge(meter, "A merged back into the new hub", &[&a, &c]).await;
    assert_eq!(a.meta("key_epoch"), Some((epoch + 1).to_string()), "A holds the new key");
    assert_eq!(a.meta("library_key"), c.meta("library_key"));
    assert_eq!(a.meta("hub"), Some(c.id.to_string()));
    for device in [&a, &c] {
        assert_unique(device);
        assert_eq!(device.search("held").len(), 1, "{}: A's edit while held", device.name);
        assert!(device.collection_order().iter().any(|n| n == "Started over"), "{}: C's edit after the start over", device.name);
    }
    let roster = a.roster().unwrap();
    assert!(roster.hub == c.id && roster.key_of(a.id).is_some() && roster.key_of(c.id).is_some(), "A pinned C's roster");
    assert_eq!(d.dump(), d_held, "nothing reached D, held");
    assert_eq!(d.phase(), Some(Phase::Paused { reason: PauseReason::StartedOver }));

    // The old hub comes back: held too, its library as it left it.
    let (bm, cm) = (b.mark(), c.mark());
    b.start(&keys, &url);
    b.wait(bm, "the start over shown on B", |e| matches!(e, Event::Session(Effect::StartedOver { by, .. }) if *by == c.id).then_some(()))
        .await;
    b.wait_phase(bm, Phase::Paused { reason: PauseReason::StartedOver }).await;
    a.with(|conn| db::update_bookmark(conn, id(conn, "https://hand.example/c2"), Some("After B came back".into()), None, None, None, None))
        .unwrap();
    converge(meter, "A and C with the old hub held", &[&a, &c]).await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(!pairing_on_c(cm), "the old hub offered nothing");
    assert_eq!(b.phase(), Some(Phase::Paused { reason: PauseReason::StartedOver }), "B held");
    assert_eq!(b.dump(), b_before, "nothing reached the old hub");
    assert_eq!(b.meta("key_epoch"), Some(epoch.to_string()));

    let closes: Vec<(&str, Vec<(Option<u16>, Option<String>)>)> = [&a, &b, &c, &d].iter().map(|x| (x.name, x.closes())).collect();
    let trouble: Vec<(&str, Vec<String>)> = [&a, &b, &c, &d].iter().map(|x| (x.name, x.trouble())).collect();
    eprintln!("[e2e] errors and drops: {trouble:#?}");
    for device in [&mut a, &mut b, &mut c, &mut d] {
        device.stop().await;
    }
    let trace = std::env::temp_dir().join("koonapin-e2e-trace-hub.txt");
    meter.write_trace(&trace);
    eprintln!("[e2e] what the devices sent: {}", trace.display());
    eprintln!("[e2e] connections closed: {closes:?}");
    // Every device online at the start over was closed with 4005; nothing else closed.
    let started_over = || vec![(Some(4005), Some("started_over".to_string()))];
    let expected = vec![("Desk Mac", started_over()), ("Travel Laptop", vec![]), ("Home PC", started_over()), ("Spare Mac", started_over())];
    assert_eq!(closes, expected);
    // Nothing refused but C's stale sign-in; frames dropped only for an epoch not held yet.
    for (name, trouble) in &trouble {
        let unexpected: Vec<&String> = trouble
            .iter()
            .filter(|t| !t.contains("reason: UnknownEpoch") && !(*name == "Home PC" && t.contains("Relay(\"stale_sign_in\")")))
            .collect();
        assert!(unexpected.is_empty(), "{name}: {unexpected:#?}");
    }
    let stale: usize = trouble.iter().map(|(_, t)| t.iter().filter(|t| t.contains("stale_sign_in")).count()).sum();
    assert_eq!(stale, 1, "one stale sign-in, refused");
    drop((a, b, c, d));
    let _ = std::fs::remove_dir_all(&setup.folder);
}
