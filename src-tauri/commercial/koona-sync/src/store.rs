//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! What the engine keeps and reads: the replicas by number, the version vector, the clock of each
//! field, the values as the wire carries them, and the delta a peer has not seen, in chunks.

use crate::model::{
    Clock, Entity, FieldChange, Gone, Group, Hlc, Vector, BOOKMARK_FIELDS, COLLECTION_FIELDS, TAG_FIELDS,
};
use crate::Result;
use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use uuid::Uuid;

/// The field of `sync_clock` that holds a record's clock as it was created.
pub(crate) const ROW: i64 = -1;
pub(crate) const LINK: i64 = 3;
/// Places in [`BOOKMARK_FIELDS`] with their own conversion.
pub(crate) const FAVORITE: usize = 6;
pub(crate) const COLLECTION: usize = 7;
pub(crate) const PROGRESS: usize = 14;
/// The unique field of every record: the address, the name.
pub(crate) const UNIQUE: usize = 0;

/// A synced table. `columns` are in the order of `fields`, the names on the wire.
pub(crate) struct Table {
    pub entity: Entity,
    pub code: i64,
    pub name: &'static str,
    pub kind: &'static str,
    pub columns: &'static [&'static str],
    pub fields: &'static [&'static str],
    /// Columns that may not be null.
    pub required: &'static [usize],
}

pub(crate) const COLLECTIONS: Table = Table {
    entity: Entity::Collection,
    code: 0,
    name: "collections",
    kind: "collection",
    columns: &["name", "color", "icon", "position_key"],
    fields: &COLLECTION_FIELDS,
    required: &[0],
};
pub(crate) const TAGS: Table = Table {
    entity: Entity::Tag,
    code: 1,
    name: "tags",
    kind: "tag",
    columns: &["name"],
    fields: &TAG_FIELDS,
    required: &[0],
};
pub(crate) const BOOKMARKS: Table = Table {
    entity: Entity::Bookmark,
    code: 2,
    name: "bookmarks",
    kind: "bookmark",
    columns: &[
        "url",
        "title",
        "description",
        "image_url",
        "favicon_url",
        "notes",
        "is_favorite",
        "collection_id",
        "triaged_at",
        "deleted_at",
        "source",
        "source_name",
        "created_at",
        "reading_at",
        "reading_progress",
        "read_at",
    ],
    fields: &BOOKMARK_FIELDS,
    required: &[0, 1, FAVORITE, 12, PROGRESS],
};
pub(crate) const RECORDS: [&Table; 3] = [&COLLECTIONS, &TAGS, &BOOKMARKS];

impl Table {
    pub fn of(entity: Entity) -> Option<&'static Table> {
        match entity {
            Entity::Collection => Some(&COLLECTIONS),
            Entity::Tag => Some(&TAGS),
            Entity::Bookmark => Some(&BOOKMARKS),
            Entity::Link => None,
        }
    }

    pub fn of_kind(kind: &str) -> Option<&'static Table> {
        RECORDS.into_iter().find(|t| t.kind == kind)
    }

    pub fn index(&self, field: &str) -> Option<usize> {
        self.fields.iter().position(|f| *f == field)
    }

    fn is_bookmarks(&self) -> bool {
        self.code == BOOKMARKS.code
    }
}

fn entity_of(code: i64) -> Entity {
    match code {
        0 => Entity::Collection,
        1 => Entity::Tag,
        2 => Entity::Bookmark,
        _ => Entity::Link,
    }
}

pub(crate) fn parse_uid(text: &str) -> Result<Uuid> {
    Uuid::parse_str(text).map_err(|e| crate::Error::Damaged(format!("uid {text}: {e}")))
}

/// Replica ids and the small numbers the library stores instead.
#[derive(Default)]
pub(crate) struct Origins {
    ids: HashMap<Uuid, i64>,
    uuids: HashMap<i64, Uuid>,
}

