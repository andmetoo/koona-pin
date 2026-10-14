//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! The socket around a [`Session`]: dials the relay over WSS with the account's credentials,
//! feeds the session what arrives, sends what it returns at a pace the relay's rate limits
//! allow, and reconnects with jittered exponential backoff, except after a close code that no
//! retry cures. Library calls run on the blocking pool: an apply can take a while.
//!
//! [`client`] returns a handle for the person's actions, a stream of events for the interface,
//! and the future that does the work, for the app to spawn on its tokio runtime.

use crate::library::Library;
use crate::protocol::{close, MAX_BODY, MAX_CONTROL, PROTO};
use crate::session::{Action, Effect, Input, Phase, Session, DEVICE_LIMIT};
use futures_util::{SinkExt, StreamExt};
use ring::rand::{SecureRandom, SystemRandom};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::Connector;

/// What the relay checks before the upgrade.
#[derive(Clone)]
pub struct Credentials {
    /// The Supabase access token (JWT).
    pub token: String,
    /// Base64 of the lease JSON `{"payload": ..., "signature": ...}`.
    pub lease: String,
}

pub type CredentialsFuture = Pin<Box<dyn Future<Output = Result<Credentials, String>> + Send>>;
/// Called before every connection; `true` after the relay refused the token (4001), so the app
/// refreshes it first.
pub type CredentialSource = Arc<dyn Fn(bool) -> CredentialsFuture + Send + Sync>;

#[derive(Debug, Clone)]
pub struct ClientConfig {
    /// `wss://…/v1/sync`.
    pub url: String,
    pub min_backoff: Duration,
    pub max_backoff: Duration,
    /// After 4008: the relay asks for at least 30 s.
    pub rate_limited_backoff: Duration,
    /// Text `ping` keepalive; the relay answers `pong`.
    pub ping_every: Duration,
    pub tick_every: Duration,
    /// The pace of what is sent, kept under the relay's account-wide buckets (20 msg/s with a
    /// burst of 20, 32 MiB/min with a burst of 32 MiB). Messages are paced for the whole account:
    /// each device takes an even share by the number of devices online, since a pairing or a
    /// reconnect is a burst of about 20 messages from two devices at once. Bytes are per device.
    pub messages_per_second: f64,
    pub message_burst: f64,
    pub bytes_per_minute: f64,
    pub byte_burst: f64,
}

impl ClientConfig {
    pub fn new(url: impl Into<String>) -> ClientConfig {
        ClientConfig {
            url: url.into(),
            min_backoff: Duration::from_secs(1),
            max_backoff: Duration::from_secs(300),
            rate_limited_backoff: Duration::from_secs(30),
            ping_every: Duration::from_secs(30),
            tick_every: Duration::from_secs(1),
            messages_per_second: 15.0,
            message_burst: 15.0,
            bytes_per_minute: (24 << 20) as f64,
            byte_burst: (8 << 20) as f64,
        }
    }
}

/// Why the client gave up for good; the app shows it and starts a new client when it changes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stop {
    /// [`Handle::shutdown`], or every handle dropped.
    Shutdown,
    /// 4001 again right after a token refresh.
    Auth,
    /// 4002, with the relay's reason (e.g. `not_in_beta`).
    Plan(Option<String>),
    Revoked,
    UpdateNeeded,
    /// 4008 `device_limit`.
    DeviceLimit,
    /// 4009: this device connected again elsewhere (another process).
    Replaced,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// Every session effect except the frames to send.
    Session(Effect),
    /// The next attempt is in this long.
    Retrying(Duration),
    Stopped(Stop),
}

enum Command {
    Action(Action),
    Shutdown,
}

#[derive(Clone)]
pub struct Handle {
    tx: mpsc::UnboundedSender<Command>,
}

impl Handle {
    /// False once the client stopped.
    pub fn act(&self, action: Action) -> bool {
        self.tx.send(Command::Action(action)).is_ok()
    }

    pub fn shutdown(&self) {
        let _ = self.tx.send(Command::Shutdown);
    }
}

