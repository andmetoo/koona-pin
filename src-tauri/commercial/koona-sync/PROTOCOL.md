<!-- Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`). -->

# Koona Pin sync protocol, version 1

This document is the contract between Koona Pin devices and the sync relay, and between devices.
`proto = 1`. The Rust implementation is `src/protocol.rs` (shapes) and `src/crypto.rs` (keys);
`tests/vectors/*.json` are normative test vectors, checked by `tests/protocol_vectors.rs`.
Where this text and a vector disagree, the vector wins and this text is a bug.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Overview

- Every device dials out over WSS to the relay (a Cloudflare Worker). The Worker authenticates the
  connection and routes it to one Durable Object per account.
- The relay forwards end-to-end encrypted frames between the account's devices. It persists only
  the device directory (id, Ed25519 public key, name, status, last seen), the hub's device id and
  the epoch. It stores nothing for devices that are offline: a frame to nobody is dropped and the
  sender is told (`undeliverable`).
- One desktop device is the **hub**: the preferred sync peer, the one that approves pairing and
  rotates the library key. Any active device may make itself or another active device the hub.
- All active devices share one 32-byte **library key** per **epoch**. Sync bodies are sealed under
  keys derived from it, so the relay cannot read or forge them.

### 1.1 Conventions

- Integers in binary layouts are unsigned, big-endian. `||` is concatenation.
- A UUID in binary is its 16 bytes in RFC 4122 order; in JSON it is the lowercase hyphenated
  string.
- Times are milliseconds since the Unix epoch, as JSON integers.
- `base64` is RFC 4648 standard alphabet with `=` padding. All keys, nonces and signatures in JSON
  are base64.
- Labels such as `"koona-sync relay v1"` are their ASCII bytes, no terminator.
- HKDF is HKDF-SHA256 (RFC 5869). `HKDF(ikm, salt, info, L)` is extract with `salt` then expand
  with `info` to `L` bytes.
- AEAD is ChaCha20-Poly1305 (RFC 8439): 32-byte key, 12-byte nonce, 16-byte tag appended.
- Device keys are Ed25519 (RFC 8032). Exchange keys are X25519 (RFC 7748), ephemeral.

## 2. Device and relay

### 2.1 Connecting

```
GET /v1/sync  (WebSocket upgrade, TLS only)
Authorization: Bearer <Supabase access token (JWT)>
X-Koona-Lease: <base64 of the lease JSON {"payload": ..., "signature": ...}>
X-Koona-Proto: 1
```

The relay verifies before upgrading, or closes right after:

- The JWT: ES256 against the Supabase JWKS, not expired. `sub` names the account; `email` is
  read for the lease. Failure: close **4001**.
- The plan lease: its Ed25519 signature by the license service, not expired, issued for this
  account and with a plan that includes sync. The lease format belongs to the license service, not
  to this protocol. Failure: close **4002**.
- `X-Koona-Proto`: an integer. Below the oldest version the relay serves: close **4004**. Missing
  is treated as too old.

Browsers can't set headers on a WebSocket; v1 clients are native apps and MUST use headers.

### 2.2 Close codes

| Code | Meaning | Client reaction |
|------|---------|-----------------|
| 4001 | Authentication failed: bad JWT, bad or late `hello`, or a known device id with a different key | Refresh the token, then retry with backoff |
| 4002 | No valid lease / plan without sync | Stop; show the plan state |
| 4003 | This device is revoked | Stop for good; forget the library key |
| 4004 | Protocol too old | Stop; ask the person to update |
| 4005 | The account was started over (section 2.6), by another device or by this one | Reconnect after the shortest backoff; `welcome.started_over` says by whom |
| 4008 | Rate limited | Retry after backoff (at least 30 s) |
| 4009 | Replaced: the same device id connected again | Don't reconnect from this connection |

Standard codes (1000, 1001, 1002, 1009, 1011) keep their usual meaning. Rate limits are relay
policy, not part of this contract.

### 2.3 Control messages (text frames)

Every text frame is one JSON object of at most 64 KiB with a string field `t` naming the message.
Receivers MUST ignore fields they don't know. A device MUST ignore a control message whose `t` it
doesn't know; the relay answers one with `error{code: "bad_message"}`.

#### Handshake

1. Relay -> device, right after the upgrade:

   ```json
   {"t": "challenge", "nonce": "<base64, 32 random bytes>", "time": 1760400000000}
   ```

   `time` is the relay's clock. A device SHOULD compare it with its own (section 3.6).

2. Device -> relay, within 10 seconds (else close 4001):

   ```json
   {"t": "hello", "device": "<uuid>", "key": "<base64 Ed25519 public key>",
    "name": "Studio Mac", "app": "0.13.0", "sig": "<base64, 64 bytes>"}
   ```

   `sig` is Ed25519 by the device key over

   ```
   "koona-sync relay v1" || sub (UTF-8) || 0x00 || nonce (32) || device (16)
   ```

   where `sub` is the JWT's `sub`. The relay MUST reject a `sub` containing NUL. Vector:
   `relay_hello.json`.

   The relay verifies `sig` with `key` and then:
   - Unknown `device`: registers it with `key` and `name`. If the account has no active device,
     the new one is `active` and becomes the hub at epoch 0; otherwise it is `pending`.
   - Known `device` with a different `key`: close 4001. A device id's key never changes.
   - `revoked` device: close 4003.
   - Another open connection with the same `device`: that older one is closed with 4009.

3. Relay -> device:

   ```json
   {"t": "welcome", "status": "pending|active", "hub": "<uuid>", "epoch": 3,
    "devices": [{"id": "<uuid>", "name": "...", "key": "<base64>",
                 "status": "pending|active|revoked", "last_seen": 1760399000000}],
    "online": ["<uuid>"], "time": 1760400000000,
    "started_over": {"by": "<uuid>", "at": 1760399500000, "epoch": 4}}
   ```

   `status` is this device's own. `devices` is the whole directory, revoked devices included.
   `last_seen` is when that device last connected or disconnected. `online` lists devices with an
   open connection, this one included. `started_over` is present once the account has been
   started over (section 2.6) and describes the latest time.

A device sends nothing else before `welcome`.

#### Notices (relay -> devices)

The relay sends these to every connected device of the account, the cause included:

- `{"t": "presence", "device": "<uuid>", "online": true|false}`: a connection opened or closed.
- `{"t": "device", "device": {DeviceInfo}}`: a device was registered, approved, revoked or renamed.
  `DeviceInfo` is the shape in `welcome.devices`.
- `{"t": "account", "hub": "<uuid>", "epoch": 3}`: the hub or the epoch changed.

#### Requests (device -> relay)

| Message | Who may send | Effect |
|---------|--------------|--------|
| `{"t": "approve", "device": id}` | hub | A `pending` device becomes `active` |
| `{"t": "revoke", "device": id}` | hub | Any other device becomes `revoked`; its connection is closed with 4003 |
| `{"t": "set_hub", "device": id}` | hub | An `active` device becomes the hub. The hub sends it only after it allowed a `hub_request` (section 4.4) |
| `{"t": "rename", "device": id, "name": "..."}` | any active device | Renames a non-revoked device |
| `{"t": "epoch", "epoch": n}` | hub | Sets the epoch; `n` MUST be greater than the current one |
| `{"t": "start_over", "token": jwt}` | any active or pending device | Starts the account over from the sender (section 2.6) |

A request that succeeds is answered only by the notice it causes. A refused one is answered with
`{"t": "error", "code": "..."}`:

| Code | Meaning |
|------|---------|
| `bad_message` | Not JSON, unknown `t`, a missing field or a wrong type |
| `bad_frame` | A binary frame that is malformed, over the limit, or not allowed for a pending device |
| `forbidden` | The sender may not do this (not the hub; still pending) |
| `unknown_device` | The device is not on the account or is in the wrong state (e.g. approving an active device, revoking the hub, making a pending device the hub) |
| `bad_epoch` | `epoch` not greater than the current one |
| `stale_sign_in` | `start_over` without a sign-in by email code in the last 10 minutes |

Pending devices may send no requests. The hub cannot revoke itself; it hands over with `set_hub`
first.

### 2.4 Data frames (binary)

Device -> relay:

```
0x01 || to (16) || body
```

Relay -> device:

```
0x01 || from (16) || relay_ms (u64) || body
```

- `to` is a device id, or all zero (**the hub**, whichever device it is when the relay routes the
  frame), or all 0xFF (**every active device** online except the sender). Device ids are random
  UUIDs and never take either value.
- The relay writes `from` from the authenticated connection; a device can't choose it.
  `relay_ms` is the relay's clock when it forwards the frame.
- `body` is at most 1 MiB (1,048,576 bytes). The relay closes a connection that sends a frame of
  another type with 1003 and answers a malformed or oversized frame with `error{code: "bad_frame"}`.
- If no target is online (a direct `to` offline or not active, the hub offline), the relay sends
  `{"t": "undeliverable", "to": "<uuid>"}` with `to` exactly as addressed (the nil UUID for the
  hub, `ffffffff-ffff-ffff-ffff-ffffffffffff` for everyone). Nothing is ever queued. A broadcast
  that reaches nobody is dropped silently.
- An `active` device may send any body to any active device, and kind-2 bodies to pending
  devices. A `pending` device may send only bodies whose byte 1 (kind) is 2, and only to the hub
  (all zero or the hub's id). The relay reads bytes 0 and 1 of the body for this and nothing more;
  a body shorter than 2 bytes is a `bad_frame`. Frames are delivered to `active` devices only,
  except kind-2 frames from the hub to a pending device.
- Frames from one sender to one receiver arrive in the order they were sent.

Vector: `frames.json`.

### 2.5 Relay behaviour (clarifications)

What the relay (koona-services) does where the sections above leave room. None of it changes a
byte on the wire.

- **Header checks** run in this order: `X-Koona-Proto` (missing or not an integer: 4004), the
  token (4001), the lease (4002), the beta allowlist (4002 with reason `not_in_beta`). A client
  always sends `X-Koona-Proto: 1`.
- **Rate limits** are token buckets per account over every inbound message, text and binary,
  `hello` included: a burst of 20 then 20 messages/s, and a burst of 32 MiB then 32 MiB/min. Only
  the connection that crosses a limit is closed with 4008. A client paces what it sends below
  these so a first sync never trips 4008, and backs off at least 30 s after one. The message
  bucket is the account's, and a pairing or a reconnect alone is about 20 messages from two
  devices in a few milliseconds, so the reference client paces messages for the whole account:
  about 15 messages/s with a burst of 15, split evenly among the devices online (`welcome.online`
  and `presence`). Bytes it paces at 24 MiB/min per device: two large transfers at once are rare.
- **Device limit**: an account has at most 50 devices. Registering one more closes with 4008 and
  reason `device_limit`; no retry cures that, so a client stops and reports it.
- **Values**: device names are at most 128 UTF-16 code units; ids are lowercase hyphenated UUIDs;
  keys and signatures are strict base64 of exactly 32 and 64 bytes; `epoch` is a u32. The `name`
  of a known device's `hello` is ignored: only `rename` changes a name.
- **Order after `hello`**: `welcome`; then, for a newly registered device, the `device` notice to
  every connection (pending ones included); then `presence`. Registering the account's first
  device sends no `account` notice: `welcome` carries the hub and epoch. In `welcome.devices`
  the connecting device's `last_seen` is the value from before this connection.
- **Handshake strictness**: any message before `welcome` other than one `hello` closes with 4001;
  a second `hello` after `welcome` is answered with `error{code: "bad_message"}`.
- **Replacement** (4009): the new socket gets `presence{online: true}`; `presence{online: false}`
  is only sent when a device's last socket closes.
- **No-op requests** (`set_hub` to the current hub, `rename` to the same name) succeed and are
  broadcast like any other.
- **Keepalive**: a text `{"t": "ping"}` is answered with `{"t": "pong"}` by the relay's runtime;
  it keeps the connection open without waking the account's object.
- **Routing**: only the hub's kind-2 frames reach a pending device; any other frame to a pending
  device (from another device, or kind 1) is `undeliverable`. Pairing therefore needs the hub
  online. A frame a device addresses to itself is echoed back to it. The hub alias while there is
  no hub is `undeliverable`. A text frame over 64 KiB is answered with `bad_message`.

### 2.6 Starting over

When the hub is lost (sold, broken, stolen) nobody can add or remove devices. Any active or
pending device may then start the account over, proving it holds the account's email:

1. The device has the person sign in again with a code from the email (Supabase `verify`, type
   `email`) and sends `{"t": "start_over", "token": "<the new access token>"}`.
2. The relay verifies `token` as in section 2.1, checks that its `sub` is the connection's, and
   that its `amr` claim lists a method `otp` (or `email`, `magiclink`) whose `timestamp` is at most
   600 s old. Otherwise: `error{code: "stale_sign_in"}` and nothing changes. A revoked device can't
   send it (it never gets past `hello`).
3. The relay removes every other `active` and `pending` device from the directory (revoked ones
   stay revoked), makes the sender `active` and the hub, sets the epoch to the current one + 1, and
   stores `started_over = {by: sender, at: now, epoch}`.
4. It closes every connection of the account, the sender's included, with **4005** and reason
   `started_over`.
5. The sender generates a new random library key for the new epoch before it reconnects; its
   `welcome` then lists it alone as the active hub. Each other device reconnects too (4005 alone
   doesn't say who started over): its id is unknown again, so it registers as `pending`. A device
   whose `welcome` has `status: "pending"` and a `started_over.epoch` greater than the epoch whose
   key it holds shows that sync was started over from `started_over.by` and sends no pairing offer
   until the person chooses «Join»; then it pairs with the new hub (section 4.2), keeping its
   library, and the first sync merges it back. Meanwhile the new hub lists it as pending. A device
   that was offline during the start over ends up the same way when it next connects.

The new hub's key is pinned by the pairing, as for any new device. Nothing about devices that
don't reconnect is kept beyond the revoked entries.

### 2.7 Asking about the account

Before a device turns sync on, it asks whether the account already has a hub, so the person reads
"this computer becomes the main one" or "join <name>" — without registering the device:

```
GET /v1/account
Authorization, X-Koona-Lease, X-Koona-Proto: as in section 2.1
```

Checked like a connection (same order and conditions); a failure answers HTTP 426 for 4004, 401
for 4001 and 403 for 4002, with a JSON body `{"code": 4001, "reason": "..."}`; a rate-limited
request gets 429 with code 4008, and a failure on the relay's side 500 or 503 (code 1011 or 1013). Success: HTTP 200
with

```json
{"hub": {"id": "<uuid>", "name": "Home iMac"}}
```

or `{"hub": null}` when the account has no active device. Nothing is stored, and the request counts
against the account's message bucket like a control message.

## 3. Device and device

### 3.1 Body

```
ver (1) = 1 || kind (1) || epoch (u32) || session (16) || seq (u64) || payload
```

The first 30 bytes are the **header**.

- `ver`: 1. A receiver that meets another value MUST NOT parse further (`update_needed`).
- `kind`: 1 = sync (payload sealed, section 3.2), 2 = pairing (payload not sealed, section 4).
  An unknown kind is `update_needed`.
- `epoch`: the library key generation. For kind 2, the sender's current epoch, or 0.
- `session`: 16 random bytes a sender picks for each run (process start, or reconnect). A sender
  MUST NOT reuse a session with the same library key and epoch after losing its `seq` counter.
- `seq`: 0 for the first body of a session, then +1 per body (both kinds share the counter).

Receivers keep the last accepted `seq` per `(from, session)` and MUST drop a body whose `seq` is
at or below it. The check is made only after the body authenticated, so a forger can't push it
ahead. The window MAY be kept in memory only: a replay after the receiver restarts re-applies
changes it already holds, which changes nothing.

### 3.2 Sealing (kind 1)

```
session_key = HKDF(ikm = library key, salt = session,
                   info = "koona-sync frame v1" || epoch (u32) || from (16), L = 32)
nonce       = 0x00000000 || seq (u64)
AAD         = header (30) || from (16) || to (16)
payload     = ChaCha20-Poly1305-Seal(session_key, nonce, AAD, plaintext)   (ciphertext || tag)
```

- `from` is the sender's device id. `to` is the 16 bytes exactly as the sender addressed the frame:
  a device id or all 0xFF. Kind-1 bodies MUST NOT be addressed to the hub alias (all zero); a
  device learns the hub's id from `welcome`/`account`.
- The delivered frame doesn't carry `to`, so a receiver tries `to = its own id`, then `to = all
  0xFF`. A body that opens under neither is dropped.
- The receiver picks the library key by the header's `epoch`. A device keeps the key of the
  previous epoch until every frame in flight has arrived (a minute is plenty), then deletes it.
- Any change to the header, the ciphertext, the tag, `from` or `to` fails the tag.

Vector: `sealed_body.json`.

### 3.3 Messages

The plaintext of a kind-1 body (and the payload of a kind-2 body) is raw DEFLATE (RFC 1951, no zlib
or gzip wrapper) of one UTF-8 JSON object with a string field `t`.

- The deflated bytes are at most 900 KiB (921,600), leaving room for the header and tag.
- A receiver MUST stop inflating past 16 MiB and drop the body.
- Deflate output is not canonical; implementations compare what the bytes inflate to.

Kind-1 messages:

| `t` | Fields | Meaning |
|-----|--------|---------|
| `hello` | `proto` (int), `schema` (int), `vector` (Vector), `hub` (bool), `platform` (string), `app` (string) | First message both ways in a session. `schema` is the library schema version; `hub` says whether the sender is the hub; `platform` is `macos`, `windows`, `linux` or another lowercase word and `app` the sender's version, at most 32 characters each, shown to the person and not otherwise trusted. They travel sealed, so the relay never learns them |
| `pull` | `vector` | "Send me every change not covered by this vector" |
| `changes` | `groups` ([Group]), `covers` (Vector), `last` (bool) | One batch of an answer, or an unasked push |
| `ack` | `vector` | The receiver's vector after it applied a `last` batch |
| `roster` | `hub` (uuid), `devices` ([{`id`, `key`}]) | Hub -> devices: the active devices' Ed25519 keys (section 4.4) |
| `hub_request` | none | Active device -> hub: "make me the main computer" (section 4.4) |
| `hub_answer` | `allow` (bool) | Hub -> the asking device |
| `error` | `code` | See below |

`Group` and `Vector` are the JSON shapes of `src/model.rs`: a Vector is an object from replica
UUID to the highest counter held; a Group is `{entity, uid, fields?: [{field, value, clock}],
gone?: {clock, merged_into}}` with `clock = {hlc, replica, counter}`. Vector: `changes.json`.

**Batches.** An answer is one or more `changes` messages in order; every batch carries the same
`covers` and only the final one has `last: true`. The receiver applies each batch as it arrives
but merges `covers` into its vector only after applying the `last` batch, then sends `ack`. A
receiver that loses the connection mid-answer keeps what it applied and pulls again; applying a
change twice changes nothing.

**Unknown content.** A receiver MUST treat any of these as `update_needed`: a `ver` or `kind` it
doesn't know; a `t` it doesn't know; a field it doesn't know on a message, a Group, a field change,
a clock or a `gone`; an `entity` it doesn't know; a synced field name it doesn't have for that entity
(for `link`, a field name that isn't a UUID). It then sends `error{code: "update_needed"}`, pauses
sync with that peer, does not advance its vector, and asks the person to update. Silently dropping
the unknown part would let `covers` mark a change as held that was never stored. A wrong type or a
missing field is a broken peer, not a newer one: the body is dropped.

`error` codes: `update_needed`; `clock_skew` (section 3.6); `rejected` and `bad_signature` (pairing);
`busy` (the hub is already answering another `hub_request`).
A receiver MUST accept an `error` with a code it doesn't know (treat it as a generic failure), so
codes can grow without forcing updates.

**Versions.** `hello.proto` is the highest protocol version the sender speaks; v1 devices only
speak 1. If a peer's `schema` is greater than its own, a device pauses with that peer and reports
`update_needed`; it doesn't send `error` for it, since the peer is fine.

### 3.4 A session

1. After `welcome`, an active device sends `hello` to the hub (if it isn't the hub) and to any
   active device it wants to sync with directly when the hub is offline.
2. Each side that receives `hello` answers with its own `hello` (once per session), then `pull`
   with its vector.
3. Each side answers a `pull` with `changes` batches of everything beyond the given vector.
4. After a local change, a device pushes it as an unasked `changes` with `last: true`. It
   addresses the hub, or everyone (all 0xFF) when the hub is offline.

`covers` MUST only name counters the receiver holds once it has applied the answer: for an answer
to `pull`, the sender's vector at the time it read the changes; for a push, `{}` unless the
receiver's last `ack` plus the pushed changes already cover the sender's vector. A receiver that
sees a gap pulls. A device MAY instead push to each sync peer directly, a delta since what that
peer is known to hold (its `hello`, `pull`, `ack` or a merged `covers`), with that delta's exact
`covers`; the reference session does so.
5. `presence` of a device coming online triggers a `hello` from the hub to it.

### 3.5 Clocks

Changes are ordered by hybrid logical clocks (`model::Hlc`), seeded from the wall clock.

### 3.6 Clock skew

Every delivered frame carries `relay_ms`. If `|relay_ms - local clock| > 5 minutes` (300,000 ms),
the device's clock is wrong: its new changes would win or lose conflicts for the wrong reason. It
MUST stop applying and producing changes, answer `hello` and `pull` with `error{code:
"clock_skew"}`, and ask the person to fix the clock. It rechecks on every frame and resumes by
itself. `challenge.time` and `welcome.time` give the same check at connect.

## 4. Pairing and rekeying (kind 2)

Kind-2 payloads are deflated JSON as in section 3.3, **not sealed**: their public values are
authenticated by Ed25519 signatures and by the code the person compares; the only secret, the
library key, travels sealed inside `pair_key`/`rekey_key`. Unknown `t` or fields are
`update_needed`. Vector: `pairing.json`.

In both exchanges the **asking** device is the one that lacks the library key and the **hub** is
the one that has it. Each side generates a fresh X25519 key for each attempt and discards it after.

### 4.1 Values

With `A` the asking device and `H` the hub, each with `device` (16 bytes), `ed` (Ed25519 public, 32)
and `eph` (X25519 public, 32), and `label` set by the exchange:

| | Pairing | Rekeying |
|-|---------|----------|
| `offer_label` | `"koona-sync pair offer v1"` | `"koona-sync rekey offer v1"` |
| `transcript_label` | `"koona-sync pair v1"` | `"koona-sync rekey v1"` |
| `accept_label` | `"koona-sync pair accept v1"` | `"koona-sync rekey accept v1"` |
| `key_info` | `"koona-sync pair key"` | `"koona-sync rekey key"` |

```
offer_bytes  = offer_label || A.device || H.device || A.eph || A.ed
transcript   = SHA-256(transcript_label || A.device || A.ed || A.eph || H.device || H.ed || H.eph)
accept_bytes = accept_label || transcript
shared       = X25519(own eph private, peer eph public)          (all-zero result: abort)
code         = u32(HKDF(ikm = shared, salt = transcript, info = "koona-sync pair code", L = 4)) mod 1,000,000
exchange_key = HKDF(ikm = shared, salt = transcript, info = key_info, L = 32)
sealed       = ChaCha20-Poly1305-Seal(exchange_key, nonce = 12 zero bytes,
                 AAD = "koona-sync library key v1" || epoch (u32) || A.device, library key)   (48 bytes)
```

The code is shown as six digits with leading zeros. The zero nonce is safe because each
`exchange_key` seals exactly one message.

### 4.2 Pairing a new device

1. The new device connects, gets `welcome{status: "pending"}` and the hub's id and key from it, and
   shows "Confirm on <hub name>".
2. A -> hub: `{"t": "pair_offer", "device": A.device, "eph": A.eph, "key": A.ed, "sig": Ed25519_A(offer_bytes)}`.
3. The hub checks that `device` equals the frame's `from`, that the directory lists it as `pending`
   with key `key`, and `sig`. It generates `H.eph`, computes `transcript`, and answers
   H -> A: `{"t": "pair_accept", "eph": H.eph, "sig": Ed25519_H(accept_bytes)}`.
4. A checks `sig` against the hub key from `welcome`. Both compute `shared` and the code and show
   it, the hub with the new device's name and Approve / Reject.
5. The person compares the digits. On Approve, H -> A:
   `{"t": "pair_key", "epoch": <current epoch>, "sealed": "<base64, 48 bytes>"}`; then the hub
   sends `approve{device}` to the relay and a `roster` (section 4.4). On Reject or a mismatch, H ->
   A: `{"t": "error", "code": "rejected"}`, and the hub sends `revoke{device}`.
6. A opens `sealed` and stores the library key with its epoch. It pins the hub's key from the
   transcript. Once the relay reports it `active` it starts a sync session (section 3.4).

A relay that substitutes either `eph` or either Ed25519 key makes the two transcripts differ, so
the two screens show different digits (with probability 1 - 10^-6). The person MUST be told to
compare the digits, not just press Approve.

A pending device sends at most one offer at a time; the hub handles one pairing at a time and
answers others with `error{code: "rejected"}`. A pairing that isn't approved within 5 minutes is
abandoned by both sides.

### 4.3 Rotating the library key

After the hub revokes a device it rotates the key, so the revoked device can't read what follows:

1. The hub sends `revoke{device}`, generates a new random library key, and sends `epoch{e + 1}`.
   The relay announces `account{hub, epoch: e + 1}` to everyone.
2. Every active device holding only an older key (now, or when it next connects and reads
   `welcome.epoch`) asks the hub:
   A -> hub: `{"t": "rekey_offer", "device": A.device, "eph": A.eph, "sig": Ed25519_A(offer_bytes)}`
   (rekey labels; `A.ed` in `offer_bytes` is A's registered key, not sent again).
3. The hub verifies `sig` with A's key as the hub pinned it (from pairing or its own roster) and
   answers `{"t": "rekey_accept", "eph": H.eph, "sig": Ed25519_H(accept_bytes)}`, then
   `{"t": "rekey_key", "epoch": e + 1, "sealed": ...}` with no code and no confirmation.
4. A verifies `sig` against the hub key it pinned (from its pairing or a `roster`) and opens
   `sealed`.

A device that is not active, or whose key the hub doesn't hold, gets `error{code: "bad_signature"}`.
Kind-2 bodies of a rekey carry the sender's current (old) epoch in the header.

The same flow serves a device that was offline during an earlier rotation. If the hub is offline,
devices keep syncing under the old epoch among themselves; frames under an epoch a receiver doesn't
hold are dropped.

### 4.4 Roster and hub changes

The relay's directory is advisory: a device MUST NOT trust a key just because the relay lists it.
The hub sends `roster{hub, devices: [{id, key}]}` (kind 1, so sealed under the library key) to all
active devices after every approve, revoke or rotation, and in answer to `hello`. A device pins the
keys in the latest roster it received from the hub. A device accepts `set_hub` (seen as `account`)
toward a device in its pinned roster, and accepts `rekey_accept` only when signed by the current
hub's pinned key. A device that becomes hub through `set_hub` sends a fresh roster.

**Changing the hub.** Only the hub hands over, and only when the person on it allows it:

1. The device that wants to be the hub sends kind-1 `hub_request` to the hub's device id (not the
   all-zero alias: kind-1 bodies are sealed to their receiver, section 3.2). If the relay answers
   `undeliverable`, the hub is offline: the person is told, and may start over
   (section 2.6) instead.
2. The hub asks its person «Make <name> the main computer?». On Allow it sends `set_hub{device}` to
   the relay and then `hub_answer{allow: true}`; on Deny, `hub_answer{allow: false}`. It answers one
   request at a time; another gets `error{code: "busy"}`.
3. The asking device gives up after 5 minutes without an answer. It becomes the hub when the relay
   announces `account{hub: <it>}`, and then sends its roster.

## 5. Limits and constants

| Name | Value |
|------|-------|
| `proto` | 1 |
| Body version | 1 |
| Body, max | 1 MiB (1,048,576 bytes) |
| Deflated payload, max | 900 KiB (921,600 bytes) |
| Inflated JSON, max | 16 MiB |
| Control message, max | 64 KiB |
| `hello` deadline after `challenge` | 10 s |
| Clock skew threshold | 5 min |
| Pairing timeout | 5 min |
| Hub request timeout | 5 min |
| Start over: sign-in age, max | 10 min |

## 6. Test vectors

All in `tests/vectors/`, hex unless the name says base64. Fixed keys: device Ed25519 seed `11` x32,
hub Ed25519 seed `22` x32, X25519 keys from RFC 7748 section 6.1.

| File | Covers | Relay needs it |
|------|--------|----------------|
| `relay_hello.json` | `challenge`/`hello` JSON, signing bytes, signature | yes |
| `frames.json` | Outgoing and delivered frame layouts, body headers | yes |
| `control.json` | Every other control message as JSON | yes |
| `sealed_body.json` | Session key, nonce, AAD and a sealed `pull` body | no |
| `changes.json` | A `changes` message and a deflated encoding of it | no |
| `pairing.json` | Pairing and rekey: transcript, signatures, code, exchange keys, sealed library key, messages | no |

`KOONA_WRITE_VECTORS=1 cargo test -p koona-sync --test protocol_vectors` regenerates them; any diff
is a protocol change and needs a new `proto`.
