//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! The relay client against a local WebSocket server: the headers it sends, the challenge it
//! answers, and the close codes that stop it.

#![cfg(feature = "net")]

mod common;

use common::*;
use futures_util::{SinkExt, StreamExt};
use koona_sync::crypto;
use koona_sync::net::{client, ClientConfig, CredentialSource, Credentials, Event, Handle, Stop};
use koona_sync::protocol::{self, Control, DeviceInfo, DeviceStatus, B64};
use koona_sync::session::{Action, Config, Effect, PauseReason, Phase, Session};
use ring::rand::SystemRandom;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;
use uuid::Uuid;

/// Serves one connection per close code: a challenge, the device's hello, then the close.
async fn relay(listener: TcpListener, closes: Vec<(u16, &'static str)>, seen: Arc<Mutex<Vec<String>>>) {
    for (code, reason) in closes {
        let (stream, _) = listener.accept().await.unwrap();
        let headers = seen.clone();
        let mut ws = tokio_tungstenite::accept_hdr_async(stream, move |req: &Request, res: Response| {
            let mut h = headers.lock().unwrap();
            for name in ["authorization", "x-koona-lease", "x-koona-proto"] {
                h.push(format!("{name}: {}", req.headers().get(name).map(|v| v.to_str().unwrap()).unwrap_or("-")));
            }
            Ok(res)
        })
        .await
        .unwrap();
        let challenge = Control::Challenge { nonce: B64([3; 32]), time: koona_now() };
        ws.send(Message::text(protocol::encode_control(&challenge))).await.unwrap();
        let hello = loop {
            match ws.next().await.unwrap().unwrap() {
                Message::Text(text) => break protocol::decode_control(&text).unwrap(),
                _ => continue,
            }
        };
        let Control::Hello { device, key, sig, .. } = hello else { panic!("expected hello") };
        assert!(crypto::verify_relay_hello(&key.0, "acct", &[3; 32], device, &sig.0).is_ok());
        seen.lock().unwrap().push("hello".into());
        let frame = CloseFrame { code: CloseCode::from(code), reason: reason.into() };
        let _ = ws.send(Message::Close(Some(frame))).await;
        let _ = ws.next().await;
    }
}

fn koona_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

#[tokio::test]
async fn the_client_retries_a_refused_token_once_and_stops_on_the_plan() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/v1/sync", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let server = tokio::spawn(relay(listener, vec![(4001, ""), (4002, "not_in_beta")], seen.clone()));

    let rng = SystemRandom::new();
    let pair = crypto::device_key(&crypto::generate_device_key(&rng).unwrap()).unwrap();
    let session = Session::new(Config::new(Uuid::new_v4(), pair, "acct".into(), "Mac".into(), "0.13.0".into()), Box::new(rng));
    let refreshes = Arc::new(Mutex::new(Vec::new()));
    let log = refreshes.clone();
    let credentials: CredentialSource = Arc::new(move |refresh| {
        log.lock().unwrap().push(refresh);
        Box::pin(async move { Ok(Credentials { token: "jwt".into(), lease: "bGVhc2U=".into() }) })
    });
    let mut cfg = ClientConfig::new(url);
    cfg.min_backoff = Duration::from_millis(10);
    let (_handle, mut events, work) = client(cfg, session, library(replica_id(1)), credentials);
    tokio::spawn(work);

    let stop = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if let Some(Event::Stopped(stop)) = events.recv().await {
                break stop;
            }
        }
    })
    .await
    .expect("the client stops");
    assert_eq!(stop, Stop::Plan(Some("not_in_beta".into())));
    assert_eq!(*refreshes.lock().unwrap(), vec![false, true], "the token is refreshed after 4001");
    let seen = seen.lock().unwrap().clone();
    let proto = format!("x-koona-proto: {}", protocol::PROTO);
    assert_eq!(seen[..4], ["authorization: Bearer jwt", "x-koona-lease: bGVhc2U=", proto.as_str(), "hello"]);
    server.await.unwrap();
}

type Socket = WebSocketStream<TcpStream>;

/// Accepts the next connection and gets as far as the device's hello: the socket, the device
/// and its key.
async fn greet(listener: &TcpListener) -> (Socket, Uuid, B64<32>) {
    let (stream, _) = listener.accept().await.unwrap();
    let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
    let challenge = Control::Challenge { nonce: B64([3; 32]), time: koona_now() };
    ws.send(Message::text(protocol::encode_control(&challenge))).await.unwrap();
    loop {
        if let Message::Text(text) = ws.next().await.unwrap().unwrap() {
            let Control::Hello { device, key, .. } = protocol::decode_control(&text).unwrap() else { panic!("expected hello") };
            return (ws, device, key);
        }
    }
}

async fn close_with(mut ws: Socket, code: u16, reason: &'static str) {
    let _ = ws.send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.into() }))).await;
    let _ = ws.next().await;
}