impl Origins {
    pub fn load(conn: &Connection) -> Result<Origins> {
        let mut origins = Origins::default();
        let mut stmt = conn.prepare("SELECT id, origin FROM sync_origins")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (id, origin) = row?;
            let uuid = parse_uid(&origin)?;
            origins.ids.insert(uuid, id);
            origins.uuids.insert(id, uuid);
        }
        Ok(origins)
    }

    pub fn id(&mut self, conn: &Connection, uuid: Uuid) -> Result<i64> {
        if let Some(id) = self.ids.get(&uuid) {
            return Ok(*id);
        }
        conn.execute("INSERT OR IGNORE INTO sync_origins (origin) VALUES (?1)", [uuid.to_string()])?;
        let id: i64 = conn.query_row(
            "SELECT id FROM sync_origins WHERE origin = ?1",
            [uuid.to_string()],
            |r| r.get(0),
        )?;
        self.ids.insert(uuid, id);
        self.uuids.insert(id, uuid);
        Ok(id)
    }

    pub fn uuid(&self, id: i64) -> Result<Uuid> {
        self.uuids
            .get(&id)
            .copied()
            .ok_or_else(|| crate::Error::Damaged(format!("no replica {id}")))
    }

    pub fn all(&self) -> impl Iterator<Item = (i64, Uuid)> + '_ {
        self.uuids.iter().map(|(id, uuid)| (*id, *uuid))
    }
}

/// A clock as stored: the replica by its number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Stored {
    pub hlc: u64,
    pub origin: i64,
    pub counter: u64,
}

impl Stored {
    pub fn clock(&self, origins: &Origins) -> Result<Clock> {
        Ok(Clock { hlc: Hlc(self.hlc), replica: origins.uuid(self.origin)?, counter: self.counter })
    }
}

/// The clocks a record has in `sync_clock`, by field (`ROW` included).
pub(crate) fn clocks(conn: &Connection, code: i64, row: i64) -> Result<BTreeMap<i64, Stored>> {
    let mut stmt =
        conn.prepare_cached("SELECT field, hlc, origin, counter FROM sync_clock WHERE entity = ?1 AND row = ?2")?;
    let rows = stmt.query_map(params![code, row], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            Stored { hlc: r.get::<_, i64>(1)? as u64, origin: r.get(2)?, counter: r.get::<_, i64>(3)? as u64 },
        ))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The clock that holds for one field: its own, or the record's as created.
pub(crate) fn effective(conn: &Connection, code: i64, row: i64, field: i64) -> Result<Option<Stored>> {
    let mut stmt = conn.prepare_cached(
        "SELECT hlc, origin, counter FROM sync_clock
         WHERE entity = ?1 AND row = ?2 AND field IN (?3, -1) ORDER BY field DESC LIMIT 1",
    )?;
    Ok(stmt
        .query_row(params![code, row, field], |r| {
            Ok(Stored { hlc: r.get::<_, i64>(0)? as u64, origin: r.get(1)?, counter: r.get::<_, i64>(2)? as u64 })
        })
        .optional()?)
}

pub(crate) fn set_clock(conn: &Connection, code: i64, row: i64, field: i64, clock: Stored) -> Result<()> {
    conn.prepare_cached(
        "INSERT INTO sync_clock (entity, row, field, hlc, origin, counter) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT DO UPDATE SET hlc = excluded.hlc, origin = excluded.origin, counter = excluded.counter",
    )?
    .execute(params![code, row, field, clock.hlc as i64, clock.origin, clock.counter as i64])?;
    Ok(())
}

/// Replaces every clock of a record: the most common one becomes the record's, the others stay
/// with their fields.
pub(crate) fn write_clocks(conn: &Connection, code: i64, row: i64, fields: &[(usize, Stored)]) -> Result<()> {
    conn.prepare_cached("DELETE FROM sync_clock WHERE entity = ?1 AND row = ?2")?
        .execute(params![code, row])?;
    let mut counts: HashMap<(u64, i64, u64), usize> = HashMap::new();
    for (_, c) in fields {
        *counts.entry((c.hlc, c.origin, c.counter)).or_default() += 1;
    }
    let Some(((hlc, origin, counter), _)) = counts.into_iter().max_by_key(|(k, n)| (*n, *k)) else {
        return Ok(());
    };
    let common = Stored { hlc, origin, counter };
    set_clock(conn, code, row, ROW, common)?;
    for (field, c) in fields {
        if *c != common {
            set_clock(conn, code, row, *field as i64, *c)?;
        }
    }
    Ok(())
}

/// The values of a record as stored, by field; a bookmark's collection as its local id.
pub(crate) fn raw_values(conn: &Connection, t: &Table, id: i64) -> Result<Option<(Uuid, Vec<Value>)>> {
    let sql = format!("SELECT uid, {} FROM {} WHERE id = ?1", t.columns.join(", "), t.name);
    let mut stmt = conn.prepare_cached(&sql)?;
    let row = stmt
        .query_row([id], |r| {
            let uid: String = r.get(0)?;
            let values = (0..t.columns.len()).map(|i| r.get::<_, Value>(i + 1)).collect::<rusqlite::Result<Vec<_>>>()?;
            Ok((uid, values))
        })
        .optional()?;
    row.map(|(uid, values)| Ok((parse_uid(&uid)?, values))).transpose()
}

