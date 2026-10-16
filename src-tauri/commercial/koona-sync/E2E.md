<!-- Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`). -->

# Sync end to end

`src-tauri/tests/sync_e2e.rs` runs real app libraries (the test fixtures, migrated to schema 10 by
the app's open code) behind the app's `DbLibrary`, each driven by `koona_sync::net::client`, against
the relay (`koona-services`, `workers/sync`) running locally. It is `#[ignore]`d: it needs the relay.

## Run it

1. Start the relay with the test keys. The test serves the JWKS itself on `127.0.0.1:8799` and
   signs leases with a fixed test plan key, whose public key is the value below:

   ```sh
   cd koona-services/workers/sync
   npx --yes wrangler@4.150.0 dev --local --port 8787 --ip 127.0.0.1 \
     --persist-to /tmp/koona-sync-e2e \
     --var SUPABASE_JWKS_URL:http://127.0.0.1:8799/jwks.json \
     --var SUPABASE_ISSUER:http://127.0.0.1:8799/auth/v1 \
     --var PLAN_PUBLIC_KEY:fqDjvVLiB8nTsOumXAcE5m/KLY4WWhdSGLF0/EFg5BM= \
     --var BETA_EMAILS:
   ```

   Wrangler needs Node.js on `PATH`. Wait for `Ready on http://127.0.0.1:8787`.

2. Run the test:

   ```sh
   cd src-tauri
   KOONAPIN_E2E_RELAY=ws://127.0.0.1:8787/v1/sync \
     cargo test -p koonapin --test sync_e2e -- --ignored --nocapture
   ```

   `KOONAPIN_E2E_RELAY` defaults to that address; `KOONAPIN_E2E_JWKS_PORT` (default 8799) must match
   the relay's `SUPABASE_JWKS_URL`. Every run is a new account (a random `sub`), so runs don't need
   a fresh relay. The two tests run side by side, about 30 s in a debug build.

3. Stop Wrangler.

## What it checks

1. A turns sync on and becomes the hub. B and C, each with a library of its own (some addresses,
   collection and tag names the same as others'), connect, wait as pending, and pair: both screens
   show the same six digits, A approves. Every library ends with every address and name once.
2. Edits on each device (title, tags, move, trash, restore, purge, new collection, reorder) converge
   on all three: the synced state by uid is identical, the search finds a synced title, the
   sidebar's order is the same. Then feeds (NP-130): A and B follow the same address at once, C
   another; each device ends with one feed per address. C renames one and changes where its posts
   go while A leaves the other: all three agree.
3. A goes away; B and C sync without it; A, edited meanwhile, comes back and catches up.
4. A removes C: C stops with `Revoked` and forgets the key, B gets the new key, later edits reach B
   and not C.
5. A saves 10,000 bookmarks (one transaction); they reach B, then a new device D pairs and gets the
   whole library.

A second test, `the_hub_hands_over_and_the_account_starts_over`, runs at the same time on an
account of its own, with four devices A (the hub), B, C and D paired as in step 1:

6. Changing the hub (PROTOCOL.md 4.4). B asks to be the hub: B waits, A is asked naming B, A
   denies; B sees it denied and A is still everyone's hub. B asks again and A allows: the relay
   announces B as the hub to all, B's roster (every device's key) reaches A, C and D, and later
   edits converge on all four. B goes away; C's request then ends at once as unavailable.
7. Starting over (2.6), with the hub B gone. C sends `start_over` with a sign-in an hour old: the
   relay refuses it with `stale_sign_in` and nothing changes (no connection closed, same hub and
   epoch). C starts over with a fresh sign-in (`amr` otp, now): every connection gets 4005, C comes
   back as the hub at epoch + 1 with a new library key and a roster of itself alone; A and D come
   back pending and held (`Paused StartedOver`, «started over from C»), and no pairing offer
   reaches C. A, edited while held, joins again: it pairs with C (the same six digits, C approves),
   gets the new key, and its library merges back; A and C converge while D stays held and
   untouched. The old hub B comes back: held too, its library as it left it, still at the old
   epoch.

Throughout, the devices dial a small proxy in the test that passes everything on to the relay and
counts what they send, replaying the relay's account-wide message bucket (a burst of 20, 20/s). The
tests fail on any 4008 (only the 4003 of step 4 and the 4005s of step 7 are expected), any refused
message other than step 7's one `stale_sign_in`, or any dropped frame other than one sealed under
an epoch the receiver doesn't hold yet. Every message sent is listed in `koonapin-e2e-trace.txt`
(`koonapin-e2e-trace-hub.txt` for the second test) in the temporary folder, for a look after a
run. The libraries stay in `koonapin-e2e-<id>` there when a test fails.

Both tests sign their tokens with one key of the run, served by one JWKS server. Before any device
dials, the test makes one upgrade with a token and no lease, so the relay fetches the JWKS for the
run's new kid once; two first connections at once would otherwise race the relay's refetch and
one would get 4001 `token_kid`.