/// A running client and its credential calls (`true`: refresh first).
fn start(cfg: ClientConfig) -> (Handle, tokio::sync::mpsc::UnboundedReceiver<Event>, Arc<Mutex<Vec<bool>>>) {
    let rng = SystemRandom::new();
    let pair = crypto::device_key(&crypto::generate_device_key(&rng).unwrap()).unwrap();
    let session = Session::new(Config::new(Uuid::new_v4(), pair, "acct".into(), "Mac".into(), "0.13.0".into()), Box::new(rng));
    let refreshes = Arc::new(Mutex::new(Vec::new()));
    let log = refreshes.clone();
    let credentials: CredentialSource = Arc::new(move |refresh| {
        log.lock().unwrap().push(refresh);
        Box::pin(async move { Ok(Credentials { token: "jwt".into(), lease: "bGVhc2U=".into() }) })
    });
    let (handle, events, work) = client(cfg, session, library(replica_id(1)), credentials);
    tokio::spawn(work);
    (handle, events, refreshes)
}

/// Every event until the client stops.
async fn until_stopped(events: &mut tokio::sync::mpsc::UnboundedReceiver<Event>, limit: Duration) -> (Stop, Vec<Event>) {
    tokio::time::timeout(limit, async {
        let mut seen = Vec::new();
        loop {
            match events.recv().await {
                Some(Event::Stopped(stop)) => break (stop, seen),
                Some(event) => seen.push(event),
                None => panic!("the client went away without stopping"),
            }
        }
    })
    .await
    .expect("the client stops")
}

#[tokio::test]
async fn a_silent_socket_is_closed_and_dialed_again() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut cfg = ClientConfig::new(format!("ws://{}/v1/sync", listener.local_addr().unwrap()));
    cfg.min_backoff = Duration::from_millis(10);
    cfg.ping_every = Duration::from_millis(100);
    let (_handle, mut events, _) = start(cfg);

    // The first relay goes quiet after the hello and never closes: a half-open socket.
    let (silent, _, _) = greet(&listener).await;
    let (second, _, _) = tokio::time::timeout(Duration::from_secs(3), greet(&listener)).await.expect("the client dials again");
    close_with(second, 4002, "").await;
    let (stop, seen) = until_stopped(&mut events, Duration::from_secs(5)).await;
    assert_eq!(stop, Stop::Plan(Some(String::new())));
    assert!(seen.contains(&Event::Closed { code: None, reason: None }), "the silent socket ends without a code");
    drop(silent);
}

#[tokio::test]
async fn a_paused_device_after_welcome_gets_a_fresh_token_each_time() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut cfg = ClientConfig::new(format!("ws://{}/v1/sync", listener.local_addr().unwrap()));
    cfg.min_backoff = Duration::from_millis(10);
    let (_handle, mut events, refreshes) = start(cfg);

    let server = tokio::spawn(async move {
        for code in [4001, 4001, 4002] {
            let (mut ws, device, key) = greet(&listener).await;
            // A day off: the device holds in clock skew and never gets online.
            let skewed = koona_now() - 24 * 3600 * 1000;
            let me = DeviceInfo { id: device, name: "Mac".into(), key, status: DeviceStatus::Active, last_seen: skewed };
            let welcome = Control::Welcome {
                status: DeviceStatus::Active,
                hub: device,
                epoch: 0,
                devices: vec![me],
                online: vec![device],
                time: skewed,
                started_over: None,
            };
            ws.send(Message::text(protocol::encode_control(&welcome))).await.unwrap();
            close_with(ws, code, "").await;
        }
    });

    let (stop, seen) = until_stopped(&mut events, Duration::from_secs(10)).await;
    assert_eq!(stop, Stop::Plan(Some(String::new())), "a token that worked before is not a sign-out");
    assert_eq!(*refreshes.lock().unwrap(), vec![false, true, true], "a refresh after each 4001");
    let paused = Event::Session(Effect::Status(Phase::Paused { reason: PauseReason::ClockSkew }));
    assert!(seen.contains(&paused), "the welcome left the device paused");
    server.await.unwrap();
}

#[tokio::test]
async fn an_action_that_needs_the_relay_ends_the_wait() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut cfg = ClientConfig::new(format!("ws://{}/v1/sync", listener.local_addr().unwrap()));
    cfg.min_backoff = Duration::from_secs(60);
    let (handle, mut events, _) = start(cfg);

    let (ws, _, _) = greet(&listener).await;
    close_with(ws, 1011, "").await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while !matches!(events.recv().await, Some(Event::Retrying(_))) {}
    })
    .await
    .expect("the client waits");
    // Not one for the relay: the wait goes on.
    assert!(handle.act(Action::LocalChange));
    assert!(tokio::time::timeout(Duration::from_millis(300), listener.accept()).await.is_err(), "still waiting");
    assert!(handle.act(Action::SyncNow));
    let (ws, _, _) = tokio::time::timeout(Duration::from_secs(2), greet(&listener)).await.expect("the client dials at once");
    close_with(ws, 4002, "").await;
    let (stop, _) = until_stopped(&mut events, Duration::from_secs(5)).await;
    assert_eq!(stop, Stop::Plan(Some(String::new())));
}