pub fn client<L: Library + Send + 'static>(
    config: ClientConfig,
    session: Session,
    library: L,
    credentials: CredentialSource,
) -> (Handle, mpsc::UnboundedReceiver<Event>, impl Future<Output = ()> + Send + 'static) {
    let (tx, rx) = mpsc::unbounded_channel();
    let (events_tx, events) = mpsc::unbounded_channel();
    let core = Arc::new(Mutex::new(Core { session, library }));
    let work = run(config, core, credentials, rx, events_tx);
    (Handle { tx }, events, work)
}

struct Core<L> {
    session: Session,
    library: L,
}

/// An input the blocking pool can own.
enum Owned {
    Dialing,
    Connected,
    Text(String),
    Binary(Vec<u8>),
    Closed(Option<u16>, Option<String>),
    Tick,
    Pump,
    Action(Action),
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Feeds one input; returns the effects, whether answers are waiting to go out, and how many of
/// the account's devices are online.
async fn feed<L: Library + Send + 'static>(core: &Arc<Mutex<Core<L>>>, input: Owned) -> (Vec<Effect>, bool, usize) {
    let core = core.clone();
    tokio::task::spawn_blocking(move || {
        let mut guard = core.lock().unwrap_or_else(|e| e.into_inner());
        let Core { session, library } = &mut *guard;
        let now = now_ms();
        let effects = match &input {
            Owned::Action(action) => session.act(library, now, action.clone()),
            Owned::Dialing => session.handle(library, now, Input::Dialing),
            Owned::Connected => session.handle(library, now, Input::Connected),
            Owned::Text(text) => session.handle(library, now, Input::Text(text)),
            Owned::Binary(frame) => session.handle(library, now, Input::Binary(frame)),
            Owned::Closed(code, reason) => session.handle(library, now, Input::Closed { code: *code, reason: reason.as_deref() }),
            Owned::Tick => session.handle(library, now, Input::Tick),
            Owned::Pump => session.handle(library, now, Input::Pump),
        };
        (effects, session.wants_pump(), session.devices_online())
    })
    .await
    .unwrap_or_else(|_| (Vec::new(), false, 1))
}

/// A client-side token bucket over messages and bytes, kept across reconnects: the relay's
/// buckets are per account and don't refill faster because the socket is new.
struct Pace {
    messages: f64,
    bytes: f64,
    at: Instant,
    cfg: ClientConfig,
    /// The account's devices online: this one's share of the message pace is one of them.
    devices: usize,
}

impl Pace {
    fn new(cfg: &ClientConfig) -> Pace {
        Pace { messages: cfg.message_burst, bytes: cfg.byte_burst, at: Instant::now(), cfg: cfg.clone(), devices: 1 }
    }

    fn message_rate(&self) -> f64 {
        self.cfg.messages_per_second / self.devices as f64
    }

    /// At least one message, or nothing would ever go.
    fn message_burst(&self) -> f64 {
        (self.cfg.message_burst / self.devices as f64).max(1.0)
    }

    fn set_devices(&mut self, devices: usize) {
        if devices.max(1) != self.devices {
            self.refill();
            self.devices = devices.max(1);
            self.messages = self.messages.min(self.message_burst());
        }
    }

    fn refill(&mut self) {
        let now = Instant::now();
        let secs = now.duration_since(self.at).as_secs_f64();
        self.at = now;
        self.messages = (self.messages + secs * self.message_rate()).min(self.message_burst());
        self.bytes = (self.bytes + secs * self.cfg.bytes_per_minute / 60.0).min(self.cfg.byte_burst);
    }

    async fn take(&mut self, len: usize) {
        let len = (len as f64).min(self.cfg.byte_burst);
        loop {
            self.refill();
            if self.messages >= 1.0 && self.bytes >= len {
                self.messages -= 1.0;
                self.bytes -= len;
                return;
            }
            let for_messages = (1.0 - self.messages).max(0.0) / self.message_rate();
            let for_bytes = (len - self.bytes).max(0.0) / (self.cfg.bytes_per_minute / 60.0);
            tokio::time::sleep(Duration::from_secs_f64(for_messages.max(for_bytes).max(0.001))).await;
        }
    }
}

