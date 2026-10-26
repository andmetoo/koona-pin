//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! Applying changes from another replica: field by field, the later clock wins and its clock is
//! kept with the value. One savepoint per batch; collections first, then tags, bookmarks, the
//! tags of bookmarks and feeds, each with its records before its tombstones, so whatever a change
//! refers to is already there.
//!
//! A change the receiver cannot place yet (a record it does not have and that arrives without
//! every field, a reference to a record it has never seen) is left out and counted in
//! [`Applied::deferred`]: the session must not merge `covers` then, and the change comes again.

use crate::capture::{self, Applying};
use crate::model::{Clock, Entity, FieldChange, Gone, Group};
use crate::store::{
    self, Origins, Stored, Table, BOOKMARKS, COLLECTION, COLLECTIONS, FAVORITE, FEEDS, LINK, PARENT, PROGRESS, TAGS,
    UNIQUE,
};
use crate::Result;
use rusqlite::types::Value;
use rusqlite::{params, Connection};
use serde_json::Value as Json;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

/// What a batch changed, for the interface.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Applied {
    /// Local ids of the bookmarks written, created or removed.
    pub bookmark_ids: Vec<i64>,
    /// Collections, tags or feeds changed: the sidebar reads them again.
    pub structure_changed: bool,
    /// Changes left for a later delivery; while any are, the batch's `covers` must not be merged.
    pub deferred: usize,
    /// A feed was followed, changed or left (NP-130).
    pub feeds_changed: bool,
    /// The uids of feeds no longer here: unfollowed, merged into another one with the same
    /// address, or renamed to the uid of an arriving one. Their posts on this device go.
    pub feeds_gone: Vec<Uuid>,
}

/// Applies a batch of groups in one savepoint, with capture off.
pub fn apply(conn: &Connection, groups: &[Group]) -> Result<Applied> {
    let _applying = Applying::new(conn)?;
    conn.execute_batch("SAVEPOINT koona_sync_apply")?;
    let result = run(conn, groups);
    match result {
        Ok(applied) => {
            conn.execute_batch("RELEASE koona_sync_apply")?;
            Ok(applied)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK TO koona_sync_apply; RELEASE koona_sync_apply");
            Err(e)
        }
    }
}

fn run(conn: &Connection, groups: &[Group]) -> Result<Applied> {
    let mut ctx = Ctx::new(conn)?;
    // Every local clock from now on is later than anything in the batch.
    let latest = groups
        .iter()
        .flat_map(|g| g.fields.iter().map(|f| f.clock.hlc.0).chain(g.gone.iter().map(|g| g.clock.hlc.0)))
        .max();
    if let Some(latest) = latest {
        capture::observe(conn, latest)?;
    }
    for entity in [Entity::Collection, Entity::Tag, Entity::Bookmark] {
        ctx.records(groups, entity)?;
    }
    for g in groups.iter().filter(|g| g.entity == Entity::Link) {
        ctx.links(g.uid, &g.fields)?;
    }
    // Feeds refer to nothing, so they come last (NP-130).
    ctx.records(groups, Entity::Feed)?;
    capture::persist(conn)?;
    Ok(ctx.finish())
}

/// Where a uid leads in this library.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Found {
    /// A record here, with the uid it has (another one when the first was merged into it).
    Live(i64, Uuid),
    /// Purged, or merged into a record that was purged.
    Gone,
    /// Never seen here; the uid is the end of its chain of merges.
    Unknown(Uuid),
}

/// A value from the wire as the library stores it.
pub(crate) enum Incoming {
    Value(Value),
    /// Refers to a record that was merged into another one here.
    Redirected(Value),
    /// Refers to a record not here yet.
    Defer,
    /// A collection's parent not here yet, while the batch's collections are still being
    /// written: it may come later in the batch, so it is tried again after them (schema 15).
    Later,
    /// Not a value this field takes; ignored.
    Invalid,
}

