//! Duplicates (NP-035, Р-35, sheet 34): the same page saved more than once.
//!
//! Every bookmark has a key of its address (`url_key`, schema 5) where the
//! differences that do not change the page are set aside. Bookmarks outside
//! the trash with the same key are a group, unless the person said they are
//! different pages. Merging keeps one bookmark with everything the others
//! held; the others go to the trash. Nothing happens on its own.

use crate::db::{self, Bookmark};
use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use ts_rs::TS;
use url::Url;

/// Query parameters that only say where a click came from; `utm_*` too.
const TRACKING: &[&str] = &[
    "fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "mc_eid", "mc_cid", "igshid",
];

fn tracking(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.starts_with("utm_") || TRACKING.contains(&name.as_str())
}

/// The address with what does not change the page set aside: http or
/// https, `www.`, the case of the host, a default port, the last slash, the
/// `#part`, tracking parameters and the order of the others. «tropicsquare.com/chips»
/// for every spelling of that page; none for what is not a web address.
pub fn url_key(raw: &str) -> Option<String> {
    let url = Url::parse(raw.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host_str()?.to_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    let path = url.path().trim_end_matches('/');
    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(name, _)| !tracking(name))
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect();
    pairs.sort();
    let query = if pairs.is_empty() {
        String::new()
    } else {
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        query.extend_pairs(&pairs);
        format!("?{}", query.finish())
    };
    Some(format!("{host}{port}{path}{query}"))
}

/// How far the address is from the plain one: http, `www.`, a `#part`,
/// tracking parameters. The main bookmark of a group has the least.
fn clutter(raw: &str) -> usize {
    let Ok(url) = Url::parse(raw) else { return usize::MAX };
    usize::from(url.scheme() == "http")
        + usize::from(url.host_str().is_some_and(|h| h.starts_with("www.")))
        + usize::from(url.fragment().is_some())
        + usize::from(url.query_pairs().any(|(name, _)| tracking(&name)))
}

/// Keys for bookmarks written without one: by an older build, a test or
/// another program. Cheap when there are none.
pub fn fill_keys(conn: &Connection) -> Result<usize> {
    conn.execute(
        "UPDATE bookmarks SET url_key = np_url_key(url) WHERE url_key IS NULL",
        [],
    )
}

/// Keys of the groups: two or more bookmarks outside the trash, at least one
/// of them not set aside by «Не дубликаты».
const GROUP_KEYS: &str = "
SELECT g.url_key FROM (
    SELECT url_key, MAX(created_at) AS newest FROM bookmarks
    WHERE deleted_at IS NULL AND url_key IS NOT NULL
    GROUP BY url_key HAVING count(*) > 1
) g
WHERE EXISTS (
    SELECT 1 FROM bookmarks b
    WHERE b.url_key = g.url_key AND b.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM duplicates_dismissed d WHERE d.url_key = b.url_key AND d.uid = b.uid)
)
ORDER BY g.newest DESC, g.url_key";

/// Groups for the sidebar and the menu «⋯».
pub fn count(conn: &Connection) -> Result<i64> {
    conn.query_row(&format!("SELECT count(*) FROM ({GROUP_KEYS})"), [], |r| r.get(0))
}

/// Bookmarks with the same address (sheet 34).
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct DuplicateGroup {
    /// The address without what does not change the page: the group's title.
    pub key: String,
    /// The one merging keeps by default: the plainest address, then the oldest.
    pub main: i64,
    /// The main one first, then by when they were saved.
    pub bookmarks: Vec<Bookmark>,
}

/// The groups, the newest duplicate first.
pub fn groups(conn: &Connection) -> Result<Vec<DuplicateGroup>> {
    let keys: Vec<String> = conn
        .prepare(GROUP_KEYS)?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_>>()?;
    let mut members = conn.prepare("SELECT id FROM bookmarks WHERE url_key = ?1 AND deleted_at IS NULL")?;
    keys.into_iter()
        .map(|key| {
            let ids: Vec<i64> = members.query_map([&key], |r| r.get(0))?.collect::<Result<_>>()?;
            let mut bookmarks = db::get_bookmarks_by_ids(conn, &ids)?;
            bookmarks.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
            let main = bookmarks
                .iter()
                .enumerate()
                .min_by_key(|(order, b)| (clutter(&b.url), *order))
                .map(|(order, _)| order)
                .unwrap_or(0);
            let first = bookmarks.remove(main);
            bookmarks.insert(0, first);
            Ok(DuplicateGroup { key, main: bookmarks[0].id, bookmarks })
        })
        .collect()
}