fn jitter(base: Duration) -> Duration {
    let mut byte = [0u8; 2];
    let _ = SystemRandom::new().fill(&mut byte);
    // Between half and all of the backoff, so devices of one account don't retry in step.
    let share = 0.5 + f64::from(u16::from_be_bytes(byte)) / f64::from(u16::MAX) / 2.0;
    base.mul_f64(share)
}

fn request(
    url: &str,
    credentials: &Credentials,
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, String> {
    let mut request = url.into_client_request().map_err(|e| e.to_string())?;
    let headers = request.headers_mut();
    let value = |text: String| HeaderValue::from_str(&text).map_err(|e| e.to_string());
    headers.insert("Authorization", value(format!("Bearer {}", credentials.token))?);
    headers.insert("X-Koona-Lease", value(credentials.lease.clone())?);
    headers.insert("X-Koona-Proto", value(PROTO.to_string())?);
    Ok(request)
}

/// rustls with ring and the webpki roots, built here so no process-wide provider is needed.
fn connector() -> Connector {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("ring supports the default TLS versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
    Connector::Rustls(Arc::new(config))
}

enum Ended {
    Closed(Option<u16>, Option<String>),
    Shutdown,
}

/// Sends the frames among `effects` and reports the rest. Returns whether the socket still works.
async fn deliver<S>(effects: Vec<Effect>, sink: &mut S, pace: &mut Pace, events: &mpsc::UnboundedSender<Event>, online: &mut bool) -> bool
where
    S: futures_util::Sink<Message> + Unpin,
{
    for effect in effects {
        let message = match effect {
            Effect::SendText(text) => {
                pace.take(text.len()).await;
                Message::text(text)
            }
            Effect::SendBinary(frame) => {
                pace.take(frame.len()).await;
                Message::binary(frame)
            }
            other => {
                if let Effect::Status(phase) = &other {
                    *online |= matches!(phase, Phase::Online | Phase::Pending | Phase::Syncing { .. });
                }
                let _ = events.send(Event::Session(other));
                continue;
            }
        };
        if sink.send(message).await.is_err() {
            return false;
        }
    }
    true
}

fn report(effects: Vec<Effect>, events: &mpsc::UnboundedSender<Event>) {
    for effect in effects {
        if !matches!(effect, Effect::SendText(_) | Effect::SendBinary(_)) {
            let _ = events.send(Event::Session(effect));
        }
    }
}

async fn run<L: Library + Send + 'static>(
    cfg: ClientConfig,
    core: Arc<Mutex<Core<L>>>,
    credentials: CredentialSource,
    mut commands: mpsc::UnboundedReceiver<Command>,
    events: mpsc::UnboundedSender<Event>,
) {
    let connector = connector();
    let mut pace = Pace::new(&cfg);
    let mut backoff = cfg.min_backoff;
    let mut refresh = false;
    let ws_config = WebSocketConfig::default()
        .max_message_size(Some(MAX_BODY.max(MAX_CONTROL) + 64))
        .max_frame_size(Some(MAX_BODY.max(MAX_CONTROL) + 64));
    let stop = 'outer: loop {
        let mut wait = backoff;
        let attempt: Result<Ended, String> = async {
            let credentials = (credentials)(refresh).await?;
            report(feed(&core, Owned::Dialing).await.0, &events);
            let request = request(&cfg.url, &credentials)?;
            let dial = tokio_tungstenite::connect_async_tls_with_config(request, Some(ws_config), true, Some(connector.clone()));
            let (socket, _) = dial.await.map_err(|e| e.to_string())?;
            Ok(drive(&cfg, &core, socket, &mut commands, &events, &mut pace, &mut backoff, &mut refresh).await)
        }
        .await;
        let (code, reason) = match attempt {
            Ok(Ended::Shutdown) => break Stop::Shutdown,
            Ok(Ended::Closed(code, reason)) => (code, reason),
            Err(error) => {
                let _ = events.send(Event::Session(Effect::Error(crate::session::SessionError::Relay(error))));
                (None, None)
            }
        };
        report(feed(&core, Owned::Closed(code, reason.clone())).await.0, &events);
        match code {
            Some(close::AUTH) if refresh => break Stop::Auth,
            Some(close::AUTH) => {
                // Once more with a fresh token, right away.
                refresh = true;
                wait = cfg.min_backoff;
            }
            Some(close::PLAN) => break Stop::Plan(reason),
            Some(close::REVOKED) => break Stop::Revoked,
            Some(close::PROTO_TOO_OLD) => break Stop::UpdateNeeded,
            Some(close::RATE_LIMITED) if reason.as_deref() == Some(DEVICE_LIMIT) => break Stop::DeviceLimit,
            Some(close::RATE_LIMITED) => wait = wait.max(cfg.rate_limited_backoff),
            Some(close::REPLACED) => break Stop::Replaced,
            _ => {}
        }
        let delay = jitter(wait);
        backoff = (backoff * 2).min(cfg.max_backoff);
        let _ = events.send(Event::Retrying(delay));
        let sleep = tokio::time::sleep(delay);
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                _ = &mut sleep => break,
                command = commands.recv() => match command {
                    Some(Command::Action(action)) => report(feed(&core, Owned::Action(action)).await.0, &events),
                    Some(Command::Shutdown) | None => break 'outer Stop::Shutdown,
                },
            }
        }
    };
    let _ = events.send(Event::Stopped(stop));
}