pub(crate) struct Ctx<'c> {
    pub conn: &'c Connection,
    pub origins: Origins,
    pub now: String,
    pub bookmarks: BTreeSet<i64>,
    pub structure: bool,
    pub deferred: usize,
    pub feeds: bool,
    pub feeds_gone: Vec<Uuid>,
    /// This replica in `sync_origins`.
    pub own: i64,
    /// Every collection of the batch is written: a parent still unknown waits for a later
    /// delivery ([`Incoming::Defer`]) instead of [`Incoming::Later`].
    pub parents_final: bool,
}

impl<'c> Ctx<'c> {
    fn new(conn: &'c Connection) -> Result<Ctx<'c>> {
        let own = capture::origin_of_self(conn)?;
        let now: String = conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |r| r.get(0))?;
        Ok(Ctx {
            conn,
            origins: Origins::load(conn)?,
            now,
            bookmarks: BTreeSet::new(),
            structure: false,
            deferred: 0,
            feeds: false,
            feeds_gone: Vec::new(),
            own,
            parents_final: true,
        })
    }

    fn finish(self) -> Applied {
        let feeds_gone: BTreeSet<Uuid> = self.feeds_gone.into_iter().collect();
        Applied {
            bookmark_ids: self.bookmarks.into_iter().collect(),
            structure_changed: self.structure,
            deferred: self.deferred,
            feeds_changed: self.feeds,
            feeds_gone: feeds_gone.into_iter().collect(),
        }
    }

    pub fn touched(&mut self, t: &Table, id: i64) {
        if t.code == BOOKMARKS.code {
            self.bookmarks.insert(id);
        } else {
            self.structure = true;
            self.feeds |= t.code == FEEDS.code;
        }
    }

    /// The records of one entity in a batch, then its tombstones.
    fn records(&mut self, groups: &[Group], entity: Entity) -> Result<()> {
        let t = Table::of(entity).expect("a record entity");
        let nested = t.code == COLLECTIONS.code;
        // A parent may come after its child in a batch (schema 15): the parents are resolved
        // once every collection of the batch is here.
        self.parents_final = !nested;
        for g in groups.iter().filter(|g| g.entity == entity && !g.fields.is_empty()) {
            self.record(t, g.uid, &g.fields)?;
        }
        self.parents_final = true;
        if nested {
            self.parents(groups)?;
        }
        let gone: Vec<&Group> = groups.iter().filter(|g| g.entity == entity && g.gone.is_some()).collect();
        for g in &gone {
            self.store_gone(t, g.uid, g.gone.as_ref().expect("filtered"))?;
        }
        // Settled after every tombstone of the batch is in, so a chain of merges resolves whole.
        for g in &gone {
            self.settle(t, g.uid)?;
        }
        if nested && groups.iter().any(|g| g.entity == entity) {
            self.untangle()?;
        }
        Ok(())
    }

    /// The parents of the batch's collections, now that each of them is here: a parent still
    /// unknown leaves its collection where it is (a new one at the top level) and comes again.
    fn parents(&mut self, groups: &[Group]) -> Result<()> {
        let name = COLLECTIONS.fields[PARENT];
        for g in groups.iter().filter(|g| g.entity == Entity::Collection) {
            let changes: Vec<FieldChange> = g.fields.iter().filter(|f| f.field == name).cloned().collect();
            if changes.is_empty() {
                continue;
            }
            if let Found::Live(id, here) = self.resolve(&COLLECTIONS, g.uid)? {
                self.update(&COLLECTIONS, id, here == g.uid, &changes)?;
            }
        }
        Ok(())
    }

