//! The command journal (NP-024, Р-23): what each change of a bookmark did,
//! so it can be taken back.
//!
//! The journal lives in memory next to the connection, for the current run
//! only: after a restart there is nothing to undo, while every decision is
//! already saved. It keeps the last [`LIMIT`] commands. Every write of the
//! library goes through the one connection of `DbState`, under its lock, so
//! the state read before a command and the one it returns differ by that
//! command alone.
//!
//! Undo compares field by field. It puts back what the command changed when
//! those fields still hold what the command wrote; anything else (metadata, a
//! preview) may have changed meanwhile and stays. If a field the command
//! wrote has changed since, the bookmark is gone, or its collection is,
//! nothing is undone and the command leaves the journal: undoing it would
//! throw away a later change.

use crate::db::{self, Bookmark};
use rusqlite::{types::Value, Connection, Result};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use ts_rs::TS;

/// Older commands are forgotten.
pub const LIMIT: usize = 100;

/// What a command did, for the words of the undo notice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, rename = "CommandAction")]
pub enum Action {
    /// The editor: any fields at once.
    Edit,
    Favorite,
    Move,
    Tag,
    Trash,
    Restore,
}

/// What `undo` did.
#[derive(Debug, Serialize, TS)]
#[serde(tag = "outcome", rename_all = "snake_case")]
#[ts(export)]
pub enum Undo {
    /// Put back; the bookmarks as they are now.
    Undone {
        action: Action,
        bookmarks: Vec<Bookmark>,
    },
    /// A field the command wrote has changed since.
    Conflict { action: Action, title: String },
    /// The bookmark was deleted for good meanwhile.
    Gone { action: Action, title: String },
    /// The collection the bookmark was in no longer exists.
    NoCollection { action: Action, title: String },
    /// The journal is empty, or no longer has this command.
    Nothing,
}

/// The fields of a bookmark a person decides; the rest come from the page.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Fields {
    title: String,
    notes: Option<String>,
    is_favorite: bool,
    collection_id: Option<i64>,
    /// Sorted: their order means nothing.
    tags: Vec<String>,
    triaged_at: Option<String>,
    deleted_at: Option<String>,
}

impl From<&Bookmark> for Fields {
    fn from(b: &Bookmark) -> Self {
        let mut tags = b.tags.clone().unwrap_or_default();
        tags.sort();
        Fields {
            title: b.title.clone(),
            notes: b.notes.clone(),
            is_favorite: b.is_favorite,
            collection_id: b.collection_id,
            tags,
            triaged_at: b.triaged_at.clone(),
            deleted_at: b.deleted_at.clone(),
        }
    }
}

struct Change {
    id: i64,
    before: Fields,
    after: Fields,
}

impl Change {
    /// Every field the command changed still holds what it wrote.
    fn holds(&self, now: &Fields) -> bool {
        let (b, a) = (&self.before, &self.after);
        (b.title == a.title || now.title == a.title)
            && (b.notes == a.notes || now.notes == a.notes)
            && (b.is_favorite == a.is_favorite || now.is_favorite == a.is_favorite)
            && (b.collection_id == a.collection_id || now.collection_id == a.collection_id)
            && (b.tags == a.tags || now.tags == a.tags)
            && (b.triaged_at == a.triaged_at || now.triaged_at == a.triaged_at)
            && (b.deleted_at == a.deleted_at || now.deleted_at == a.deleted_at)
    }

