//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! What two replicas exchange: the changes of a record grouped together, the clock of each field,
//! and version vectors. These shapes are the contract between the engine and the device protocol
//! (`PROTOCOL.md`); a change to them is a new protocol version.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

/// A hybrid logical clock: milliseconds since the Unix epoch in the high 48 bits, a counter of
/// events within one millisecond in the low 16. It never runs backwards on a replica, whatever
/// the wall clock does (Р-22).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Hlc(pub u64);

impl Hlc {
    pub fn new(ms: u64, logical: u16) -> Hlc {
        Hlc((ms << 16) | u64::from(logical))
    }

    pub fn ms(self) -> u64 {
        self.0 >> 16
    }

    pub fn logical(self) -> u16 {
        (self.0 & 0xFFFF) as u16
    }
}

/// When a field was last written and by which change. A library replica numbers its own changes
/// 1, 2, 3…; `(replica, counter)` names one change everywhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Clock {
    pub hlc: Hlc,
    pub replica: Uuid,
    pub counter: u64,
}

impl Clock {
    /// The later clock wins; at the same moment the larger replica does, so every replica picks
    /// the same value.
    pub fn wins_over(&self, other: &Clock) -> bool {
        (self.hlc, self.replica) > (other.hlc, other.replica)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Entity {
    Collection,
    Tag,
    Bookmark,
    /// A bookmark's tag: the group's `uid` is the bookmark's, each field is a tag's uid and its
    /// value says whether the bookmark carries that tag.
    Link,
}

/// The synced fields of each entity, by the names on the wire. Everything else in the library
/// (local ids, revisions, sort keys, `domain`, `url_key`, link checks) is derived or local.
pub const BOOKMARK_FIELDS: [&str; 16] = [
    "url",
    "title",
    "description",
    "image_url",
    "favicon_url",
    "notes",
    "is_favorite",
    // The collection's uid, or null.
    "collection",
    "triaged_at",
    "deleted_at",
    "source",
    "source_name",
    "created_at",
    // Reading (schema 11, Р-69): when it was put in Reading or null, how far it was read (a
    // number from 0 to 1), when it was read or null.
    "reading_at",
    "reading_progress",
    "read_at",
];
/// `position` is a fractional order key (a string), so moving one collection writes only its own.
pub const COLLECTION_FIELDS: [&str; 4] = ["name", "color", "icon", "position"];
pub const TAG_FIELDS: [&str; 1] = ["name"];

/// One field's value as last written. Values are JSON: strings or null for text and times
/// (`YYYY-MM-DDTHH:MM:SS.sssZ`), booleans for `is_favorite` and links, a number for
/// `reading_progress`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldChange {
    pub field: String,
    pub value: serde_json::Value,
    pub clock: Clock,
}

/// The record is gone for good: purged from the trash, or merged into another record with the
/// same address or name. Final: no later field change brings it back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Gone {
    pub clock: Clock,
    pub merged_into: Option<Uuid>,
}

/// The changes of one record that the receiver has not seen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Group {
    pub entity: Entity,
    pub uid: Uuid,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<FieldChange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gone: Option<Gone>,
}

/// For each replica, the highest counter of its changes that a library already holds.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Vector(pub BTreeMap<Uuid, u64>);

impl Vector {
    pub fn get(&self, replica: &Uuid) -> u64 {
        self.0.get(replica).copied().unwrap_or(0)
    }

    /// Whether a change with this clock is already held.
    pub fn covers(&self, clock: &Clock) -> bool {
        clock.counter <= self.get(&clock.replica)
    }

    /// The highest counter of each replica in either vector.
    pub fn merge(&mut self, other: &Vector) {
        for (replica, &counter) in &other.0 {
            let mine = self.0.entry(*replica).or_insert(0);
            *mine = (*mine).max(counter);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn replica(n: u8) -> Uuid {
        Uuid::from_bytes([n; 16])
    }

    #[test]
    fn hlc_keeps_milliseconds_and_counter_apart() {
        let hlc = Hlc::new(1_760_400_000_123, 7);
        assert_eq!(hlc.ms(), 1_760_400_000_123);
        assert_eq!(hlc.logical(), 7);
        assert!(Hlc::new(1, 0) > Hlc::new(0, u16::MAX));
    }

    #[test]
    fn a_tie_goes_to_the_larger_replica() {
        let at = |r| Clock { hlc: Hlc::new(5, 0), replica: replica(r), counter: 1 };
        assert!(at(2).wins_over(&at(1)));
        assert!(!at(1).wins_over(&at(2)));
        assert!(!at(1).wins_over(&at(1)));
    }

    #[test]
    fn vectors_cover_and_merge() {
        let mut a = Vector::default();
        a.0.insert(replica(1), 3);
        let mut b = Vector::default();
        b.0.insert(replica(1), 2);
        b.0.insert(replica(2), 5);
        a.merge(&b);
        assert_eq!(a.get(&replica(1)), 3);
        assert_eq!(a.get(&replica(2)), 5);
        assert!(a.covers(&Clock { hlc: Hlc(0), replica: replica(2), counter: 5 }));
        assert!(!a.covers(&Clock { hlc: Hlc(0), replica: replica(3), counter: 1 }));
    }

    #[test]
    fn a_group_on_the_wire() {
        let clock = Clock { hlc: Hlc::new(1, 2), replica: replica(1), counter: 9 };
        let group = Group {
            entity: Entity::Link,
            uid: replica(4),
            fields: vec![FieldChange { field: replica(5).to_string(), value: json!(true), clock }],
            gone: None,
        };
        let wire = serde_json::to_value(&group).unwrap();
        assert_eq!(
            wire,
            json!({
                "entity": "link",
                "uid": "04040404-0404-0404-0404-040404040404",
                "fields": [{
                    "field": "05050505-0505-0505-0505-050505050505",
                    "value": true,
                    "clock": {"hlc": 65538, "replica": "01010101-0101-0101-0101-010101010101", "counter": 9}
                }]
            })
        );
        assert_eq!(serde_json::from_value::<Group>(wire).unwrap(), group);
    }
}
