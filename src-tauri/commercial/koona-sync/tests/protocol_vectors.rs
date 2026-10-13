//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! The vectors in `tests/vectors` pin the wire format for other implementations (the relay in
//! TypeScript mirrors `relay_hello.json`, `frames.json` and `control.json`). Each check recomputes
//! the outputs from the file's inputs. `KOONA_WRITE_VECTORS=1 cargo test -p koona-sync --test
//! protocol_vectors` rewrites the files; a diff in them is a protocol change.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use koona_sync::crypto::{self, Ephemeral, Exchange, Party};
use koona_sync::model::{Clock, Entity, FieldChange, Gone, Group, Hlc, Vector};
use koona_sync::protocol::{
    self, Address, Control, DeviceInfo, DeviceStatus, Header, Kind, PairMessage, SyncMessage, B64,
};
use ring::signature::Ed25519KeyPair;
use serde_json::{json, Value};
use std::path::PathBuf;
use uuid::Uuid;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
}

fn unhex_n<const N: usize>(value: &Value) -> [u8; N] {
    unhex(value.as_str().unwrap()).try_into().unwrap()
}

fn uuid(value: &Value) -> Uuid {
    Uuid::parse_str(value.as_str().unwrap()).unwrap()
}

fn path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/vectors").join(name)
}