async fn drive<L: Library + Send + 'static, S>(
    cfg: &ClientConfig,
    core: &Arc<Mutex<Core<L>>>,
    socket: S,
    commands: &mut mpsc::UnboundedReceiver<Command>,
    events: &mpsc::UnboundedSender<Event>,
    pace: &mut Pace,
    backoff: &mut Duration,
    refresh: &mut bool,
) -> Ended
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + futures_util::Sink<Message>
        + Unpin,
{
    let (mut sink, mut stream) = socket.split();
    let mut online = false;
    let (effects, mut pumping, devices) = feed(core, Owned::Connected).await;
    pace.set_devices(devices);
    if !deliver(effects, &mut sink, pace, events, &mut online).await {
        return Ended::Closed(None, None);
    }
    let mut tick = tokio::time::interval(cfg.tick_every);
    let mut ping = tokio::time::interval(cfg.ping_every);
    ping.tick().await;
    loop {
        let input = tokio::select! {
            biased;
            message = stream.next() => match message {
                Some(Ok(Message::Text(text))) => Owned::Text(text.to_string()),
                Some(Ok(Message::Binary(frame))) => Owned::Binary(frame.to_vec()),
                Some(Ok(Message::Close(frame))) => {
                    return Ended::Closed(frame.as_ref().map(|f| u16::from(f.code)), frame.map(|f| f.reason.to_string()));
                }
                Some(Ok(_)) => continue,
                Some(Err(_)) | None => return Ended::Closed(None, None),
            },
            command = commands.recv() => match command {
                Some(Command::Action(action)) => Owned::Action(action),
                Some(Command::Shutdown) | None => {
                    let _ = sink.send(Message::Close(None)).await;
                    return Ended::Shutdown;
                }
            },
            _ = tick.tick() => Owned::Tick,
            _ = ping.tick() => {
                pace.take(12).await;
                if sink.send(Message::text(r#"{"t":"ping"}"#)).await.is_err() {
                    return Ended::Closed(None, None);
                }
                continue;
            }
            _ = std::future::ready(()), if pumping => Owned::Pump,
        };
        let (effects, wants, devices) = feed(core, input).await;
        pumping = wants;
        pace.set_devices(devices);
        if !deliver(effects, &mut sink, pace, events, &mut online).await {
            return Ended::Closed(None, None);
        }
        if online {
            // A connection that got as far as `welcome` starts the backoff over.
            *backoff = cfg.min_backoff;
            *refresh = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_message_pace_is_shared_by_the_devices_online() {
        let mut pace = Pace::new(&ClientConfig::new("ws://127.0.0.1/v1/sync"));
        assert_eq!((pace.message_rate(), pace.message_burst()), (15.0, 15.0));
        pace.set_devices(3);
        assert_eq!((pace.message_rate(), pace.message_burst()), (5.0, 5.0));
        assert!(pace.messages <= 5.0, "a full bucket shrinks to the share");
        pace.set_devices(40);
        assert_eq!(pace.message_burst(), 1.0, "at least one message goes");
        pace.set_devices(0);
        assert_eq!(pace.message_rate(), 15.0, "alone when nobody is known to be online");
    }
}