    /// Writes back the fields the command changed, in place of what it wrote.
    fn rewind(&self, conn: &Connection) -> Result<()> {
        let (b, a) = (&self.before, &self.after);
        let fields: [(&str, bool, Value); 6] = [
            ("title", b.title != a.title, b.title.clone().into()),
            ("notes", b.notes != a.notes, b.notes.clone().into()),
            (
                "is_favorite",
                b.is_favorite != a.is_favorite,
                b.is_favorite.into(),
            ),
            (
                "collection_id",
                b.collection_id != a.collection_id,
                b.collection_id.into(),
            ),
            (
                "triaged_at",
                b.triaged_at != a.triaged_at,
                b.triaged_at.clone().into(),
            ),
            (
                "deleted_at",
                b.deleted_at != a.deleted_at,
                b.deleted_at.clone().into(),
            ),
        ];
        let now = db::now();
        let mut sets = String::new();
        let mut values = Vec::new();
        for (column, changed, value) in fields {
            if changed {
                sets.push_str(&format!("{column}=?, "));
                values.push(value);
            }
        }
        values.extend([now.clone().into(), self.id.into()]);
        conn.execute(
            &format!("UPDATE bookmarks SET {sets}updated_at=?, revision=revision+1 WHERE id=?"),
            rusqlite::params_from_iter(values),
        )?;
        if b.tags != a.tags {
            conn.execute("DELETE FROM bookmark_tags WHERE bookmark_id=?1", [self.id])?;
            db::link_tags(conn, self.id, &b.tags, &now)?;
        }
        Ok(())
    }
}

struct Command {
    id: i64,
    action: Action,
    changes: Vec<Change>,
}

#[derive(Default)]
pub struct Journal {
    /// The newest last.
    commands: VecDeque<Command>,
    last: i64,
}

impl Journal {
    /// Runs a command on the bookmarks `ids` and remembers what it changed.
    /// `work` returns the bookmarks as it left them. The command id is none
    /// when nothing changed: there is nothing to undo.
    pub fn record(
        &mut self,
        conn: &Connection,
        action: Action,
        ids: &[i64],
        work: impl FnOnce(&Connection) -> Result<Vec<Bookmark>>,
    ) -> Result<(Vec<Bookmark>, Option<i64>)> {
        let before: HashMap<i64, Fields> = db::get_bookmarks_by_ids(conn, ids)?
            .iter()
            .map(|b| (b.id, b.into()))
            .collect();
        let bookmarks = work(conn)?;
        let changes: Vec<Change> = bookmarks
            .iter()
            .filter_map(|b| {
                let before = before.get(&b.id)?.clone();
                let after = Fields::from(b);
                (before != after).then_some(Change {
                    id: b.id,
                    before,
                    after,
                })
            })
            .collect();
        if changes.is_empty() {
            return Ok((bookmarks, None));
        }
        self.last += 1;
        self.commands.push_back(Command {
            id: self.last,
            action,
            changes,
        });
        if self.commands.len() > LIMIT {
            self.commands.pop_front();
        }
        Ok((bookmarks, Some(self.last)))
    }

    /// Takes back the last command, or `command` (an undo notice names its
    /// own). All of it or nothing, in one transaction. A failed write keeps
    /// the command for another try; a conflict drops it.
    pub fn undo(&mut self, conn: &Connection, command: Option<i64>) -> Result<Undo> {
        let position = match command {
            None => self.commands.len().checked_sub(1),
            Some(id) => self.commands.iter().position(|c| c.id == id),
        };
        let Some(position) = position else {
            return Ok(Undo::Nothing);
        };
        let outcome = put_back(conn, &self.commands[position])?;
        self.commands.remove(position);
        Ok(outcome)
    }
}