    /// Two devices that each moved a collection into the other make a loop (schema 15). The
    /// collection in it whose parent was set the longest ago goes to the top level, as a change
    /// of this replica, so the repair spreads; every replica that meets the same loop picks the
    /// same one.
    fn untangle(&mut self) -> Result<()> {
        let parents: BTreeMap<i64, Option<i64>> = self
            .conn
            .prepare_cached("SELECT id, parent_id FROM collections")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut done = BTreeSet::new();
        for &start in parents.keys() {
            let mut path: Vec<i64> = Vec::new();
            let mut at = Some(start);
            let mut ring = None;
            while let Some(id) = at {
                if done.contains(&id) {
                    break;
                }
                if let Some(i) = path.iter().position(|&p| p == id) {
                    ring = Some(path[i..].to_vec());
                    break;
                }
                path.push(id);
                at = parents.get(&id).copied().flatten();
            }
            done.extend(path);
            let Some(ring) = ring else { continue };
            // By clock as the later one wins, then by uid: local ids differ between replicas.
            let mut oldest = None;
            for id in ring {
                let clock = match store::effective(self.conn, COLLECTIONS.code, id, PARENT as i64)? {
                    Some(stored) => self.clock(&stored)?,
                    None => Clock { hlc: crate::model::Hlc(0), replica: Uuid::nil(), counter: 0 },
                };
                let uid = store::uid_of(self.conn, &COLLECTIONS, id)?;
                let key = (clock.hlc, clock.replica, clock.counter, uid, id);
                if oldest.as_ref().is_none_or(|o| key < *o) {
                    oldest = Some(key);
                }
            }
            let (.., id) = oldest.expect("a loop has a collection");
            self.write(&COLLECTIONS, id, PARENT, &Value::Null)?;
            let clock = self.stamp()?;
            store::set_clock(self.conn, COLLECTIONS.code, id, PARENT as i64, clock)?;
        }
        Ok(())
    }

    /// The clock of a field this replica holds no value for yet: every real change beats it,
    /// and with counter 0 no delta ever sends it.
    pub fn placeholder(&self) -> Result<Clock> {
        self.clock(&Stored { hlc: 0, origin: self.own, counter: 0 })
    }

    /// A clock from the wire, stored with the replica's number.
    pub fn stored(&mut self, clock: &Clock) -> Result<Stored> {
        Ok(Stored { hlc: clock.hlc.0, origin: self.origins.id(self.conn, clock.replica)?, counter: clock.counter })
    }

    pub fn clock(&self, stored: &Stored) -> Result<Clock> {
        stored.clock(&self.origins)
    }

    /// A new clock of this replica: what the engine writes on its own counts as a local change.
    pub fn stamp(&mut self) -> Result<Stored> {
        let (hlc, origin, counter) = capture::stamp(self.conn)?;
        Ok(Stored { hlc, origin, counter })
    }

    /// Whether `incoming` beats the clock a field has here (none: anything beats it).
    pub fn wins(&self, incoming: &Clock, local: Option<Stored>) -> Result<bool> {
        Ok(match local {
            None => true,
            Some(local) => incoming.wins_over(&self.clock(&local)?),
        })
    }

    pub fn resolve(&self, t: &Table, uid: Uuid) -> Result<Found> {
        let mut uid = uid;
        // Survivors have smaller uids, so a chain cannot loop; the bound guards a damaged library.
        for _ in 0..64 {
            if let Some(id) = store::id_of(self.conn, t, uid)? {
                return Ok(Found::Live(id, uid));
            }
            match store::tombstone(self.conn, uid)? {
                None => return Ok(Found::Unknown(uid)),
                Some((_, None)) => return Ok(Found::Gone),
                Some((_, Some(next))) => uid = next,
            }
        }
        Err(crate::Error::Damaged(format!("merges of {uid} do not end")))
    }

    pub fn value(&self, t: &Table, id: i64, field: usize) -> Result<Value> {
        let sql = format!("SELECT {} FROM {} WHERE id = ?1", t.columns[field], t.name);
        Ok(self.conn.prepare_cached(&sql)?.query_row([id], |r| r.get(0))?)
    }

    /// Writes one column, and what is derived from it.
    pub fn write(&mut self, t: &Table, id: i64, field: usize, value: &Value) -> Result<()> {
        let column = t.columns[field];
        if t.code == BOOKMARKS.code {
            let sql = if field == UNIQUE {
                "UPDATE bookmarks SET url = ?1, domain = np_domain(?1), url_key = np_url_key(?1),
                    revision = revision + 1, updated_at = ?3 WHERE id = ?2"
                    .to_string()
            } else {
                format!("UPDATE bookmarks SET {column} = ?1, revision = revision + 1, updated_at = ?3 WHERE id = ?2")
            };
            self.conn.prepare_cached(&sql)?.execute(params![value, id, self.now])?;
        } else if t.code == FEEDS.code {
            let sql = format!("UPDATE feeds SET {column} = ?1, updated_at = ?3 WHERE id = ?2");
            self.conn.prepare_cached(&sql)?.execute(params![value, id, self.now])?;
        } else {
            let sql = format!("UPDATE {} SET {column} = ?1 WHERE id = ?2", t.name);
            self.conn.prepare_cached(&sql)?.execute(params![value, id])?;
        }
        self.touched(t, id);
        Ok(())
    }

