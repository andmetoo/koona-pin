//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! The relay client against a local WebSocket server: the headers it sends, the challenge it
//! answers, and the close codes that stop it.

#![cfg(feature = "net")]

mod common;

use common::*;
use futures_util::{SinkExt, StreamExt};
use koona_sync::crypto;
use koona_sync::net::{client, ClientConfig, CredentialSource, Credentials, Event, Stop};
use koona_sync::protocol::{self, Control, B64};
use koona_sync::session::{Config, Session};
use ring::rand::SystemRandom;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
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
    assert_eq!(seen[..4], ["authorization: Bearer jwt", "x-koona-lease: bGVhc2U=", "x-koona-proto: 1", "hello"]);
    server.await.unwrap();
}