/// Writes the freshly built vector when asked, then returns what's on disk.
fn vector(name: &str, build: impl FnOnce() -> Value) -> Value {
    if std::env::var_os("KOONA_WRITE_VECTORS").is_some() {
        let text = serde_json::to_string_pretty(&build()).unwrap() + "\n";
        std::fs::write(path(name), text).unwrap();
    }
    let text = std::fs::read_to_string(path(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
    serde_json::from_str(&text).unwrap()
}

fn address_name(to: Address) -> String {
    match to {
        Address::Hub => "hub".into(),
        Address::All => "all".into(),
        Address::Device(id) => id.to_string(),
    }
}

fn address(value: &Value) -> Address {
    match value.as_str().unwrap() {
        "hub" => Address::Hub,
        "all" => Address::All,
        id => Address::Device(Uuid::parse_str(id).unwrap()),
    }
}

const SUB: &str = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const DEVICE: &str = "0192f3a4-b5c6-7d8e-9f01-23456789abcd";
const HUB: &str = "0192f3a4-0000-7000-8000-00000000b0b0";
const SEED: [u8; 32] = [0x11; 32];
const HUB_SEED: [u8; 32] = [0x22; 32];

#[test]
fn relay_hello() {
    let v = vector("relay_hello.json", || {
        let nonce: [u8; 32] = std::array::from_fn(|i| i as u8);
        let device = Uuid::parse_str(DEVICE).unwrap();
        let pair = Ed25519KeyPair::from_seed_unchecked(&SEED).unwrap();
        let public = crypto::public_key(&pair);
        let sig = crypto::sign_relay_hello(&pair, SUB, &nonce, device);
        let hello = Control::Hello {
            device,
            key: B64(public),
            name: "Studio Mac".into(),
            app: "0.13.0".into(),
            sig: B64(sig),
        };
        json!({
            "description": "hello{sig}: Ed25519 over \"koona-sync relay v1\" || sub || 0x00 || nonce || device(16). base64 is standard with padding.",
            "sub": SUB,
            "device": DEVICE,
            "ed25519_seed_hex": hex(&SEED),
            "public_key_hex": hex(&public),
            "public_key_b64": STANDARD.encode(public),
            "nonce_hex": hex(&nonce),
            "nonce_b64": STANDARD.encode(nonce),
            "signing_bytes_hex": hex(&crypto::relay_hello_bytes(SUB, &nonce, device)),
            "signature_hex": hex(&sig),
            "signature_b64": STANDARD.encode(sig),
            "challenge": serde_json::to_value(Control::Challenge { nonce: B64(nonce), time: 1_760_400_000_000 }).unwrap(),
            "hello": serde_json::to_value(hello).unwrap(),
        })
    });
    let (sub, device, nonce) = (v["sub"].as_str().unwrap(), uuid(&v["device"]), unhex_n::<32>(&v["nonce_hex"]));
    let pair = Ed25519KeyPair::from_seed_unchecked(&unhex(v["ed25519_seed_hex"].as_str().unwrap())).unwrap();
    let public = crypto::public_key(&pair);
    assert_eq!(hex(&public), v["public_key_hex"]);
    assert_eq!(hex(&crypto::relay_hello_bytes(sub, &nonce, device)), v["signing_bytes_hex"]);
    let sig = unhex_n::<64>(&v["signature_hex"]);
    assert_eq!(hex(&crypto::sign_relay_hello(&pair, sub, &nonce, device)), v["signature_hex"]);
    assert_eq!(crypto::verify_relay_hello(&public, sub, &nonce, device, &sig), Ok(()));

    let challenge = protocol::decode_control(&v["challenge"].to_string()).unwrap();
    assert_eq!(challenge, Control::Challenge { nonce: B64(nonce), time: 1_760_400_000_000 });
    let Control::Hello { key, sig: wire_sig, device: wire_device, .. } =
        protocol::decode_control(&v["hello"].to_string()).unwrap()
    else {
        panic!("not a hello")
    };
    assert_eq!((key.0, wire_sig.0, wire_device), (public, sig, device));
    assert_eq!(v["public_key_b64"], STANDARD.encode(public));
    assert_eq!(v["signature_b64"], STANDARD.encode(sig));
}

#[test]
fn frames() {
    let v = vector("frames.json", || {
        let body: Vec<u8> = (0..40).collect();
        let device = Uuid::parse_str(DEVICE).unwrap();
        let outgoing: Vec<Value> = [Address::Hub, Address::All, Address::Device(Uuid::parse_str(HUB).unwrap())]
            .into_iter()
            .map(|to| {
                json!({
                    "to": address_name(to),
                    "body_hex": hex(&body),
                    "frame_hex": hex(&protocol::encode_outgoing(to, &body).unwrap()),
                })
            })
            .collect();
        let relay_ms = 1_760_400_000_123u64;
        let header = Header { kind: Kind::Sync, epoch: 7, session: std::array::from_fn(|i| 0xA0 + i as u8), seq: 258 };
        let pairing = Header { kind: Kind::Pairing, epoch: 0, session: [0x5A; 16], seq: 0 };
        json!({
            "description": "Device -> relay: 0x01 || to(16) || body; to is all-zero for the hub, all-0xFF for every active device. Relay -> device: 0x01 || from(16) || relay_ms(u64 BE) || body. A body starts ver(1)=1 || kind(1) || epoch(u32 BE) || session(16) || seq(u64 BE).",
            "outgoing": outgoing,
            "delivered": [{
                "from": DEVICE,
                "relay_ms": relay_ms,
                "body_hex": hex(&body),
                "frame_hex": hex(&protocol::encode_delivered(device, relay_ms, &body).unwrap()),
            }],
            "headers": ([header, pairing].iter().map(|h| json!({
                "kind": h.kind as u8,
                "epoch": h.epoch,
                "session_hex": hex(&h.session),
                "seq": h.seq,
                "header_hex": hex(&h.encode()),
            })).collect::<Vec<_>>()),
        })
    });
    for case in v["outgoing"].as_array().unwrap() {
        let (to, body) = (address(&case["to"]), unhex(case["body_hex"].as_str().unwrap()));
        let frame = unhex(case["frame_hex"].as_str().unwrap());
        assert_eq!(protocol::encode_outgoing(to, &body).unwrap(), frame);
        assert_eq!(protocol::decode_outgoing(&frame).unwrap(), (to, &body[..]));
    }
    for case in v["delivered"].as_array().unwrap() {
        let (from, relay_ms) = (uuid(&case["from"]), case["relay_ms"].as_u64().unwrap());
        let (body, frame) = (unhex(case["body_hex"].as_str().unwrap()), unhex(case["frame_hex"].as_str().unwrap()));
        assert_eq!(protocol::encode_delivered(from, relay_ms, &body).unwrap(), frame);
        let delivered = protocol::decode_delivered(&frame).unwrap();
        assert_eq!((delivered.from, delivered.relay_ms, delivered.body), (from, relay_ms, &body[..]));
    }
    for case in v["headers"].as_array().unwrap() {
        let header = Header {
            kind: Kind::from_byte(case["kind"].as_u64().unwrap() as u8).unwrap(),
            epoch: case["epoch"].as_u64().unwrap() as u32,
            session: unhex_n(&case["session_hex"]),
            seq: case["seq"].as_u64().unwrap(),
        };
        let bytes = unhex(case["header_hex"].as_str().unwrap());
        assert_eq!(header.encode().to_vec(), bytes);
        assert_eq!(Header::parse(&bytes).unwrap(), (header, &[][..]));
    }
}

#[test]
fn control() {
    let v = vector("control.json", || {
        let (device, hub) = (Uuid::parse_str(DEVICE).unwrap(), Uuid::parse_str(HUB).unwrap());
        let hub_key = crypto::public_key(&Ed25519KeyPair::from_seed_unchecked(&HUB_SEED).unwrap());
        let key = crypto::public_key(&Ed25519KeyPair::from_seed_unchecked(&SEED).unwrap());
        let info = |id, name: &str, key, status| DeviceInfo { id, name: name.into(), key: B64(key), status, last_seen: 1_760_399_000_000 };
        let messages = [
            Control::Welcome {
                status: DeviceStatus::Pending,
                hub,
                epoch: 3,
                devices: vec![
                    info(hub, "Studio Mac", hub_key, DeviceStatus::Active),
                    info(device, "Laptop", key, DeviceStatus::Pending),
                ],
                online: vec![hub, device],
                time: 1_760_400_000_000,
            },
            Control::Presence { device: hub, online: false },
            Control::Device { device: info(device, "Laptop", key, DeviceStatus::Active) },
            Control::Account { hub, epoch: 4 },
            Control::Approve { device },
            Control::Revoke { device },
            Control::SetHub { device },
            Control::Rename { device, name: "Work laptop".into() },
            Control::Epoch { epoch: 4 },
            Control::Error { code: protocol::relay_error::FORBIDDEN.into() },
            Control::Undeliverable { to: Address::Hub.as_uuid() },
        ];
        json!({
            "description": "Control messages (text frames), one JSON object each, tagged by \"t\". Receivers ignore unknown fields.",
            "messages": messages.iter().map(|m| serde_json::to_value(m).unwrap()).collect::<Vec<_>>(),
        })
    });
    for message in v["messages"].as_array().unwrap() {
        let decoded = protocol::decode_control(&message.to_string()).unwrap();
        assert_eq!(&serde_json::to_value(&decoded).unwrap(), message);
    }
}

fn sample_changes() -> SyncMessage {
    let replica = Uuid::parse_str(DEVICE).unwrap();
    let clock = |counter| Clock { hlc: Hlc::new(1_760_400_000_000, 0), replica, counter };
    let bookmark = Uuid::parse_str("0192f3a5-1111-7000-8000-000000000001").unwrap();
    let tag = Uuid::parse_str("0192f3a5-2222-7000-8000-000000000002").unwrap();
    let mut covers = Vector::default();
    covers.0.insert(replica, 4);
    SyncMessage::Changes {
        groups: vec![
            Group {
                entity: Entity::Bookmark,
                uid: bookmark,
                fields: vec![
                    FieldChange { field: "url".into(), value: json!("https://example.com/"), clock: clock(1) },
                    FieldChange { field: "title".into(), value: json!("Example"), clock: clock(2) },
                ],
                gone: None,
            },
            Group {
                entity: Entity::Link,
                uid: bookmark,
                fields: vec![FieldChange { field: tag.to_string(), value: json!(true), clock: clock(3) }],
                gone: None,
            },
            Group {
                entity: Entity::Tag,
                uid: Uuid::parse_str("0192f3a5-3333-7000-8000-000000000003").unwrap(),
                fields: Vec::new(),
                gone: Some(Gone { clock: clock(4), merged_into: Some(tag) }),
            },
        ],
        covers,
        last: true,
    }
}

#[test]
fn changes() {
    let v = vector("changes.json", || {
        let message = sample_changes();
        json!({
            "description": "A sync message is raw deflate (RFC 1951, no zlib header) of its JSON. Deflate output isn't canonical: check that payload_hex inflates to message, not that you produce the same bytes.",
            "message": serde_json::to_value(&message).unwrap(),
            "payload_hex": hex(&message.encode().unwrap()),
        })
    });
    let payload = unhex(v["payload_hex"].as_str().unwrap());
    assert_eq!(protocol::inflate_json(&payload).unwrap(), v["message"]);
    let decoded = SyncMessage::decode(&payload).unwrap();
    assert_eq!(decoded, sample_changes());
    assert_eq!(SyncMessage::decode(&decoded.encode().unwrap()).unwrap(), decoded);
}

#[test]
fn sealed_body() {
    let v = vector("sealed_body.json", || {
        let library: [u8; 32] = std::array::from_fn(|i| 0x40 + i as u8);
        let (from, to) = (Uuid::parse_str(DEVICE).unwrap(), Address::Device(Uuid::parse_str(HUB).unwrap()));
        let header = Header { kind: Kind::Sync, epoch: 3, session: std::array::from_fn(|i| 0xC0 + i as u8), seq: 5 };
        let mut vector = Vector::default();
        vector.0.insert(from, 12);
        let message = SyncMessage::Pull { vector };
        let payload = message.encode().unwrap();
        let encoded = header.encode();
        json!({
            "description": "Kind-1 body: header || ChaCha20-Poly1305(payload) || tag. key = HKDF-SHA256(ikm = library key, salt = session, info = \"koona-sync frame v1\" || epoch(u32 BE) || from(16)); nonce = 0x00000000 || seq(u64 BE); AAD = header || from(16) || to(16) with to as addressed.",
            "library_key_hex": hex(&library),
            "epoch": header.epoch,
            "session_hex": hex(&header.session),
            "seq": header.seq,
            "from": from.to_string(),
            "to": address_name(to),
            "message": serde_json::to_value(&message).unwrap(),
            "payload_hex": hex(&payload),
            "session_key_hex": hex(&crypto::session_key(&library, header.epoch, &header.session, from)),
            "nonce_hex": hex(&crypto::frame_nonce(header.seq)),
            "aad_hex": hex(&crypto::frame_aad(&encoded, from, to)),
            "body_hex": hex(&crypto::seal_body(&library, &header, from, to, &payload)),
        })
    });
    let library = unhex_n::<32>(&v["library_key_hex"]);
    let (from, to) = (uuid(&v["from"]), address(&v["to"]));
    let header = Header {
        kind: Kind::Sync,
        epoch: v["epoch"].as_u64().unwrap() as u32,
        session: unhex_n(&v["session_hex"]),
        seq: v["seq"].as_u64().unwrap(),
    };
    let payload = unhex(v["payload_hex"].as_str().unwrap());
    let body = unhex(v["body_hex"].as_str().unwrap());
    assert_eq!(hex(&crypto::session_key(&library, header.epoch, &header.session, from)), v["session_key_hex"]);
    assert_eq!(hex(&crypto::frame_nonce(header.seq)), v["nonce_hex"]);
    assert_eq!(hex(&crypto::frame_aad(&header.encode(), from, to)), v["aad_hex"]);
    assert_eq!(crypto::seal_body(&library, &header, from, to, &payload), body);
    let (opened_header, opened) = crypto::open_body(&library, from, to, &body).unwrap();
    assert_eq!((opened_header, &opened), (header, &payload));
    assert_eq!(serde_json::to_value(SyncMessage::decode(&opened).unwrap()).unwrap(), v["message"]);
}

// RFC 7748 section 6.1: Alice is the device asking for the key, Bob the hub.
const ASKING_X25519: &str = "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a";
const HUB_X25519: &str = "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb";

#[allow(deprecated)]
fn fixed_ephemeral(private: &[u8]) -> Ephemeral {
    // `ring` takes no X25519 private key from outside; its test random source feeds one in.
    Ephemeral::generate(&ring::test::rand::FixedSliceRandom { bytes: private }).unwrap()
}

#[test]
fn pairing() {
    let v = vector("pairing.json", || {
        let (asking_id, hub_id) = (Uuid::parse_str(DEVICE).unwrap(), Uuid::parse_str(HUB).unwrap());
        let asking_pair = Ed25519KeyPair::from_seed_unchecked(&SEED).unwrap();
        let hub_pair = Ed25519KeyPair::from_seed_unchecked(&HUB_SEED).unwrap();
        let (asking_eph, hub_eph) = (fixed_ephemeral(&unhex(ASKING_X25519)), fixed_ephemeral(&unhex(HUB_X25519)));
        let asking = Party { device: asking_id, key: crypto::public_key(&asking_pair), eph: asking_eph.public() };
        let hub = Party { device: hub_id, key: crypto::public_key(&hub_pair), eph: hub_eph.public() };
        let shared = asking_eph.agree(&hub.eph).unwrap();
        let offer = crypto::offer_bytes(Exchange::Pair, &asking, hub_id);
        let offer_sig = crypto::sign(&asking_pair, &offer);
        let t = crypto::transcript(Exchange::Pair, &asking, &hub);
        let accept = crypto::accept_bytes(Exchange::Pair, &t);
        let accept_sig = crypto::sign(&hub_pair, &accept);
        let key = crypto::exchange_key(Exchange::Pair, &shared, &t);
        let library: [u8; 32] = std::array::from_fn(|i| 0x40 + i as u8);
        let epoch = 3;
        let sealed = crypto::seal_library_key(&key, epoch, asking_id, &library);

        let rekey_offer = crypto::offer_bytes(Exchange::Rekey, &asking, hub_id);
        let rekey_t = crypto::transcript(Exchange::Rekey, &asking, &hub);
        let rekey_key = crypto::exchange_key(Exchange::Rekey, &shared, &rekey_t);
        let rekey_sealed = crypto::seal_library_key(&rekey_key, epoch + 1, asking_id, &library);

        let messages = [
            PairMessage::PairOffer { device: asking_id, eph: B64(asking.eph), key: B64(asking.key), sig: B64(offer_sig) },
            PairMessage::PairAccept { eph: B64(hub.eph), sig: B64(accept_sig) },
            PairMessage::PairKey { epoch, sealed: B64(sealed) },
        ];
        let party = |p: &Party, seed: &[u8; 32], x: &str| json!({
            "device": p.device.to_string(),
            "ed25519_seed_hex": hex(seed),
            "ed25519_public_hex": hex(&p.key),
            "x25519_private_hex": x,
            "x25519_public_hex": hex(&p.eph),
        });
        json!({
            "description": "Pairing: X25519 keys are RFC 7748 section 6.1 (Alice = device asking, Bob = hub). transcript = SHA-256(label || asking.device || asking.ed25519 || asking.x25519 || hub.device || hub.ed25519 || hub.x25519); code = u32 BE of HKDF-SHA256(ikm = shared, salt = transcript, info = \"koona-sync pair code\", 4 bytes) mod 10^6; exchange key = HKDF(shared, transcript, \"koona-sync pair key\" or \"koona-sync rekey key\", 32 bytes); sealed = ChaCha20-Poly1305(key, nonce = 12 zero bytes, AAD = \"koona-sync library key v1\" || epoch(u32 BE) || asking.device(16)).",
            "asking": party(&asking, &SEED, ASKING_X25519),
            "hub": party(&hub, &HUB_SEED, HUB_X25519),
            "shared_hex": hex(&shared),
            "pair": {
                "offer_bytes_hex": hex(&offer),
                "offer_sig_hex": hex(&offer_sig),
                "transcript_hex": hex(&t),
                "accept_bytes_hex": hex(&accept),
                "accept_sig_hex": hex(&accept_sig),
                "code": format!("{:06}", crypto::pair_code(&shared, &t)),
                "key_hex": hex(&key),
                "epoch": epoch,
                "library_key_hex": hex(&library),
                "sealed_hex": hex(&sealed),
            },
            "rekey": {
                "offer_bytes_hex": hex(&rekey_offer),
                "transcript_hex": hex(&rekey_t),
                "key_hex": hex(&rekey_key),
                "epoch": epoch + 1,
                "sealed_hex": hex(&rekey_sealed),
            },
            "messages": messages.iter().map(|m| serde_json::to_value(m).unwrap()).collect::<Vec<_>>(),
        })
    });

    let load = |p: &Value| {
        let pair = Ed25519KeyPair::from_seed_unchecked(&unhex(p["ed25519_seed_hex"].as_str().unwrap())).unwrap();
        let eph = fixed_ephemeral(&unhex(p["x25519_private_hex"].as_str().unwrap()));
        let party = Party { device: uuid(&p["device"]), key: crypto::public_key(&pair), eph: eph.public() };
        assert_eq!(hex(&party.key), p["ed25519_public_hex"]);
        assert_eq!(hex(&party.eph), p["x25519_public_hex"]);
        (pair, eph, party)
    };
    let (asking_pair, asking_eph, asking) = load(&v["asking"]);
    let (hub_pair, hub_eph, hub) = load(&v["hub"]);
    let shared = asking_eph.agree(&hub.eph).unwrap();
    assert_eq!(hub_eph.agree(&asking.eph).unwrap(), shared);
    assert_eq!(hex(&shared), v["shared_hex"]);

    let p = &v["pair"];
    let offer = crypto::offer_bytes(Exchange::Pair, &asking, hub.device);
    assert_eq!(hex(&offer), p["offer_bytes_hex"]);
    assert_eq!(hex(&crypto::sign(&asking_pair, &offer)), p["offer_sig_hex"]);
    let t = crypto::transcript(Exchange::Pair, &asking, &hub);
    assert_eq!(hex(&t), p["transcript_hex"]);
    let accept = crypto::accept_bytes(Exchange::Pair, &t);
    assert_eq!(hex(&accept), p["accept_bytes_hex"]);
    assert_eq!(hex(&crypto::sign(&hub_pair, &accept)), p["accept_sig_hex"]);
    assert_eq!(format!("{:06}", crypto::pair_code(&shared, &t)), p["code"]);
    let key = crypto::exchange_key(Exchange::Pair, &shared, &t);
    assert_eq!(hex(&key), p["key_hex"]);
    let epoch = p["epoch"].as_u64().unwrap() as u32;
    let library = unhex_n::<32>(&p["library_key_hex"]);
    let sealed = unhex_n::<48>(&p["sealed_hex"]);
    assert_eq!(crypto::seal_library_key(&key, epoch, asking.device, &library), sealed);
    assert_eq!(crypto::open_library_key(&key, epoch, asking.device, &sealed), Ok(library));

    let r = &v["rekey"];
    assert_eq!(hex(&crypto::offer_bytes(Exchange::Rekey, &asking, hub.device)), r["offer_bytes_hex"]);
    let rekey_t = crypto::transcript(Exchange::Rekey, &asking, &hub);
    assert_eq!(hex(&rekey_t), r["transcript_hex"]);
    let rekey_key = crypto::exchange_key(Exchange::Rekey, &shared, &rekey_t);
    assert_eq!(hex(&rekey_key), r["key_hex"]);
    let rekey_epoch = r["epoch"].as_u64().unwrap() as u32;
    let rekey_sealed = unhex_n::<48>(&r["sealed_hex"]);
    assert_eq!(crypto::open_library_key(&rekey_key, rekey_epoch, asking.device, &rekey_sealed), Ok(library));

    for message in v["messages"].as_array().unwrap() {
        let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut encoder, message.to_string().as_bytes()).unwrap();
        let decoded = PairMessage::decode(&encoder.finish().unwrap()).unwrap();
        assert_eq!(&serde_json::to_value(&decoded).unwrap(), message);
        match decoded {
            PairMessage::PairOffer { sig, .. } => {
                assert_eq!(crypto::verify(&asking.key, &offer, &sig.0), Ok(()));
            }
            PairMessage::PairAccept { sig, .. } => {
                assert_eq!(crypto::verify(&hub.key, &accept, &sig.0), Ok(()));
            }
            PairMessage::PairKey { sealed: wire, .. } => assert_eq!(wire.0, sealed),
            _ => panic!("unexpected message"),
        }
    }
}