    pub fn incoming(&self, t: &Table, field: usize, value: &Json) -> Result<Incoming> {
        if value.is_null() {
            return Ok(if t.required.contains(&field) { Incoming::Invalid } else { Incoming::Value(Value::Null) });
        }
        if t.code == BOOKMARKS.code && field == FAVORITE {
            return Ok(match value.as_bool() {
                Some(b) => Incoming::Value(Value::Integer(b as i64)),
                None => Incoming::Invalid,
            });
        }
        if t.code == BOOKMARKS.code && field == PROGRESS {
            return Ok(match value.as_f64() {
                Some(p) if (0.0..=1.0).contains(&p) => Incoming::Value(Value::Real(p)),
                _ => Incoming::Invalid,
            });
        }
        let Some(text) = value.as_str() else {
            return Ok(Incoming::Invalid);
        };
        if t.code == BOOKMARKS.code && field == COLLECTION {
            let Ok(uid) = Uuid::parse_str(text) else {
                return Ok(Incoming::Invalid);
            };
            return Ok(match self.resolve(&COLLECTIONS, uid)? {
                Found::Live(id, here) if here == uid => Incoming::Value(Value::Integer(id)),
                // Merged here into another: the bookmark goes there, as a change of ours, so it
                // holds even where the merge is later overruled by a purge.
                Found::Live(id, _) => Incoming::Redirected(Value::Integer(id)),
                // A purged collection: the bookmark is in none, as on the replica that purged it.
                Found::Gone => Incoming::Value(Value::Null),
                Found::Unknown(_) => Incoming::Defer,
            });
        }
        if t.code == COLLECTIONS.code && field == PARENT {
            let Ok(uid) = Uuid::parse_str(text) else {
                return Ok(Incoming::Invalid);
            };
            return Ok(match self.resolve(&COLLECTIONS, uid)? {
                Found::Live(id, here) if here == uid => Incoming::Value(Value::Integer(id)),
                // Merged here into another: the collection goes into that one, as a change of ours.
                Found::Live(id, _) => Incoming::Redirected(Value::Integer(id)),
                // A purged parent: the top level, as on the replica that purged it.
                Found::Gone => Incoming::Value(Value::Null),
                Found::Unknown(_) if self.parents_final => Incoming::Defer,
                Found::Unknown(_) => Incoming::Later,
            });
        }
        Ok(Incoming::Value(Value::Text(text.to_string())))
    }

    /// The fields of a record, wherever its uid leads.
    fn record(&mut self, t: &Table, uid: Uuid, fields: &[FieldChange]) -> Result<()> {
        match self.resolve(t, uid)? {
            Found::Gone => Ok(()),
            Found::Live(id, here) => self.update(t, id, here == uid, fields).map(|_| ()),
            Found::Unknown(end) if end == uid => self.create(t, uid, fields),
            // Merged into a record not here yet: it comes with its own fields.
            Found::Unknown(_) => {
                self.deferred += 1;
                Ok(())
            }
        }
    }