pub(crate) fn uid_of(conn: &Connection, t: &Table, id: i64) -> Result<Option<Uuid>> {
    let sql = format!("SELECT uid FROM {} WHERE id = ?1", t.name);
    let uid: Option<String> = conn.prepare_cached(&sql)?.query_row([id], |r| r.get(0)).optional()?;
    uid.map(|u| parse_uid(&u)).transpose()
}

pub(crate) fn id_of(conn: &Connection, t: &Table, uid: Uuid) -> Result<Option<i64>> {
    let sql = format!("SELECT id FROM {} WHERE uid = ?1", t.name);
    Ok(conn.prepare_cached(&sql)?.query_row([uid.to_string()], |r| r.get(0)).optional()?)
}

/// A stored value as the wire carries it.
pub(crate) fn to_json(conn: &Connection, t: &Table, field: usize, value: &Value) -> Result<Json> {
    Ok(match value {
        Value::Null => Json::Null,
        Value::Integer(i) if t.is_bookmarks() && field == FAVORITE => Json::Bool(*i != 0),
        Value::Integer(i) if t.is_bookmarks() && field == COLLECTION => {
            uid_of(conn, &COLLECTIONS, *i)?.map_or(Json::Null, |u| Json::String(u.to_string()))
        }
        // Progress is a fraction on the wire, also when an integer was stored.
        Value::Integer(i) if t.is_bookmarks() && field == PROGRESS => Json::from(*i as f64),
        Value::Integer(i) => Json::from(*i),
        Value::Real(f) => serde_json::Number::from_f64(*f).map_or(Json::Null, Json::Number),
        Value::Text(s) => Json::String(s.clone()),
        Value::Blob(_) => Json::Null,
    })
}

/// The tombstone of a uid: (clock, merged_into); a tombstone made before sync has none.
pub(crate) fn tombstone(conn: &Connection, uid: Uuid) -> Result<Option<(Option<Stored>, Option<Uuid>)>> {
    let row: Option<(Option<i64>, Option<i64>, Option<i64>, Option<String>)> = conn
        .prepare_cached("SELECT hlc, origin, counter, merged_into FROM tombstones WHERE uid = ?1")?
        .query_row([uid.to_string()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .optional()?;
    let Some((hlc, origin, counter, merged)) = row else {
        return Ok(None);
    };
    let clock = match (hlc, origin, counter) {
        (Some(h), Some(o), Some(c)) => Some(Stored { hlc: h as u64, origin: o, counter: c as u64 }),
        _ => None,
    };
    Ok(Some((clock, merged.map(|m| parse_uid(&m)).transpose()?)))
}

pub(crate) fn write_tombstone(
    conn: &Connection,
    t: &Table,
    uid: Uuid,
    clock: Stored,
    merged_into: Option<Uuid>,
    now: &str,
) -> Result<()> {
    conn.prepare_cached(
        "INSERT INTO tombstones (uid, kind, deleted_at, purged_at, hlc, origin, counter, merged_into)
         VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (uid) DO UPDATE SET hlc = excluded.hlc, origin = excluded.origin,
             counter = excluded.counter, merged_into = excluded.merged_into",
    )?
    .execute(params![
        uid.to_string(),
        t.kind,
        now,
        clock.hlc as i64,
        clock.origin,
        clock.counter as i64,
        merged_into.map(|u| u.to_string())
    ])?;
    Ok(())
}

/// What this library holds, by replica.
pub fn vector(conn: &Connection) -> Result<Vector> {
    let mut stmt =
        conn.prepare("SELECT o.origin, v.counter FROM sync_vector v JOIN sync_origins o ON o.id = v.origin")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    let mut vector = Vector::default();
    for row in rows {
        let (origin, counter) = row?;
        vector.0.insert(parse_uid(&origin)?, counter as u64);
    }
    Ok(vector)
}

/// After every chunk of a delta is applied: the library now holds what the sender held. A
/// counter of this replica beyond its own (a copy of the library restored over a newer one)
/// moves the counter on, so it is never given twice.
pub fn merge_vector(conn: &Connection, covers: &Vector) -> Result<()> {
    let mut origins = Origins::load(conn)?;
    for (replica, counter) in &covers.0 {
        let id = origins.id(conn, *replica)?;
        conn.prepare_cached(
            "INSERT INTO sync_vector (origin, counter) VALUES (?1, ?2)
             ON CONFLICT DO UPDATE SET counter = max(counter, excluded.counter)",
        )?
        .execute(params![id, *counter as i64])?;
    }
    Ok(())
}

/// Where a delta stopped: the sender's vector when it began, and the last record sent. A session
/// that broke off goes on from here with the same `since`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cursor {
    pub target: Vector,
    /// Entity code × 2, + 1 for tombstones.
    pub phase: u8,
    pub after: i64,
}

/// One message of a delta. `covers` is `since` until the last chunk, then `since` with
/// everything the sender held: a receiver merges it only once every chunk is applied.
#[derive(Debug, Clone)]
pub struct Chunk {
    pub groups: Vec<Group>,
    pub covers: Vector,
    pub last: bool,
    pub cursor: Cursor,
}

/// The changes a peer with vector `since` has not seen, in chunks of about `max_bytes` of JSON:
/// per entity (collections, tags, bookmarks, links) the records, then the tombstones, so a
/// reference reaches the receiver after what it refers to. The keys are found once from the
/// `(origin, counter)` index; values and clocks are read when each chunk is made.
pub struct Delta<'c> {
    conn: &'c Connection,
    since: Vector,
    target: Vector,
    keys: Vec<(u8, i64)>,
    pos: usize,
    done: bool,
}