/// One group to merge: the bookmark that stays and those that go.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct MergeGroup {
    pub main: i64,
    pub others: Vec<i64>,
}

/// A bookmark of a group outside the trash, with the key it belongs to.
fn member(conn: &Connection, id: i64) -> Result<(Bookmark, String)> {
    let key: Option<String> = conn
        .query_row(
            "SELECT url_key FROM bookmarks WHERE id = ?1 AND deleted_at IS NULL",
            [id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let key = key.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    Ok((db::get_bookmark_by_id(conn, id)?, key))
}

/// Merges each group in one transaction: the main bookmark gets every tag,
/// every note, the star, a collection if it had none, the earliest save time
/// and a decision if any of them had one; the others go to the trash. A
/// bookmark gone, in the trash or no longer of the same address fails the
/// whole call with `not_found`: nothing is written. Returns every bookmark
/// changed, for the journal and the events.
///
/// With sync on (Р-68) each of these is an ordinary edit: the main bookmark's
/// fields and tags that change, the others' move to the trash, so every
/// device shows the same merge with the others in its trash, and Ctrl Z
/// works as without sync. They are not tombstones `merged_into` the main
/// one: the engine means by that a record with the same address, folds the
/// later fields of the merged one into the survivor (the others' trash time
/// and address would win there) and is final, while this merge is undone by
/// a restore from the trash. Emptying the trash later purges them as any.
pub fn merge(conn: &Connection, groups: &[MergeGroup]) -> Result<Vec<Bookmark>> {
    let tx = conn.unchecked_transaction()?;
    let now = db::now();
    let mut changed = Vec::new();
    let mut seen = HashSet::new();
    for group in groups {
        if group.others.is_empty() {
            continue;
        }
        if !seen.insert(group.main) {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        let (main, key) = member(&tx, group.main)?;
        let mut others = Vec::new();
        for &id in &group.others {
            let (other, other_key) = member(&tx, id)?;
            if other_key != key || id == group.main || !seen.insert(id) {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            others.push(other);
        }
        others.sort_by(|a, b| a.created_at.cmp(&b.created_at));

        let mut tags = main.tags.clone().unwrap_or_default();
        let mut notes: Vec<String> = main.notes.iter().map(|n| n.trim().to_owned()).filter(|n| !n.is_empty()).collect();
        let mut collection = main.collection_id;
        let mut triaged = main.triaged_at.clone();
        let mut created = main.created_at.clone();
        for other in &others {
            for tag in other.tags.iter().flatten() {
                if !tags.contains(tag) {
                    tags.push(tag.clone());
                }
            }
            if let Some(note) = other.notes.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
                if !notes.iter().any(|n| n == note) {
                    notes.push(note.to_owned());
                }
            }
            collection = collection.or(other.collection_id);
            if triaged.is_none() {
                triaged = other.triaged_at.clone();
            }
            created = created.min(other.created_at.clone());
        }
        let favorite = main.is_favorite || others.iter().any(|o| o.is_favorite);
        let notes = (!notes.is_empty()).then(|| notes.join("\n\n"));
        tx.execute(
            "UPDATE bookmarks SET notes = ?1, is_favorite = ?2, collection_id = ?3, triaged_at = ?4,
                 created_at = ?5, updated_at = ?6, revision = revision + 1 WHERE id = ?7",
            params![notes, favorite, collection, triaged, created, now, main.id],
        )?;
        db::set_tags(&tx, main.id, &tags, &now)?;
        for other in &others {
            db::trash_bookmark(&tx, other.id)?;
        }
        changed.push(main.id);
        changed.extend(others.iter().map(|o| o.id));
    }
    let bookmarks = db::get_bookmarks_by_ids(&tx, &changed)?;
    tx.commit()?;
    Ok(bookmarks)
}

/// «Не дубликаты»: these bookmarks of the group are different pages. The
/// group comes back when another bookmark with the same address arrives.
pub fn dismiss(conn: &Connection, key: &str, ids: &[i64]) -> Result<usize> {
    let ids = db::id_list(ids)?;
    conn.execute(
        "INSERT OR IGNORE INTO duplicates_dismissed (url_key, uid, dismissed_at)
         SELECT url_key, uid, ?3 FROM bookmarks WHERE url_key = ?1 AND id IN (SELECT value FROM json_each(?2))",
        params![key, ids, db::now()],
    )
}

/// «Отменить» after «Не дубликаты»: the group is shown again.
pub fn undismiss(conn: &Connection, key: &str, ids: &[i64]) -> Result<usize> {
    let ids = db::id_list(ids)?;
    conn.execute(
        "DELETE FROM duplicates_dismissed WHERE url_key = ?1
         AND uid IN (SELECT uid FROM bookmarks WHERE id IN (SELECT value FROM json_each(?2)))",
        params![key, ids],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{insert_or_update_bookmark, trash_bookmark, update_bookmark, Source};

    fn library() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::library::configure(&conn).unwrap();
        crate::migrations::migrate(&mut conn, None).unwrap();
        conn
    }

    fn save(conn: &Connection, url: &str, tags: &[&str]) -> Bookmark {
        let tags: Vec<String> = tags.iter().map(|t| t.to_string()).collect();
        insert_or_update_bookmark(conn, url, url, None, None, None, "example.com", None, Some(&tags), Source::Chrome).unwrap()
    }

    fn at(conn: &Connection, id: i64, time: &str) {
        conn.execute("UPDATE bookmarks SET created_at = ?1 WHERE id = ?2", params![time, id]).unwrap();
    }

    #[test]
    fn the_key_sets_aside_what_does_not_change_the_page() {
        // The same cases as duplicates.test.ts, so the demo groups as the app does.
        let cases: serde_json::Value = serde_json::from_str(include_str!("../../tests/fixtures/url-keys.json")).unwrap();
        let list = |name: &str| cases[name].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect::<Vec<_>>();
        let page = cases["key"].as_str().map(String::from);
        for same in list("same") {
            assert_eq!(url_key(&same), page, "{same}");
        }
        for different in list("different") {
            assert_ne!(url_key(&different), page, "{different}");
        }
        // Other parameters stay and their order does not matter.
        for pair in cases["equal"].as_array().unwrap() {
            assert_eq!(url_key(pair[0].as_str().unwrap()), url_key(pair[1].as_str().unwrap()), "{pair}");
        }
        for (url, key) in cases["keys"].as_object().unwrap() {
            assert_eq!(url_key(url).as_deref(), key.as_str(), "{url}");
        }
        assert_eq!(url_key("https://пример.рф/статья").as_deref(), Some("xn--e1afmkfd.xn--p1ai/%D1%81%D1%82%D0%B0%D1%82%D1%8C%D1%8F"));
        for none in list("none") {
            assert_eq!(url_key(&none), None, "{none}");
        }
    }

    #[test]
    fn groups_need_two_outside_the_trash_and_the_plainest_oldest_is_main() {
        let conn = library();
        let a = save(&conn, "https://www.example.com/page?utm_source=x", &[]);
        let b = save(&conn, "https://example.com/page/", &[]);
        let c = save(&conn, "http://example.com/page#top", &[]);
        let alone = save(&conn, "https://example.com/other", &[]);
        let trashed = save(&conn, "https://example.com/other/", &[]);
        trash_bookmark(&conn, trashed.id).unwrap();
        at(&conn, a.id, "2026-01-01T00:00:00.000Z");
        at(&conn, b.id, "2026-02-01T00:00:00.000Z");
        at(&conn, c.id, "2026-03-01T00:00:00.000Z");

        let groups = groups(&conn).unwrap();
        assert_eq!(groups.len(), 1, "a bookmark with its twin in the trash is alone");
        let group = &groups[0];
        assert_eq!(group.key, "example.com/page");
        assert_eq!(group.main, b.id, "the plainest address wins over the oldest");
        let order: Vec<i64> = group.bookmarks.iter().map(|b| b.id).collect();
        assert_eq!(order, [b.id, a.id, c.id]);
        assert_eq!(count(&conn).unwrap(), 1);
        assert!(groups[0].bookmarks.iter().all(|x| x.id != alone.id));
    }

    #[test]
    fn merge_keeps_every_note_tag_and_star_and_is_one_command() {
        let conn = library();
        let mut journal = crate::journal::Journal::default();
        let shelf = db::create_collection(&conn, "Железо", None, None).unwrap();
        let main = save(&conn, "https://tropicsquare.com/chips", &["hardware"]);
        let second = save(&conn, "http://www.tropicsquare.com/chips/", &["crypto", "hardware"]);
        let third = save(&conn, "https://tropicsquare.com/chips?utm_source=n#pricing", &[]);
        update_bookmark(&conn, second.id, None, Some("ask about dev kits".into()), None, Some(Some(shelf.id)), None).unwrap();
        update_bookmark(&conn, third.id, None, Some("  ".into()), Some(true), None, None).unwrap();
        // The main one waits in the inbox; the others were sorted.
        conn.execute("UPDATE bookmarks SET triaged_at = NULL WHERE id = ?1", [main.id]).unwrap();
        at(&conn, main.id, "2026-03-03T00:00:00.000Z");
        at(&conn, second.id, "2026-01-18T00:00:00.000Z");
        at(&conn, third.id, "2026-06-01T00:00:00.000Z");
        let before: Vec<Bookmark> = db::get_bookmarks_by_ids(&conn, &[main.id, second.id, third.id]).unwrap();

        let group = MergeGroup { main: main.id, others: vec![second.id, third.id] };
        let ids = [main.id, second.id, third.id];
        let (changed, command) = journal
            .record(&conn, crate::journal::Action::Merge, &ids, |conn| merge(conn, &[group]))
            .unwrap();
        assert_eq!(changed.len(), 3);
        let kept = db::get_bookmark_by_id(&conn, main.id).unwrap();
        assert_eq!(kept.tags.as_deref().unwrap(), ["hardware", "crypto"]);
        assert_eq!(kept.notes.as_deref(), Some("ask about dev kits"));
        assert!(kept.is_favorite);
        assert_eq!(kept.collection_id, Some(shelf.id));
        assert_eq!(kept.created_at, "2026-01-18T00:00:00.000Z", "the earliest save");
        assert!(kept.triaged_at.is_some(), "a decision on any of them sorts it");
        assert_eq!(kept.url, main.url);
        for id in [second.id, third.id] {
            assert!(db::get_bookmark_by_id(&conn, id).unwrap().deleted_at.is_some(), "the others are in the trash");
        }
        assert_eq!(count(&conn).unwrap(), 0);

        // Ctrl Z: everything as it was, the group again.
        journal.undo(&conn, command).unwrap();
        let mut after = db::get_bookmarks_by_ids(&conn, &ids).unwrap();
        let mut before = before;
        after.sort_by_key(|b| b.id);
        before.sort_by_key(|b| b.id);
        for (a, b) in after.iter().zip(&before) {
            assert_eq!(
                (&a.notes, a.is_favorite, a.collection_id, &a.tags, &a.triaged_at, &a.deleted_at, &a.created_at),
                (&b.notes, b.is_favorite, b.collection_id, &b.tags, &b.triaged_at, &b.deleted_at, &b.created_at),
                "{}", a.url
            );
        }
        assert_eq!(count(&conn).unwrap(), 1);
    }

    #[test]
    fn a_changed_group_merges_nothing() {
        let conn = library();
        let a = save(&conn, "https://example.com/a", &[]);
        let b = save(&conn, "https://example.com/a/", &[]);
        let other = save(&conn, "https://example.com/b", &[]);
        let c = save(&conn, "https://example.com/c", &[]);
        let c2 = save(&conn, "https://www.example.com/c", &[]);
        let snapshot = |conn: &Connection| {
            let mut all = db::get_bookmarks_by_ids(conn, &[a.id, b.id, other.id, c.id, c2.id]).unwrap();
            all.sort_by_key(|x| x.id);
            all.iter().map(|x| (x.revision, x.deleted_at.clone())).collect::<Vec<_>>()
        };
        let start = snapshot(&conn);
        for groups in [
            // Another address, the main one among the others, one twice, one in the trash.
            vec![MergeGroup { main: a.id, others: vec![other.id] }],
            vec![MergeGroup { main: a.id, others: vec![a.id] }],
            vec![MergeGroup { main: c.id, others: vec![c2.id] }, MergeGroup { main: a.id, others: vec![b.id, b.id] }],
            vec![MergeGroup { main: c.id, others: vec![c2.id] }, MergeGroup { main: a.id, others: vec![999] }],
        ] {
            let error = merge(&conn, &groups).unwrap_err();
            assert_eq!(crate::error::code_of(&error), crate::error::ErrorCode::NotFound);
            assert_eq!(snapshot(&conn), start, "{groups:?}: nothing is written");
        }
        trash_bookmark(&conn, b.id).unwrap();
        assert!(merge(&conn, &[MergeGroup { main: a.id, others: vec![b.id] }]).is_err());
    }

    #[test]
    fn not_duplicates_hides_the_group_until_another_twin_arrives() {
        let conn = library();
        let a = save(&conn, "https://example.com/page?utm_source=a", &[]);
        let b = save(&conn, "https://example.com/page?utm_source=b", &[]);
        assert_eq!(count(&conn).unwrap(), 1);
        assert_eq!(dismiss(&conn, "example.com/page", &[a.id, b.id]).unwrap(), 2);
        assert_eq!(count(&conn).unwrap(), 0);
        assert!(groups(&conn).unwrap().is_empty());
        // Undo shows it again; dismissed again, then a third copy arrives.
        undismiss(&conn, "example.com/page", &[a.id, b.id]).unwrap();
        assert_eq!(count(&conn).unwrap(), 1);
        dismiss(&conn, "example.com/page", &[a.id, b.id]).unwrap();
        let c = save(&conn, "https://example.com/page", &[]);
        let groups = groups(&conn).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].bookmarks.len(), 3);
        assert_eq!(groups[0].main, c.id, "the plain address");
        // A key of another group is not touched.
        assert_eq!(dismiss(&conn, "example.com/other", &[a.id]).unwrap(), 0);
    }

    #[test]
    fn keys_come_from_the_migration_and_for_rows_written_without_one() {
        let conn = library();
        conn.execute(
            "INSERT INTO bookmarks (uid, url, title, domain, created_at, updated_at) VALUES ('x', 'http://www.example.com/raw/', 'raw', 'example.com', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
            [],
        )
        .unwrap();
        save(&conn, "https://example.com/raw", &[]);
        assert_eq!(count(&conn).unwrap(), 0, "the raw row has no key yet");
        assert_eq!(fill_keys(&conn).unwrap(), 1);
        assert_eq!(count(&conn).unwrap(), 1);
        assert_eq!(fill_keys(&conn).unwrap(), 0);
    }

    #[test]
    fn groups_of_a_hundred_thousand_are_counted_quickly() {
        let conn = library();
        conn.execute_batch(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
             INSERT INTO bookmarks (uid, url, title, domain, created_at, updated_at)
             SELECT 'u' || i, 'https://example.com/' || i || CASE WHEN i % 50 = 0 THEN '/' ELSE '' END,
                    'Запись ' || i, 'example.com', '2026-10-04T12:00:00.000Z', '2026-10-04T12:00:00.000Z' FROM n;
             INSERT INTO bookmarks (uid, url, title, domain, created_at, updated_at)
             SELECT 'd' || i, 'https://www.example.com/' || i, 'Копия ' || i, 'example.com',
                    '2026-10-04T12:00:00.000Z', '2026-10-04T12:00:00.000Z'
             FROM (WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000) SELECT i FROM n WHERE i % 100 = 0);",
        )
        .unwrap();
        let started = std::time::Instant::now();
        fill_keys(&conn).unwrap();
        let filled = started.elapsed();
        let started = std::time::Instant::now();
        assert_eq!(count(&conn).unwrap(), 1000);
        let counted = started.elapsed();
        let started = std::time::Instant::now();
        assert_eq!(groups(&conn).unwrap().len(), 1000);
        println!("100 000 bookmarks: keys {filled:?}, count {counted:?}, groups {:?}", started.elapsed());
        // The count is fast because it walks the address index; that is what is
        // checked. The time limit only catches the pathological: a shared CI
        // runner is several times slower than a desktop (31 ms here, 234 ms there).
        let plan: Vec<String> = conn
            .prepare(&format!("EXPLAIN QUERY PLAN SELECT count(*) FROM ({GROUP_KEYS})"))
            .unwrap()
            .query_map([], |r| r.get::<_, String>(3))
            .unwrap()
            .map(|row| row.unwrap())
            .collect();
        assert!(plan.iter().any(|step| step.contains("idx_bookmarks_url_key")), "{plan:?}");
        assert!(counted.as_millis() < 1000, "count took {counted:?}");
    }
}