    /// Writes the fields that win into a record. `own`: the changes are this record's, so their
    /// clocks go with them; otherwise they were made to a record merged into this one and are
    /// written as this replica's changes. Returns the record's id afterwards (another one when
    /// its new address made it merge into an existing record).
    pub fn update(&mut self, t: &Table, id: i64, own: bool, fields: &[FieldChange]) -> Result<i64> {
        let mut unique = None;
        for change in fields {
            let Some(field) = t.index(&change.field) else {
                // A field of a newer version of the engine.
                continue;
            };
            let local = store::effective(self.conn, t.code, id, field as i64)?;
            if !self.wins(&change.clock, local)? {
                continue;
            }
            let (value, own) = match self.incoming(t, field, &change.value)? {
                Incoming::Value(v) => (v, own),
                Incoming::Redirected(v) => (v, false),
                Incoming::Defer => {
                    self.deferred += 1;
                    continue;
                }
                Incoming::Later | Incoming::Invalid => continue,
            };
            if field == UNIQUE {
                unique = Some((value, change.clock));
                continue;
            }
            let same = self.value(t, id, field)? == value;
            if own {
                if !same {
                    self.write(t, id, field, &value)?;
                }
                let clock = self.stored(&change.clock)?;
                store::set_clock(self.conn, t.code, id, field as i64, clock)?;
            } else if !same || field == COLLECTION || (t.code == COLLECTIONS.code && field == PARENT) {
                if !same {
                    self.write(t, id, field, &value)?;
                }
                let clock = self.stamp()?;
                store::set_clock(self.conn, t.code, id, field as i64, clock)?;
            }
        }
        let Some((value, clock)) = unique else {
            return Ok(id);
        };
        let clock = if own {
            self.stored(&clock)?
        } else if self.value(t, id, UNIQUE)? != value {
            self.stamp()?
        } else {
            return Ok(id);
        };
        self.write_unique(t, id, value, clock)
    }

    /// A record this library has never had.
    fn create(&mut self, t: &Table, uid: Uuid, fields: &[FieldChange]) -> Result<()> {
        let mut values: Vec<Option<(Value, Clock)>> = vec![None; t.fields.len()];
        for change in fields {
            let Some(field) = t.index(&change.field) else { continue };
            match self.incoming(t, field, &change.value)? {
                Incoming::Value(v) => values[field] = Some((v, change.clock)),
                Incoming::Redirected(v) => {
                    let stamp = self.stamp()?;
                    values[field] = Some((v, self.clock(&stamp)?));
                }
                // At the top level until the parent is resolved after the batch's collections.
                Incoming::Later => values[field] = Some((Value::Null, self.placeholder()?)),
                Incoming::Defer | Incoming::Invalid => {}
            }
        }
        // Without every field the record cannot be made: the clock of a missing one is unknown.
        if values.iter().any(Option::is_none) {
            self.deferred += 1;
            return Ok(());
        }
        let values: Vec<(Value, Clock)> = values.into_iter().map(|v| v.expect("checked")).collect();
        if let Some(other) = self.holder(t, &values[UNIQUE].0, None)? {
            return self.arrive_taken(t, uid, other, fields, values);
        }
        let mut columns = vec!["uid"];
        columns.extend(t.columns);
        let mut sql_values: Vec<Value> = vec![Value::Text(uid.to_string())];
        sql_values.extend(values.iter().map(|(v, _)| v.clone()));
        let mut placeholders: Vec<String> = (1..=sql_values.len()).map(|i| format!("?{i}")).collect();
        let now = sql_values.len() + 1;
        if t.code == BOOKMARKS.code {
            columns.extend(["domain", "url_key", "updated_at"]);
            placeholders.extend(["np_domain(?2)".into(), "np_url_key(?2)".into(), format!("?{now}")]);
        } else if t.code == FEEDS.code {
            // A feed has no synced time: both are this device's (NP-130).
            columns.extend(["created_at", "updated_at"]);
            placeholders.extend([format!("?{now}"), format!("?{now}")]);
        } else {
            columns.push("created_at");
            placeholders.push(format!("?{now}"));
        }
        sql_values.push(Value::Text(self.now.clone()));
        let sql = format!("INSERT INTO {} ({}) VALUES ({})", t.name, columns.join(", "), placeholders.join(", "));
        self.conn.prepare_cached(&sql)?.execute(rusqlite::params_from_iter(sql_values))?;
        let id = self.conn.last_insert_rowid();
        let mut clocks = Vec::with_capacity(values.len());
        for (field, (_, clock)) in values.iter().enumerate() {
            clocks.push((field, self.stored(clock)?));
        }
        store::write_clocks(self.conn, t.code, id, &clocks)?;
        self.touched(t, id);
        Ok(())
    }