impl<'c> Delta<'c> {
    pub fn new(conn: &'c Connection, since: &Vector) -> Result<Delta<'c>> {
        let target = vector(conn)?;
        Delta::start(conn, since, target, None)
    }

    pub fn resume(conn: &'c Connection, since: &Vector, cursor: &Cursor) -> Result<Delta<'c>> {
        Delta::start(conn, since, cursor.target.clone(), Some((cursor.phase, cursor.after)))
    }

    fn start(conn: &'c Connection, since: &Vector, target: Vector, after: Option<(u8, i64)>) -> Result<Delta<'c>> {
        let origins = Origins::load(conn)?;
        let mut keys = BTreeSet::new();
        let mut rows = conn.prepare("SELECT entity, row FROM sync_clock WHERE origin = ?1 AND counter > ?2")?;
        let mut gone = conn.prepare("SELECT kind, rowid FROM tombstones WHERE origin = ?1 AND counter > ?2")?;
        for (id, uuid) in origins.all() {
            let from = since.get(&uuid) as i64;
            for row in rows.query_map(params![id, from], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))? {
                let (entity, row) = row?;
                keys.insert(((entity * 2) as u8, row));
            }
            for row in gone.query_map(params![id, from], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
                let (kind, rowid) = row?;
                if let Some(t) = Table::of_kind(&kind) {
                    keys.insert(((t.code * 2 + 1) as u8, rowid));
                }
            }
        }
        let keys = match after {
            Some(after) => keys.into_iter().filter(|k| *k > after).collect(),
            None => keys.into_iter().collect(),
        };
        Ok(Delta { conn, since: since.clone(), target, keys, pos: 0, done: false })
    }

    /// The number of records and tombstones left to send.
    pub fn remaining(&self) -> usize {
        self.keys.len() - self.pos
    }

    /// The next chunk; `None` after the last. An empty delta is one empty last chunk, which still
    /// carries `covers`.
    pub fn next_chunk(&mut self, max_bytes: usize) -> Result<Option<Chunk>> {
        if self.done {
            return Ok(None);
        }
        // One read transaction: the values and clocks of a chunk agree.
        self.conn.execute_batch("SAVEPOINT koona_sync_delta")?;
        let built = self.build(max_bytes);
        self.conn.execute_batch("RELEASE koona_sync_delta")?;
        let (groups, cursor) = built?;
        let last = self.pos >= self.keys.len();
        let mut covers = self.since.clone();
        if last {
            covers.merge(&self.target);
            self.done = true;
        }
        Ok(Some(Chunk { groups, covers, last, cursor }))
    }

    fn build(&mut self, max_bytes: usize) -> Result<(Vec<Group>, Cursor)> {
        let origins = Origins::load(self.conn)?;
        let mut groups = Vec::new();
        let mut bytes = 0;
        let mut at = if self.pos > 0 { self.keys[self.pos - 1] } else { (0, i64::MIN) };
        while self.pos < self.keys.len() && (bytes < max_bytes || groups.is_empty()) {
            let (phase, key) = self.keys[self.pos];
            self.pos += 1;
            at = (phase, key);
            let group = if phase % 2 == 1 {
                self.tombstone_group(&origins, key)?
            } else if phase as i64 / 2 == LINK {
                self.link_group(&origins, key)?
            } else {
                self.record_group(&origins, entity_of(phase as i64 / 2), key)?
            };
            if let Some(group) = group {
                bytes += serde_json::to_vec(&group).map(|v| v.len()).unwrap_or(0);
                groups.push(group);
            }
        }
        Ok((groups, Cursor { target: self.target.clone(), phase: at.0, after: at.1 }))
    }

    fn unseen(&self, origins: &Origins, clock: &Stored) -> Result<Option<Clock>> {
        let clock = clock.clock(origins)?;
        Ok((!self.since.covers(&clock)).then_some(clock))
    }

    fn record_group(&self, origins: &Origins, entity: Entity, row: i64) -> Result<Option<Group>> {
        let t = Table::of(entity).expect("a record entity");
        let Some((uid, values)) = raw_values(self.conn, t, row)? else {
            return Ok(None);
        };
        let clocks = clocks(self.conn, t.code, row)?;
        let mut fields = Vec::new();
        for (i, name) in t.fields.iter().enumerate() {
            let Some(stored) = clocks.get(&(i as i64)).or_else(|| clocks.get(&ROW)) else {
                continue;
            };
            if let Some(clock) = self.unseen(origins, stored)? {
                let value = to_json(self.conn, t, i, &values[i])?;
                fields.push(FieldChange { field: name.to_string(), value, clock });
            }
        }
        Ok((!fields.is_empty()).then_some(Group { entity, uid, fields, gone: None }))
    }

    fn link_group(&self, origins: &Origins, row: i64) -> Result<Option<Group>> {
        let Some(uid) = uid_of(self.conn, &BOOKMARKS, row)? else {
            return Ok(None);
        };
        let mut fields = Vec::new();
        for (tag, stored) in clocks(self.conn, LINK, row)? {
            let Some(clock) = self.unseen(origins, &stored)? else {
                continue;
            };
            let Some(tag_uid) = uid_of(self.conn, &TAGS, tag)? else {
                continue;
            };
            let linked = has_link(self.conn, row, tag)?;
            fields.push(FieldChange { field: tag_uid.to_string(), value: Json::Bool(linked), clock });
        }
        Ok((!fields.is_empty()).then_some(Group { entity: Entity::Link, uid, fields, gone: None }))
    }

    fn tombstone_group(&self, origins: &Origins, rowid: i64) -> Result<Option<Group>> {
        let row: Option<(String, String, Option<i64>, Option<i64>, Option<i64>, Option<String>)> = self
            .conn
            .prepare_cached("SELECT uid, kind, hlc, origin, counter, merged_into FROM tombstones WHERE rowid = ?1")?
            .query_row([rowid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
            .optional()?;
        let Some((uid, kind, Some(hlc), Some(origin), Some(counter), merged)) = row else {
            return Ok(None);
        };
        let Some(t) = Table::of_kind(&kind) else {
            return Ok(None);
        };
        let stored = Stored { hlc: hlc as u64, origin, counter: counter as u64 };
        let Some(clock) = self.unseen(origins, &stored)? else {
            return Ok(None);
        };
        let merged_into = merged.map(|m| parse_uid(&m)).transpose()?;
        Ok(Some(Group { entity: t.entity, uid: parse_uid(&uid)?, fields: Vec::new(), gone: Some(Gone { clock, merged_into }) }))
    }
}

pub(crate) fn has_link(conn: &Connection, bookmark: i64, tag: i64) -> Result<bool> {
    Ok(conn
        .prepare_cached("SELECT EXISTS (SELECT 1 FROM bookmark_tags WHERE bookmark_id = ?1 AND tag_id = ?2)")?
        .query_row(params![bookmark, tag], |r| r.get(0))?)
}

pub(crate) fn set_link(conn: &Connection, bookmark: i64, tag: i64, linked: bool) -> Result<()> {
    if linked {
        conn.prepare_cached("INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id) VALUES (?1, ?2)")?
            .execute(params![bookmark, tag])?;
    } else {
        conn.prepare_cached("DELETE FROM bookmark_tags WHERE bookmark_id = ?1 AND tag_id = ?2")?
            .execute(params![bookmark, tag])?;
    }
    Ok(())
}
