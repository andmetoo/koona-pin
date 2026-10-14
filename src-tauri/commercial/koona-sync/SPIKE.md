<!-- Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`). -->

# Spike S1: the engine

The riskiest part of sync v1 (the change log, delta, apply and uniqueness merges) built and tested on its own, with no Tauri and no network.

## Result

**It converges.** `tests/convergence.rs` runs 3 and 4 in-memory replicas through random steps:

- edits: add a bookmark (6 addresses, so they collide), change its address, title, notes or favourite, move it, create, rename or delete a collection (3 names), tag and untag (4 tags), trash, restore, purge;
- syncs between random pairs with chunks duplicated, swapped or cut off, and sometimes an edit on the sender between two chunks;
- random wall-clock jumps, backwards too, and equal milliseconds on different replicas.

Then every pair syncs cleanly until a full round changes nothing. Every library must then hold the same records, the same clock on every field, the same tags with their clocks, the same tombstones and the same vector. No apply may fail (a UNIQUE violation would make it fail). After every step there may be no dangling link, no clock of a record that is gone, and no purged record that came back.

- The default `cargo test -p koona-sync` runs 300 cases per test: 21 s in debug.
- 10 000 cases per test in release (`PROPTEST_CASES=10000`) pass, with and without the address and name edits.
- In a sample of 300 cases, 44% ended with merged records and 38% with purges.

The property test found two divergences, both fixed (see design change 2). `tests/engine.rs` covers the plain cases by hand. `tests/schema.sql` is identical to a schema 9 library the app's own tests made: the same 30 objects in the same order.

## Numbers at 100 000 bookmarks

`cargo test -p koona-sync --release --test measure -- --ignored --nocapture`. The test library has 100 000 bookmarks, 30 collections, 300 tags and 200 000 tag links. Its text is longer than the app's own test library: 224 MB here, against about 110 MB for 100 000 bookmarks in `library.rs`. The settings are as in `library::configure` (WAL, FULL, 64 MiB cache), on an M-series Mac.

| | |
|---|---|
| `sync_clock` + its index after the baseline | 14.0 MB, 300 000 clocks: **6.3%** of this file, about 13% of a 110 MB library |
| after 20 000 edits of two fields and 10 000 new tags | 15.9 MB, 350 000 clocks (6.9%) |
| on the receiver of the snapshot | 17.1 MB (7.5%) |
| baseline (stamping everything) | 0.11 s |
| the full snapshot: 182 399 groups in 249 chunks of 1 MB | made in 0.66 s; 249 MB of JSON, 18.4 MB deflated |
| applying it to an empty library | **35 s**; without the app's search and sort triggers, 12 s; writing the same rows directly without them, 6.3 s |
| one edit: delta and apply | 0.06 ms and 0.5 ms |

The target of at most 30% is met with room to spare. The snapshot is the slow part, and most of that time is the app's triggers (see open problems).

## Design changes and why

1. **One clock per record until a field is edited.** `sync_clock` row `field = -1` is the record's clock as it was created; a field without its own row has it. Inserts and the baseline write one row; an edit writes a row for that field. One row per field would be about 1.5 million rows at 100 000 bookmarks; with this it is 300 000 to 350 000. On the wire nothing changes: every field still goes with its clock.
2. **A merge's effects are changes of the replica that makes them.** These all get a new clock of the merging replica, never the clock they came with:
   - what the survivor takes from the merged record (a later field, a tag it lacks, the bookmarks of a collection);
   - a change that arrives for a merged uid and is redirected to the survivor;
   - a bookmark's reference to a merged collection;
   - the fields an existing record keeps when it takes the uid of an arriving survivor.

   The design copied the clocks instead. The test found why that fails: a replica that purged the merged record, or never had it, or saw its merge later overruled by a purge, already covers those clocks in its vector, so it is never sent the survivor's new values. With new clocks a record only ever carries clocks of its own history, every merge is an ordinary edit, and convergence follows from LWW. The cost: an edit made elsewhere at the same time as a merge can lose to the merge.
3. **Tombstones: a purge beats a merge, otherwise the later clock wins.** A purge is final. Change 2 makes any deterministic rule safe here, so nothing else (such as purging every record of a merged group) was needed.
4. **`covers` only at the last chunk.** This was one of the fallbacks in the task; here it is the design. Every chunk before the last carries `covers = since`. The receiver merges `covers` only when every chunk of the session was applied in order and nothing was deferred. Duplicates may be applied again, and a chunk that arrives early is dropped (`tests/common::Session`). A broken session goes on from a `Cursor`, which holds the sender's vector at the start and the last key sent, with the same `since`. Partial `covers` per origin would have to claim counters whose newer clocks had not been sent yet.
5. **Delta order:** collections, tags, bookmarks, links, and within each entity the records before the tombstones. An arriving survivor is then created before the tombstone that merges into it. With the opposite order, a merged record would be renamed to its survivor and every one of its fields restamped, so the survivor's own values would lose.
6. **Apply defers instead of failing.** A record that arrives without every field, a reference to an unknown record, or a merge into a survivor not here yet is left out and counted in `Applied::deferred`. The session then does not merge `covers`, so the change comes again. The tests never stalled on a deferral.
7. **Counter and clock live in the library.** Each trigger writes `sync_vector[self]` and `sync_meta.hlc`. `np_hlc(base)` and `np_sync_counter(base)` take the stored value as their floor. Two connections (the app and `koonapin-mcp`) or a restart can then never give the same counter twice. A `covers` that holds this replica's own counter beyond its own (a restored copy) moves the counter on.
8. **API additions:** `register` (on every connection: the triggers call the functions even when sync is off), `set_capture`, `set_wall_clock` (tests), `merge_vector`, `Delta`/`Chunk`/`Cursor`, `delta_all`, `Applied::deferred`, and `SCHEMA_10`.
9. **The engine needs `np_domain(url)` from the app**, besides `np_url_key`, to fill `domain` when it writes an address. The tests stub both.

Neither fallback the task named (merges only at the hub, the vector only at the last chunk) was needed as a fallback. Change 4 is the second one, adopted as the design.

## Open problems

- **Wire size.** The frozen shape repeats the clock, with its replica uuid, on every field: 1.4 KB of JSON per bookmark and 249 MB for the snapshot, 13 times smaller deflated. Deflating frames is mandatory. A later protocol version could give each group a table of clocks.
- **Snapshot apply time** is mostly the app's triggers. Each tag link rewrites the bookmark's FTS row (`bookmarks_search_tag_link`), and the sort triggers run on every insert. For a snapshot, task A should drop the search triggers and run `db::rebuild_search` at the end, or create a bookmark's tags together with it. The engine itself could also batch: it spends about 6 s over plain writes.
- **App writes to check in task A.**
  - `db.rs` sets tags by deleting all of a bookmark's links and inserting them again: an untag and a tag for each kept pair, two counters each.
  - `dedupe.rs` merges duplicates by deleting them: that is captured as a purge, and it should write a tombstone with `merged_into`.
  - Nothing captures an `UPDATE` of `bookmark_tags`.
  - The `source` CHECK refuses values a newer replica may send, and a refused value fails the whole batch every time.
  - A restore must turn capture off and run `baseline` after. It should probably also take a new replica id, since its counters may already be known elsewhere.
- **Semantics a person may notice:**
  - Merges count as edits at the time of the merge (design change 2).
  - When two records merge after an address or name edit, the survivor may keep values from both, and a later merge tombstone may name a different survivor. Both cases converge, and the test exercises them.
  - A collection purged on one device while merged into a same-named one on another: the purge wins for that uid, and the bookmarks that were moved stay in the survivor.
- **No garbage collection.** Tombstones, `sync_origins` and the clocks of records keep growing. With per-record clocks the growth is small, but nothing is ever removed.
- **Not covered by the tests.** Two replicas that share history through a copied library file are not tested: same replica id, or a restore from an older backup. Neither is more than one connection writing during an apply.