    fn store_gone(&mut self, t: &Table, uid: Uuid, gone: &Gone) -> Result<()> {
        let incoming = self.stored(&gone.clock)?;
        if let Some((clock, merged)) = store::tombstone(self.conn, uid)? {
            if !self.beats(gone, clock, merged)? {
                return Ok(());
            }
        }
        store::write_tombstone(self.conn, t, uid, incoming, gone.merged_into, &self.now)
    }

    /// A purge beats a merge (it is final); otherwise the later tombstone wins.
    fn beats(&self, incoming: &Gone, clock: Option<Stored>, merged: Option<Uuid>) -> Result<bool> {
        Ok(match (incoming.merged_into.is_some(), merged.is_some()) {
            (false, true) => true,
            (true, false) => false,
            _ => self.wins(&incoming.clock, clock)?,
        })
    }

    /// A record that has a tombstone goes: into the record it was merged into, or for good.
    fn settle(&mut self, t: &Table, uid: Uuid) -> Result<()> {
        let Some(id) = store::id_of(self.conn, t, uid)? else {
            return Ok(());
        };
        let Some((_, merged)) = store::tombstone(self.conn, uid)? else {
            return Ok(());
        };
        let Some(into) = merged else {
            return self.remove(t, id);
        };
        match self.resolve(t, into)? {
            Found::Live(survivor, _) if survivor != id => self.merge_into(t, id, survivor).map(|_| ()),
            Found::Live(..) => Err(crate::Error::Damaged(format!("{uid} is merged into itself"))),
            Found::Gone => self.remove(t, id),
            // The survivor arrives later; until then the record stays as it is.
            Found::Unknown(_) => {
                self.deferred += 1;
                Ok(())
            }
        }
    }

    /// Deletes a record here without a tombstone of this replica: the one that came says it all.
    pub fn remove(&mut self, t: &Table, id: i64) -> Result<()> {
        if t.code == FEEDS.code {
            if let Some(uid) = store::uid_of(self.conn, t, id)? {
                self.feeds_gone.push(uid);
            }
        }
        if t.code == COLLECTIONS.code {
            // Its children go to the top level, as on the replica that purged it; said here,
            // not left to the foreign key, so a library without one stays whole (schema 15).
            self.conn
                .prepare_cached("UPDATE collections SET parent_id = NULL WHERE parent_id = ?1")?
                .execute([id])?;
        }
        let sql = format!("DELETE FROM {} WHERE id = ?1", t.name);
        self.conn.prepare_cached(&sql)?.execute([id])?;
        self.touched(t, id);
        Ok(())
    }

    /// The tags of a bookmark.
    fn links(&mut self, uid: Uuid, fields: &[FieldChange]) -> Result<()> {
        let (bookmark, own) = match self.resolve(&BOOKMARKS, uid)? {
            Found::Live(id, here) => (id, here == uid),
            Found::Gone => return Ok(()),
            Found::Unknown(_) => {
                self.deferred += 1;
                return Ok(());
            }
        };
        for change in fields {
            let Ok(tag_uid) = Uuid::parse_str(&change.field) else { continue };
            let Some(linked) = change.value.as_bool() else { continue };
            let (tag, tag_here) = match self.resolve(&TAGS, tag_uid)? {
                Found::Live(id, here) => (id, here),
                Found::Gone => continue,
                Found::Unknown(_) => {
                    self.deferred += 1;
                    continue;
                }
            };
            let local = store::effective(self.conn, LINK, bookmark, tag)?;
            if !self.wins(&change.clock, local)? {
                continue;
            }
            let same = store::has_link(self.conn, bookmark, tag)? == linked;
            if own && tag_here == tag_uid {
                if !same {
                    store::set_link(self.conn, bookmark, tag, linked)?;
                    self.bookmarks.insert(bookmark);
                }
                let clock = self.stored(&change.clock)?;
                store::set_clock(self.conn, LINK, bookmark, tag, clock)?;
            } else if !same {
                store::set_link(self.conn, bookmark, tag, linked)?;
                self.bookmarks.insert(bookmark);
                let clock = self.stamp()?;
                store::set_clock(self.conn, LINK, bookmark, tag, clock)?;
            }
        }
        Ok(())
    }
}