fn put_back(conn: &Connection, command: &Command) -> Result<Undo> {
    let action = command.action;
    let ids: Vec<i64> = command.changes.iter().map(|c| c.id).collect();
    let tx = conn.unchecked_transaction()?;
    let mut now: HashMap<i64, Bookmark> = db::get_bookmarks_by_ids(&tx, &ids)?
        .into_iter()
        .map(|b| (b.id, b))
        .collect();
    for change in &command.changes {
        let Some(current) = now.get(&change.id) else {
            let title = change.after.title.clone();
            return Ok(Undo::Gone { action, title });
        };
        let title = current.title.clone();
        if !change.holds(&current.into()) {
            return Ok(Undo::Conflict { action, title });
        }
        let moved = change.before.collection_id != change.after.collection_id;
        if let (true, Some(collection)) = (moved, change.before.collection_id) {
            let exists: bool = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM collections WHERE id=?1)",
                [collection],
                |r| r.get(0),
            )?;
            if !exists {
                return Ok(Undo::NoCollection { action, title });
            }
        }
    }
    for change in &command.changes {
        change.rewind(&tx)?;
    }
    for b in db::get_bookmarks_by_ids(&tx, &ids)? {
        now.insert(b.id, b);
    }
    tx.commit()?;
    let bookmarks = ids.iter().filter_map(|id| now.remove(id)).collect();
    Ok(Undo::Undone { action, bookmarks })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{
        create_collection, delete_collection, enrich_bookmark, get_bookmark_by_id, get_bookmarks,
        get_counts, insert_or_update_bookmark, purge_trash, restore_bookmark, trash_bookmark,
        update_bookmark, BookmarkQuery, Purge, Source,
    };

    fn library() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::library::configure(&conn).unwrap();
        crate::migrations::migrate(&mut conn, None).unwrap();
        conn
    }

    /// A captured link: it waits in the inbox.
    fn captured(conn: &Connection, path: &str, tags: &[&str]) -> Bookmark {
        let tags: Vec<String> = tags.iter().map(|t| t.to_string()).collect();
        insert_or_update_bookmark(
            conn,
            &format!("https://example.com/{path}"),
            path,
            None,
            None,
            None,
            "example.com",
            None,
            Some(&tags),
            Source::Chrome,
        )
        .unwrap()
    }

    /// A patch of `update_bookmark`, as the command records it.
    #[allow(clippy::type_complexity)]
    fn edit(
        journal: &mut Journal,
        conn: &Connection,
        action: Action,
        id: i64,
        patch: (
            Option<&str>,
            Option<&str>,
            Option<bool>,
            Option<Option<i64>>,
            Option<&[&str]>,
        ),
    ) -> Option<i64> {
        let (title, notes, favorite, collection, tags) = patch;
        journal
            .record(conn, action, &[id], |conn| {
                update_bookmark(
                    conn,
                    id,
                    title.map(Into::into),
                    notes.map(Into::into),
                    favorite,
                    collection,
                    tags.map(|t| t.iter().map(|s| s.to_string()).collect()),
                )
                .map(|b| vec![b])
            })
            .unwrap()
            .1
    }

    fn trash(journal: &mut Journal, conn: &Connection, id: i64) -> Option<i64> {
        let work = |conn: &Connection| trash_bookmark(conn, id).map(|b| vec![b]);
        journal.record(conn, Action::Trash, &[id], work).unwrap().1
    }

    fn restore(journal: &mut Journal, conn: &Connection, id: i64) -> Option<i64> {
        let work = |conn: &Connection| restore_bookmark(conn, id, false).map(|b| vec![b]);
        journal
            .record(conn, Action::Restore, &[id], work)
            .unwrap()
            .1
    }

    fn undone(outcome: Undo) -> Vec<Bookmark> {
        match outcome {
            Undo::Undone { bookmarks, .. } => bookmarks,
            other => panic!("expected an undo, got {other:?}"),
        }
    }

    fn search(conn: &Connection, words: &str) -> usize {
        let query = BookmarkQuery {
            search: Some(words.into()),
            ..Default::default()
        };
        get_bookmarks(conn, &query).unwrap().items.len()
    }

    #[test]
    fn an_edit_comes_back_whole_and_back_to_the_inbox() {
        let conn = library();
        let mut journal = Journal::default();
        let shelf = create_collection(&conn, "Железо", None, None).unwrap();
        let original = captured(&conn, "ledger", &["кошелёк", "аппарат"]);
        assert_eq!(get_counts(&conn).unwrap().inbox, 1);

        let tags: &[&str] = &["крипта"];
        let command = edit(
            &mut journal,
            &conn,
            Action::Edit,
            original.id,
            (
                Some("Ledger Nano"),
                Some("Купить"),
                Some(true),
                Some(Some(shelf.id)),
                Some(tags),
            ),
        );
        assert!(command.is_some());
        let decided = get_bookmark_by_id(&conn, original.id).unwrap();
        assert!(decided.triaged_at.is_some());
        assert_eq!(get_counts(&conn).unwrap().inbox, 0);

        let back = undone(journal.undo(&conn, None).unwrap()).remove(0);
        assert_eq!(back.title, original.title);
        assert_eq!(back.notes, None);
        assert!(!back.is_favorite);
        assert_eq!(back.collection_id, None);
        assert_eq!(back.tags, original.tags, "the same tags in the same order");
        assert_eq!(back.triaged_at, None, "the decision is taken back");
        assert_eq!(back.revision, decided.revision + 1);
        let counts = get_counts(&conn).unwrap();
        assert_eq!((counts.inbox, counts.favorites), (1, 0));
        // The search index follows the undo.
        assert_eq!(search(&conn, "nano"), 0);
        assert_eq!(search(&conn, "крипта"), 0);
        assert_eq!(search(&conn, "кошелек"), 1);
        assert!(matches!(journal.undo(&conn, None).unwrap(), Undo::Nothing));
    }

    #[test]
    fn every_kind_of_command_is_undone() {
        let conn = library();
        let mut journal = Journal::default();
        let shelf = create_collection(&conn, "Полка", None, None).unwrap();
        let b = captured(&conn, "page", &["один"]);
        // Sorted already, so the inbox flag does not change below.
        edit(
            &mut journal,
            &conn,
            Action::Edit,
            b.id,
            (None, Some("решено"), None, None, None),
        );
        let start = get_bookmark_by_id(&conn, b.id).unwrap();

        let star = (None, None, Some(true), None, None);
        edit(&mut journal, &conn, Action::Favorite, b.id, star);
        assert!(!undone(journal.undo(&conn, None).unwrap())[0].is_favorite);

        let into = (None, None, None, Some(Some(shelf.id)), None);
        edit(&mut journal, &conn, Action::Move, b.id, into);
        let out = (None, None, None, Some(None), None);
        edit(&mut journal, &conn, Action::Move, b.id, out);
        let moved = journal.undo(&conn, None).unwrap();
        assert_eq!(undone(moved)[0].collection_id, Some(shelf.id));
        assert_eq!(
            undone(journal.undo(&conn, None).unwrap())[0].collection_id,
            None
        );

        let tags: &[&str] = &["один", "два"];
        edit(
            &mut journal,
            &conn,
            Action::Tag,
            b.id,
            (None, None, None, None, Some(tags)),
        );
        let tagged = undone(journal.undo(&conn, None).unwrap()).remove(0);
        assert_eq!(tagged.tags.unwrap(), ["один"]);

        trash(&mut journal, &conn, b.id);
        assert_eq!(get_counts(&conn).unwrap().trash, 1);
        let back = undone(journal.undo(&conn, None).unwrap()).remove(0);
        assert_eq!(back.deleted_at, None);
        assert_eq!(get_counts(&conn).unwrap().trash, 0);

        trash(&mut journal, &conn, b.id);
        let thrown = get_bookmark_by_id(&conn, b.id).unwrap().deleted_at;
        restore(&mut journal, &conn, b.id);
        let again = undone(journal.undo(&conn, None).unwrap()).remove(0);
        assert_eq!(
            again.deleted_at, thrown,
            "back in the trash since the same time"
        );
        undone(journal.undo(&conn, None).unwrap());

        let end = get_bookmark_by_id(&conn, b.id).unwrap();
        assert_eq!(Fields::from(&end), Fields::from(&start));
    }

    #[test]
    fn the_last_by_default_or_the_one_named() {
        let conn = library();
        let mut journal = Journal::default();
        let first = captured(&conn, "first", &[]);
        let second = captured(&conn, "second", &[]);
        let star = (None, None, Some(true), None, None);
        let starred = edit(&mut journal, &conn, Action::Favorite, first.id, star);
        let thrown = trash(&mut journal, &conn, second.id);

        // An undo notice names its own command, even when it is not the last.
        let back = undone(journal.undo(&conn, starred).unwrap());
        assert_eq!((back[0].id, back[0].is_favorite), (first.id, false));
        assert!(get_bookmark_by_id(&conn, second.id)
            .unwrap()
            .deleted_at
            .is_some());
        assert!(matches!(
            journal.undo(&conn, starred).unwrap(),
            Undo::Nothing
        ));
        assert!(matches!(
            journal.undo(&conn, Some(99)).unwrap(),
            Undo::Nothing
        ));

        // Ctrl Z takes the last one.
        let back = undone(journal.undo(&conn, None).unwrap());
        assert_eq!(
            (back[0].id, back[0].deleted_at.as_deref()),
            (second.id, None)
        );
        assert!(matches!(
            journal.undo(&conn, thrown).unwrap(),
            Undo::Nothing
        ));

        // A command that changed nothing is not recorded.
        trash(&mut journal, &conn, second.id);
        assert_eq!(trash(&mut journal, &conn, second.id), None);
        assert_eq!(journal.commands.len(), 1);
    }

    #[test]
    fn later_metadata_stays_and_a_later_decision_wins() {
        let conn = library();
        let mut journal = Journal::default();
        let b = captured(&conn, "late", &[]);
        let star = (None, None, Some(true), None, None);
        edit(&mut journal, &conn, Action::Favorite, b.id, star);
        // Metadata of the page arrives after the decision: undo keeps it.
        let meta = crate::metadata::PageMetadata {
            title: Some("Не применится".into()),
            description: Some("Описание".into()),
            ..Default::default()
        };
        enrich_bookmark(&conn, b.id, b.revision, &meta).unwrap();
        let back = undone(journal.undo(&conn, None).unwrap()).remove(0);
        assert_eq!(back.description.as_deref(), Some("Описание"));
        assert!(!back.is_favorite);
        assert_eq!(back.triaged_at, None);

        // Saved again from the trash by the extension: undoing «to the
        // trash» would throw that save away. Nothing changes, the command goes.
        let thrown = trash(&mut journal, &conn, b.id);
        restore_bookmark(&conn, b.id, true).unwrap();
        let before = get_bookmark_by_id(&conn, b.id).unwrap();
        match journal.undo(&conn, None).unwrap() {
            Undo::Conflict { action, title } => {
                assert_eq!((action, title.as_str()), (Action::Trash, "late"));
            }
            other => panic!("expected a conflict, got {other:?}"),
        }
        let after = get_bookmark_by_id(&conn, b.id).unwrap();
        assert_eq!(after.revision, before.revision, "nothing written");
        assert!(matches!(
            journal.undo(&conn, thrown).unwrap(),
            Undo::Nothing
        ));
    }

    #[test]
    fn a_conflict_on_one_bookmark_leaves_every_other_as_it_is() {
        let conn = library();
        let mut journal = Journal::default();
        let one = captured(&conn, "one", &[]);
        let two = captured(&conn, "two", &[]);
        // One command over two bookmarks, as a bulk action will be (NP-029).
        let ids = [one.id, two.id];
        journal
            .record(&conn, Action::Trash, &ids, |conn| {
                ids.iter().map(|&id| trash_bookmark(conn, id)).collect()
            })
            .unwrap();
        restore_bookmark(&conn, two.id, false).unwrap();
        assert!(matches!(
            journal.undo(&conn, None).unwrap(),
            Undo::Conflict { .. }
        ));
        assert!(get_bookmark_by_id(&conn, one.id)
            .unwrap()
            .deleted_at
            .is_some());

        // Without the conflict both come back in one go.
        restore_bookmark(&conn, one.id, false).unwrap();
        journal
            .record(&conn, Action::Trash, &ids, |conn| {
                ids.iter().map(|&id| trash_bookmark(conn, id)).collect()
            })
            .unwrap();
        let back = undone(journal.undo(&conn, None).unwrap());
        assert_eq!(back.iter().map(|b| b.id).collect::<Vec<_>>(), ids);
        assert!(back.iter().all(|b| b.deleted_at.is_none()));
        assert_eq!(get_counts(&conn).unwrap().trash, 0);
    }

    #[test]
    fn a_bookmark_or_collection_deleted_for_good_cannot_come_back() {
        let conn = library();
        let mut journal = Journal::default();
        let shelf = create_collection(&conn, "Временная", None, None).unwrap();
        let other = create_collection(&conn, "Другая", None, None).unwrap();
        let b = captured(&conn, "shelved", &[]);
        let into = (None, None, None, Some(Some(shelf.id)), None);
        edit(&mut journal, &conn, Action::Move, b.id, into);
        let away = (None, None, None, Some(Some(other.id)), None);
        edit(&mut journal, &conn, Action::Move, b.id, away);
        delete_collection(&conn, shelf.id).unwrap();
        match journal.undo(&conn, None).unwrap() {
            Undo::NoCollection { action, title } => {
                assert_eq!((action, title.as_str()), (Action::Move, "shelved"));
            }
            other => panic!("expected a missing collection, got {other:?}"),
        }
        assert_eq!(
            get_bookmark_by_id(&conn, b.id).unwrap().collection_id,
            Some(other.id)
        );
        // Moving into the deleted one: the bookmark is no longer there.
        assert!(matches!(
            journal.undo(&conn, None).unwrap(),
            Undo::Conflict { .. }
        ));

        trash(&mut journal, &conn, b.id);
        purge_trash(&conn, Purge::One(b.id)).unwrap();
        match journal.undo(&conn, None).unwrap() {
            Undo::Gone { action, title } => {
                assert_eq!((action, title.as_str()), (Action::Trash, "shelved"));
            }
            other => panic!("expected a bookmark gone, got {other:?}"),
        }
        assert!(journal.commands.is_empty());
    }

    #[test]
    fn a_failed_write_keeps_the_command_for_another_try() {
        let conn = library();
        let mut journal = Journal::default();
        let b = captured(&conn, "busy", &["тег"]);
        let tags: &[&str] = &["другой"];
        let change = (Some("Новое"), None, Some(true), None, Some(tags));
        edit(&mut journal, &conn, Action::Edit, b.id, change);
        let decided = get_bookmark_by_id(&conn, b.id).unwrap();
        conn.execute_batch("PRAGMA query_only = ON").unwrap();
        assert!(journal.undo(&conn, None).is_err());
        conn.execute_batch("PRAGMA query_only = OFF").unwrap();
        let unchanged = get_bookmark_by_id(&conn, b.id).unwrap();
        assert_eq!(Fields::from(&unchanged), Fields::from(&decided));
        assert_eq!(unchanged.revision, decided.revision);
        assert_eq!(undone(journal.undo(&conn, None).unwrap())[0].title, "busy");
    }

    #[test]
    fn the_journal_keeps_the_last_hundred() {
        let conn = library();
        let mut journal = Journal::default();
        let b = captured(&conn, "often", &[]);
        let mut commands = Vec::new();
        for i in 0..=LIMIT {
            let star = (None, None, Some(i % 2 == 0), None, None);
            commands.push(edit(&mut journal, &conn, Action::Favorite, b.id, star));
        }
        assert_eq!(journal.commands.len(), LIMIT);
        assert!(matches!(
            journal.undo(&conn, commands[0]).unwrap(),
            Undo::Nothing
        ));
        for _ in 0..LIMIT {
            undone(journal.undo(&conn, None).unwrap());
        }
        assert!(matches!(journal.undo(&conn, None).unwrap(), Undo::Nothing));
        // Back to how the oldest command kept left it.
        assert!(get_bookmark_by_id(&conn, b.id).unwrap().is_favorite);
    }

    #[test]
    fn undo_outcomes_reach_the_interface_tagged() {
        let json = serde_json::to_value(Undo::Conflict {
            action: Action::Trash,
            title: "Т".into(),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "outcome": "conflict", "action": "trash", "title": "Т" })
        );
        let nothing = serde_json::to_value(Undo::Nothing).unwrap();
        assert_eq!(nothing, serde_json::json!({ "outcome": "nothing" }));
    }
}
