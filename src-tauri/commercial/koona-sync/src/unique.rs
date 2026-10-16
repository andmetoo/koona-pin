//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! One address, one bookmark; one name, one collection or tag. When two records meet with the
//! same value, the one with the smaller uid survives everywhere; the other gets a tombstone
//! `merged_into` the survivor, made as a change of this replica so it spreads, and every later
//! change to it is redirected (`apply.rs`).
//!
//! What the survivor takes from the other (a field whose clock wins, a tag it lacks, the
//! bookmarks of a collection) is written as a new change of this replica, not with the clock it
//! came with. A record then only ever carries its own clocks, so any replica that lacks it gets
//! all of its fields, and a replica that never saw the merged record, or purged it, still ends
//! with the same survivor.

use crate::apply::Ctx;
use crate::model::{Clock, FieldChange};
use crate::store::{self, Stored, Table, BOOKMARKS, COLLECTION, COLLECTIONS, FEEDS, LINK, TAGS, UNIQUE};
use crate::Result;
use rusqlite::params;
use rusqlite::types::Value;
use uuid::Uuid;

impl Ctx<'_> {
    /// The record here, other than `except`, that holds a unique value.
    pub fn holder(&self, t: &Table, value: &Value, except: Option<i64>) -> Result<Option<i64>> {
        use rusqlite::OptionalExtension;
        let sql = format!("SELECT id FROM {} WHERE {} = ?1 AND id IS NOT ?2", t.name, t.columns[UNIQUE]);
        Ok(self.conn.prepare_cached(&sql)?.query_row(params![value, except], |r| r.get(0)).optional()?)
    }

    fn uid(&self, t: &Table, id: i64) -> Result<Uuid> {
        store::uid_of(self.conn, t, id)?.ok_or_else(|| crate::Error::Damaged(format!("no {} {id}", t.kind)))
    }

    fn beats_stored(&self, incoming: Stored, local: Option<Stored>) -> Result<bool> {
        let incoming: Clock = self.clock(&incoming)?;
        self.wins(&incoming, local)
    }

    /// Gives record `id` a new unique value; when another record holds it, the two merge.
    /// Returns the id of the record that has the value afterwards.
    pub fn write_unique(&mut self, t: &Table, id: i64, value: Value, clock: Stored) -> Result<i64> {
        if self.value(t, id, UNIQUE)? == value {
            store::set_clock(self.conn, t.code, id, UNIQUE as i64, clock)?;
            return Ok(id);
        }
        let Some(other) = self.holder(t, &value, Some(id))? else {
            self.write(t, id, UNIQUE, &value)?;
            store::set_clock(self.conn, t.code, id, UNIQUE as i64, clock)?;
            return Ok(id);
        };
        let (mine, theirs) = (self.uid(t, id)?, self.uid(t, other)?);
        if mine < theirs {
            self.absorb(t, other, id, theirs, mine)?;
            self.write(t, id, UNIQUE, &value)?;
            store::set_clock(self.conn, t.code, id, UNIQUE as i64, clock)?;
            Ok(id)
        } else {
            // The other already has the value; whichever clock it has, the value is the same.
            self.absorb(t, id, other, mine, theirs)?;
            Ok(other)
        }
    }

    /// A merge this replica decides: `loser` goes into `survivor` and gets a tombstone of ours.
    fn absorb(&mut self, t: &Table, loser: i64, survivor: i64, loser_uid: Uuid, survivor_uid: Uuid) -> Result<()> {
        self.fold(t, loser, survivor, true)?;
        self.remove(t, loser)?;
        self.tombstone_local(t, loser_uid, Some(survivor_uid))
    }

    pub fn tombstone_local(&mut self, t: &Table, uid: Uuid, merged_into: Option<Uuid>) -> Result<()> {
        let clock = self.stamp()?;
        store::write_tombstone(self.conn, t, uid, clock, merged_into, &self.now.clone())
    }

    /// A merge another replica decided (its tombstone came): `loser` goes into `survivor`.
    pub fn merge_into(&mut self, t: &Table, loser: i64, survivor: i64) -> Result<i64> {
        let address = self.fold(t, loser, survivor, false)?;
        self.remove(t, loser)?;
        match address {
            // The loser's value was the later one (it was changed after the two met elsewhere).
            Some(value) => {
                let clock = self.stamp()?;
                self.write_unique(t, survivor, value, clock)
            }
            None => Ok(survivor),
        }
    }

    /// Writes into `survivor` what `loser` has later, as changes of this replica. With
    /// `same_value` the unique field is left alone; otherwise the loser's value, when later and
    /// different, is returned for the caller to write after the loser is gone.
    fn fold(&mut self, t: &Table, loser: i64, survivor: i64, same_value: bool) -> Result<Option<Value>> {
        let mut unique = None;
        for field in 0..t.fields.len() {
            let Some(theirs) = store::effective(self.conn, t.code, loser, field as i64)? else {
                continue;
            };
            let ours = store::effective(self.conn, t.code, survivor, field as i64)?;
            if !self.beats_stored(theirs, ours)? {
                continue;
            }
            let value = self.value(t, loser, field)?;
            if value == self.value(t, survivor, field)? {
                continue;
            }
            if field == UNIQUE {
                if !same_value {
                    unique = Some(value);
                }
                continue;
            }
            self.write(t, survivor, field, &value)?;
            let clock = self.stamp()?;
            store::set_clock(self.conn, t.code, survivor, field as i64, clock)?;
        }
        if t.code == BOOKMARKS.code {
            // The tags of both.
            for (tag, theirs) in store::clocks(self.conn, LINK, loser)? {
                self.add_link(loser, tag, survivor, tag, theirs)?;
            }
        } else if t.code == TAGS.code {
            for (bookmark, theirs) in self.link_clocks_of_tag(loser)? {
                self.add_link(bookmark, loser, bookmark, survivor, theirs)?;
            }
        } else if t.code == COLLECTIONS.code {
            self.restamp_members(loser)?;
            self.conn
                .prepare_cached(
                    "UPDATE bookmarks SET collection_id = ?2, revision = revision + 1, updated_at = ?3
                     WHERE collection_id = ?1",
                )?
                .execute(params![loser, survivor, self.now])?;
        } else if t.code == FEEDS.code {
            // Nothing refers to a feed in the library: its posts live in each device's cache,
            // keyed by uid, and the loser's go with it (NP-130).
        } else {
            return Err(crate::Error::Damaged(format!("no merge for {}", t.kind)));
        }
        Ok(unique)
    }

    /// The bookmarks of a collection that changed identity: their place is a change of ours.
    fn restamp_members(&mut self, collection: i64) -> Result<()> {
        let bookmarks: Vec<i64> = self
            .conn
            .prepare_cached("SELECT id FROM bookmarks WHERE collection_id = ?1")?
            .query_map([collection], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for bookmark in bookmarks {
            let clock = self.stamp()?;
            store::set_clock(self.conn, BOOKMARKS.code, bookmark, COLLECTION as i64, clock)?;
            self.bookmarks.insert(bookmark);
        }
        Ok(())
    }

    fn link_clocks_of_tag(&self, tag: i64) -> Result<Vec<(i64, Stored)>> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT row, hlc, origin, counter FROM sync_clock WHERE entity = ?1 AND field = ?2")?;
        let rows = stmt.query_map(params![LINK, tag], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                Stored { hlc: r.get::<_, i64>(1)? as u64, origin: r.get(2)?, counter: r.get::<_, i64>(3)? as u64 },
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// A tag the merged record had becomes the survivor's, unless the survivor took it off later.
    fn add_link(&mut self, from_bookmark: i64, from_tag: i64, bookmark: i64, tag: i64, theirs: Stored) -> Result<()> {
        if !store::has_link(self.conn, from_bookmark, from_tag)? || store::has_link(self.conn, bookmark, tag)? {
            return Ok(());
        }
        let ours = store::effective(self.conn, LINK, bookmark, tag)?;
        if self.beats_stored(theirs, ours)? {
            store::set_link(self.conn, bookmark, tag, true)?;
            let clock = self.stamp()?;
            store::set_clock(self.conn, LINK, bookmark, tag, clock)?;
            self.bookmarks.insert(bookmark);
        }
        Ok(())
    }

    /// A record arrives whose unique value the record `other` here holds.
    pub fn arrive_taken(
        &mut self,
        t: &Table,
        uid: Uuid,
        other: i64,
        fields: &[FieldChange],
        values: Vec<(Value, Clock)>,
    ) -> Result<()> {
        let theirs = self.uid(t, other)?;
        if uid > theirs {
            // The one here survives and takes what is later in the arriving one.
            self.update(t, other, false, fields)?;
            return self.tombstone_local(t, uid, Some(theirs));
        }
        // The arriving one survives: the record here takes its uid, its fields where they are
        // later, and keeps its own where they are not, as changes of this replica.
        let sql = format!("UPDATE {} SET uid = ?1 WHERE id = ?2", t.name);
        self.conn.prepare_cached(&sql)?.execute(params![uid.to_string(), other])?;
        let mut clocks = Vec::with_capacity(values.len());
        for (field, (value, clock)) in values.iter().enumerate() {
            let local = store::effective(self.conn, t.code, other, field as i64)?;
            let here = self.value(t, other, field)?;
            if here == *value || self.wins(clock, local)? {
                if here != *value {
                    self.write(t, other, field, value)?;
                }
                clocks.push((field, self.stored(clock)?));
            } else {
                clocks.push((field, self.stamp()?));
            }
        }
        store::write_clocks(self.conn, t.code, other, &clocks)?;
        // Its tags were the old record's: they stay as this replica's changes, the arriving
        // record's own come after.
        let links: Vec<(i64, i64)> = if t.code == BOOKMARKS.code {
            store::clocks(self.conn, LINK, other)?.into_keys().map(|tag| (other, tag)).collect()
        } else if t.code == TAGS.code {
            self.link_clocks_of_tag(other)?.into_iter().map(|(bookmark, _)| (bookmark, other)).collect()
        } else if t.code == COLLECTIONS.code {
            // The bookmarks in the old collection are now in the arriving one: a move of ours.
            self.restamp_members(other)?;
            Vec::new()
        } else if t.code == FEEDS.code {
            // Nothing in the library refers to a feed; its old uid is gone on this device, and
            // so are the posts the cache kept under it (NP-130).
            self.feeds_gone.push(theirs);
            Vec::new()
        } else {
            return Err(crate::Error::Damaged(format!("no merge for {}", t.kind)));
        };
        for (bookmark, tag) in links {
            if store::has_link(self.conn, bookmark, tag)? {
                let clock = self.stamp()?;
                store::set_clock(self.conn, LINK, bookmark, tag, clock)?;
            } else {
                self.conn
                    .prepare_cached("DELETE FROM sync_clock WHERE entity = ?1 AND row = ?2 AND field = ?3")?
                    .execute(params![LINK, bookmark, tag])?;
            }
        }
        self.touched(t, other);
        self.tombstone_local(t, theirs, Some(uid))
    }
}
