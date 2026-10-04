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
/// Bookmarks the kept commands may hold together: bulk actions (NP-029) of
/// thousands each would otherwise hold the library several times in memory.
/// The newest command is kept whatever its size.
pub const CHANGE_LIMIT: usize = 50_000;

/// What a command did, for the words of the undo notice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, rename = "CommandAction")]
pub enum Action {
    /// «Оставить» in triage: only the decision (NP-025).
    Keep,
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
    /// Forgets every command: after the library was replaced (NP-033) they
    /// would point at bookmarks that are no longer there.
    pub fn clear(&mut self) {
        self.commands.clear();
    }

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
        let mut held: usize = self.commands.iter().map(|c| c.changes.len()).sum();
        while held > CHANGE_LIMIT && self.commands.len() > 1 {
            held -= self.commands.pop_front().map_or(0, |c| c.changes.len());
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
        all_favorite, apply_bulk, bulk_into_new_collection, create_collection, delete_collection,
        next_collection_id,
        enrich_bookmark, get_bookmark_by_id, get_bookmarks, get_counts, insert_or_update_bookmark,
        purge_trash, restore_bookmark, trash_bookmark, update_bookmark, Bulk, BookmarkQuery,
        Purge, Source,
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

        // «Оставить» in triage changes only the decision.
        let fresh = captured(&conn, "fresh", &[]);
        let kept = edit(
            &mut journal,
            &conn,
            Action::Keep,
            fresh.id,
            (None, None, None, None, None),
        );
        assert!(kept.is_some());
        assert!(get_bookmark_by_id(&conn, fresh.id)
            .unwrap()
            .triaged_at
            .is_some());
        assert_eq!(
            undone(journal.undo(&conn, None).unwrap())[0].triaged_at,
            None
        );

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

    /// A bulk action as the command records it (NP-029).
    fn bulk(journal: &mut Journal, conn: &Connection, action: Action, ids: &[i64], change: Bulk) -> (usize, Vec<Bookmark>, Option<i64>) {
        let mut count = 0;
        let (changed, command) = journal
            .record(conn, action, ids, |conn| {
                apply_bulk(conn, ids, &change).map(|(n, changed)| {
                    count = n;
                    changed
                })
            })
            .unwrap();
        (count, changed, command)
    }

    fn snapshot(conn: &Connection, ids: &[i64]) -> Vec<(Fields, i64)> {
        ids.iter()
            .map(|&id| {
                let b = get_bookmark_by_id(conn, id).unwrap();
                (Fields::from(&b), b.revision)
            })
            .collect()
    }

    #[test]
    fn a_bulk_action_is_one_command_undone_whole() {
        let conn = library();
        let mut journal = Journal::default();
        let work = create_collection(&conn, "Работа", None, None).unwrap();
        let home = create_collection(&conn, "Дом", None, None).unwrap();
        let a = captured(&conn, "a", &["старый"]);
        let b = captured(&conn, "b", &[]);
        let c = captured(&conn, "c", &[]);
        let ids = [a.id, b.id, c.id];
        bulk(&mut journal, &conn, Action::Move, &[c.id], Bulk::Move(Some(home.id)));
        let start = snapshot(&conn, &ids);

        // Into «Работа», tagged and starred: three commands, each over all three.
        let (count, changed, moved) = bulk(&mut journal, &conn, Action::Move, &ids, Bulk::Move(Some(work.id)));
        assert_eq!((count, changed.len()), (3, 3));
        assert!(changed.iter().all(|b| b.collection_id == Some(work.id) && b.triaged_at.is_some()));
        assert_eq!(get_counts(&conn).unwrap().inbox, 0, "a decision sorts them out of the inbox");
        let (_, tagged, _) = bulk(&mut journal, &conn, Action::Tag, &ids, Bulk::Tag(" Crypto ".into()));
        assert!(tagged.iter().all(|b| b.tags.as_ref().unwrap().contains(&"crypto".to_string())));
        assert_eq!(get_bookmark_by_id(&conn, a.id).unwrap().tags.unwrap(), ["старый", "crypto"]);
        assert_eq!(search(&conn, "crypto"), 3, "the search index follows the tag");
        let (_, starred, _) = bulk(&mut journal, &conn, Action::Favorite, &ids, Bulk::Favorite(true));
        assert_eq!(starred.len(), 3);

        // Those already as asked are counted, not changed, and keep their revision.
        let before = get_bookmark_by_id(&conn, a.id).unwrap().revision;
        let (count, again, command) = bulk(&mut journal, &conn, Action::Favorite, &ids, Bulk::Favorite(true));
        assert_eq!((count, again.len(), command), (3, 0, None));
        assert_eq!(get_bookmark_by_id(&conn, a.id).unwrap().revision, before);

        // Ctrl Z three times: star, tag, collection, the inbox included.
        for _ in 0..3 {
            assert_eq!(undone(journal.undo(&conn, None).unwrap()).len(), 3);
        }
        let back: Vec<Fields> = snapshot(&conn, &ids).into_iter().map(|(f, _)| f).collect();
        assert_eq!(back, start.iter().map(|(f, _)| f.clone()).collect::<Vec<_>>());
        assert_eq!(get_counts(&conn).unwrap().inbox, 2);
        assert_eq!(search(&conn, "crypto"), 0);
        assert!(matches!(journal.undo(&conn, moved).unwrap(), Undo::Nothing));
    }

    #[test]
    fn trash_and_restore_in_bulk_leave_the_rest_alone() {
        let conn = library();
        let mut journal = Journal::default();
        let a = captured(&conn, "a", &[]);
        let b = captured(&conn, "b", &[]);
        let gone = captured(&conn, "gone", &[]);
        trash_bookmark(&conn, gone.id).unwrap();
        purge_trash(&conn, Purge::One(gone.id)).unwrap();
        let ids = [a.id, b.id, gone.id];

        let (count, changed, _) = bulk(&mut journal, &conn, Action::Trash, &ids, Bulk::Trash);
        assert_eq!((count, changed.len()), (2, 2), "a bookmark gone for good is skipped");
        assert!(changed.iter().all(|b| b.deleted_at.is_some() && b.triaged_at.is_none()), "the inbox flag stays for a restore");
        let counts = get_counts(&conn).unwrap();
        assert_eq!((counts.trash, counts.inbox), (2, 0));
        // Moving bookmarks in the trash changes nothing: only restore reaches there.
        let (count, changed, command) = bulk(&mut journal, &conn, Action::Move, &ids, Bulk::Move(None));
        assert_eq!((count, changed.len(), command), (0, 0, None));
        // A tag that nothing gets is not created.
        let (count, changed, command) = bulk(&mut journal, &conn, Action::Tag, &ids, Bulk::Tag("пусто".into()));
        assert_eq!((count, changed.len(), command), (0, 0, None));
        let empty: i64 = conn.query_row("SELECT count(*) FROM tags WHERE name = 'пусто'", [], |r| r.get(0)).unwrap();
        assert_eq!(empty, 0, "no empty tag is left behind");

        let (count, restored, _) = bulk(&mut journal, &conn, Action::Restore, &[a.id], Bulk::Restore);
        assert_eq!((count, restored.len()), (1, 1));
        assert_eq!(get_counts(&conn).unwrap().inbox, 1, "back in the inbox it was in");
        // Ctrl Z: back to the trash, then out of it.
        undone(journal.undo(&conn, None).unwrap());
        assert_eq!(get_counts(&conn).unwrap().trash, 2);
        undone(journal.undo(&conn, None).unwrap());
        assert_eq!(get_counts(&conn).unwrap().trash, 0);

        // Deleting the selection for good takes only what is in the trash.
        bulk(&mut journal, &conn, Action::Trash, &[a.id], Bulk::Trash);
        let purged = purge_trash(&conn, Purge::Some(&[a.id, b.id])).unwrap();
        assert_eq!(purged.iter().map(|p| p.0).collect::<Vec<_>>(), [a.id]);
        assert!(get_bookmark_by_id(&conn, b.id).is_ok());
    }

    #[test]
    fn a_failed_bulk_action_leaves_nothing_behind() {
        let conn = library();
        let mut journal = Journal::default();
        let work = create_collection(&conn, "Работа", None, None).unwrap();
        let ids: Vec<i64> = (0..5).map(|i| captured(&conn, &format!("p{i}"), &["был"]).id).collect();
        let start = snapshot(&conn, &ids);
        let collections = crate::db::get_collections(&conn).unwrap().len();
        // The write fails on the fourth bookmark, after three were written.
        conn.execute_batch(&format!(
            "CREATE TEMP TRIGGER fail BEFORE UPDATE ON bookmarks WHEN NEW.id = {}
             BEGIN SELECT RAISE(ABORT, 'disk I/O'); END;",
            ids[3]
        ))
        .unwrap();
        for change in [
            Bulk::Move(Some(work.id)),
            Bulk::Tag("новый".into()),
            Bulk::Favorite(true),
            Bulk::Trash,
        ] {
            let failed = journal.record(&conn, Action::Edit, &ids, |conn| apply_bulk(conn, &ids, &change).map(|(_, c)| c));
            assert!(failed.is_err(), "{change:?} must fail");
            assert_eq!(snapshot(&conn, &ids), start, "{change:?} left a partial result");
        }
        assert!(bulk_into_new_collection(&conn, &ids, "Пустая").is_err());
        assert_eq!(crate::db::get_collections(&conn).unwrap().len(), collections, "no empty collection is left");
        assert_eq!(search(&conn, "новый"), 0);
        assert!(journal.commands.is_empty(), "nothing to undo");

        // A collection deleted meanwhile: nothing moves.
        conn.execute_batch("DROP TRIGGER fail").unwrap();
        delete_collection(&conn, work.id).unwrap();
        let moved = journal.record(&conn, Action::Move, &ids, |conn| apply_bulk(conn, &ids, &Bulk::Move(Some(work.id))).map(|(_, c)| c));
        assert_eq!(crate::error::code_of(&moved.err().unwrap()), crate::error::ErrorCode::NotFound);
        assert_eq!(snapshot(&conn, &ids), start);
    }

    #[test]
    fn the_bar_asks_for_the_star_of_the_selected_and_the_next_collection_id() {
        let conn = library();
        let mut journal = Journal::default();
        let a = captured(&conn, "a", &[]);
        let b = captured(&conn, "b", &[]);
        assert!(!all_favorite(&conn, &[]).unwrap(), "nothing selected has no star");
        bulk(&mut journal, &conn, Action::Favorite, &[a.id], Bulk::Favorite(true));
        assert!(all_favorite(&conn, &[a.id]).unwrap());
        assert!(!all_favorite(&conn, &[a.id, b.id]).unwrap());
        // One in the trash does not count: it is not where the bar is.
        trash_bookmark(&conn, b.id).unwrap();
        assert!(all_favorite(&conn, &[a.id, b.id]).unwrap());

        // AUTOINCREMENT: the id of a deleted newest collection is not reused.
        let first = create_collection(&conn, "Первая", None, None).unwrap();
        let second = create_collection(&conn, "Вторая", None, None).unwrap();
        assert_eq!(next_collection_id(&conn).unwrap(), second.id + 1);
        delete_collection(&conn, second.id).unwrap();
        assert_eq!(next_collection_id(&conn).unwrap(), second.id + 1);
        assert_eq!(create_collection(&conn, "Третья", None, None).unwrap().id, second.id + 1);
        assert!(first.id < second.id);
    }

    #[test]
    fn a_new_collection_from_the_selection_is_one_action() {
        let conn = library();
        let mut journal = Journal::default();
        let ids: Vec<i64> = (0..3).map(|i| captured(&conn, &format!("n{i}"), &[]).id).collect();
        let mut made = None;
        let (changed, command) = journal
            .record(&conn, Action::Move, &ids, |conn| {
                bulk_into_new_collection(conn, &ids, "Из выбранного").map(|(collection, _, changed)| {
                    made = Some(collection);
                    changed
                })
            })
            .unwrap();
        let made = made.unwrap();
        assert_eq!((made.name.as_str(), made.count), ("Из выбранного", Some(3)));
        assert!(changed.iter().all(|b| b.collection_id == Some(made.id)));
        let back = undone(journal.undo(&conn, command).unwrap());
        assert!(back.iter().all(|b| b.collection_id.is_none() && b.triaged_at.is_none()));
    }

    #[test]
    fn a_thousand_bookmarks_in_one_go_and_the_journal_keeps_its_size() {
        let conn = library();
        let mut journal = Journal::default();
        let shelf = create_collection(&conn, "Полка", None, None).unwrap();
        conn.execute_batch(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
             INSERT INTO bookmarks (uid, url, title, domain, created_at, updated_at)
             SELECT 'u' || i, 'https://example.com/' || i, 'Запись ' || i, 'example.com',
                    '2026-10-04T12:00:00.000Z', '2026-10-04T12:00:00.000Z' FROM n;",
        )
        .unwrap();
        let ids: Vec<i64> = conn
            .prepare("SELECT id FROM bookmarks")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_>>()
            .unwrap();
        let started = std::time::Instant::now();
        let (count, changed, _) = bulk(&mut journal, &conn, Action::Move, &ids, Bulk::Move(Some(shelf.id)));
        let (_, tagged, _) = bulk(&mut journal, &conn, Action::Tag, &ids, Bulk::Tag("пачка".into()));
        let took = started.elapsed();
        assert_eq!((count, changed.len(), tagged.len()), (1000, 1000, 1000));
        assert_eq!(search(&conn, "пачка"), 100, "the first page of the search");
        let started = std::time::Instant::now();
        assert_eq!(undone(journal.undo(&conn, None).unwrap()).len(), 1000);
        println!("1000 bookmarks: move + tag {took:?}, undo {:?}", started.elapsed());

        // Commands of a thousand each: the oldest go once they hold too many.
        for i in 0..(CHANGE_LIMIT / 1000 + 5) {
            bulk(&mut journal, &conn, Action::Favorite, &ids, Bulk::Favorite(i % 2 == 0));
        }
        let held: usize = journal.commands.iter().map(|c| c.changes.len()).sum();
        assert!(held <= CHANGE_LIMIT, "{held} bookmarks held");
        assert_eq!(journal.commands.len(), CHANGE_LIMIT / 1000);
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
