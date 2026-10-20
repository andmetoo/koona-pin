//! Links shared into the app from other apps (NP-071). A phone's share sheet runs without the app
//! (on Android `ShareActivity` of plugins/koona-share, in a process of its own; later an iOS share
//! extension) and leaves each link in the queue folder, one JSON file per share; the format is in
//! that plugin's lib.rs, its examples in its `queue-fixtures`. The app takes the queue in when the
//! library opens and whenever it comes back to the screen.
//!
//! Each file is saved like a capture, with the share's `request_id`: the receipt is written in the
//! same transaction as the bookmark, and the file is deleted only after the commit. A file read
//! again, because the app ended between the commit and the delete or the sheet queued the same
//! share twice, is answered from its receipt: one share stays one bookmark. A file that cannot be
//! a share (not JSON, no link, not http or https) goes to `rejected/` beside the queue and never
//! holds up the rest (the newest 50 are kept there); a library that cannot take writes leaves
//! the queue for the next time, and a share that fails by itself waits while the rest go on. A
//! `.tmp` an hour old is a share whose sheet ended before its rename, and is deleted.
//!
//! Compiled everywhere, so a desktop tests it; only a phone with a share sheet has a queue.

use crate::capture::{self, CaptureError, CaptureRequest, CaptureResult};
use crate::db::{DbState, Source};
use crate::error::ErrorCode;
use chrono::{DateTime, Utc};
use rusqlite::Connection;
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};

/// Where the shares wait, beside it the files that could not be taken.
const REJECTED: &str = "rejected";

/// How many files `rejected/` keeps, the newest: enough to see what went wrong.
const REJECTED_KEPT: usize = 50;

/// A `.tmp` older than this is a share whose sheet ended before its rename: it never comes.
const ABANDONED: Duration = Duration::from_secs(60 * 60);

/// The queue of a phone that has a share sheet; managed before the library opens.
pub struct Queue {
    folder: PathBuf,
    /// One ingest at a time: a start and a resume close together take the queue one after the other.
    ingest: Mutex<()>,
}

impl Queue {
    pub fn new(folder: PathBuf) -> Self {
        Queue { folder, ingest: Mutex::new(()) }
    }

    /// Takes in every share waiting, oldest first, through `conn`; `saved` hears of each save
    /// after its commit and before its file is deleted.
    pub fn drain(&self, conn: &Mutex<Connection>, mut saved: impl FnMut(&CaptureResult)) -> Drained {
        let _one = self.ingest.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut drained = Drained::default();
        // No folder yet: nothing was ever shared.
        let Ok(entries) = fs::read_dir(&self.folder) else {
            return drained;
        };
        let mut waiting = Vec::new();
        for path in entries.flatten().map(|entry| entry.path()) {
            // `<id>.json.tmp` is a share still being written; `rejected` is a folder.
            if path.extension().is_some_and(|extension| extension == "tmp") {
                if age(&path).is_some_and(|age| age > ABANDONED) {
                    let _ = fs::remove_file(&path);
                }
                continue;
            }
            if path.extension().is_none_or(|extension| extension != "json") || !path.is_file() {
                continue;
            }
            match fs::read(&path) {
                Ok(bytes) => match Share::parse(&bytes) {
                    Ok(share) => waiting.push((share, path)),
                    Err(why) => drained.rejected += usize::from(self.reject(&path, &why)),
                },
                Err(error) => {
                    eprintln!("Koona Pin: cannot read the shared link {}: {error}", path.display());
                    drained.left += 1;
                }
            }
        }
        waiting.sort_by(|(a, a_path), (b, b_path)| a.created.cmp(&b.created).then_with(|| a_path.cmp(b_path)));
        let total = waiting.len();
        for (done, (share, path)) in waiting.into_iter().enumerate() {
            let request = share.request();
            let result = match conn.lock() {
                Ok(conn) => capture::save(&conn, &request, Source::Share),
                Err(_) => {
                    drained.left += total - done;
                    break;
                }
            };
            match result {
                Ok(result) => {
                    saved(&result);
                    drained.saved += 1;
                    // Left behind, it is read again and answered from its receipt.
                    if let Err(error) = fs::remove_file(&path) {
                        eprintln!("Koona Pin: cannot delete the shared link {}: {error}", path.display());
                    }
                }
                Err(error) if matches!(error.code, "invalid_request" | "request_id_conflict") => {
                    drained.rejected += usize::from(self.reject(&path, &error.message));
                }
                // The library cannot take writes now (busy, read-only after damage, a full disk):
                // the whole queue waits for the next time.
                Err(error) if transient(&error) => {
                    eprintln!("Koona Pin: the shared links wait: {}", error.message);
                    drained.left += total - done;
                    break;
                }
                // This one failed by itself: it stays for the next time, the others go on.
                Err(error) => {
                    eprintln!("Koona Pin: the shared link {} waits: {}", path.display(), error.message);
                    drained.left += 1;
                }
            }
        }
        drained
    }

    /// Moves a file that cannot be a share out of the queue; false when it stays where it is.
    fn reject(&self, path: &Path, why: &str) -> bool {
        eprintln!("Koona Pin: the shared link {} is put aside: {why}", path.display());
        let folder = self.folder.join(REJECTED);
        let Some(name) = path.file_name() else {
            return false;
        };
        let target = folder.join(name);
        let _ = fs::remove_file(&target);
        match fs::create_dir_all(&folder).and_then(|()| fs::rename(path, &target)) {
            Ok(()) => {
                prune(&folder);
                true
            }
            Err(error) => {
                eprintln!("Koona Pin: cannot put the shared link aside: {error}");
                false
            }
        }
    }
}

/// Whether the library as a whole cannot take a write now, rather than this share.
fn transient(error: &CaptureError) -> bool {
    matches!(error.ipc, ErrorCode::DatabaseBusy | ErrorCode::ReadOnly | ErrorCode::DiskFull)
}

/// How long ago a file was last written; none when the system cannot say.
fn age(path: &Path) -> Option<Duration> {
    SystemTime::now().duration_since(fs::metadata(path).and_then(|meta| meta.modified()).ok()?).ok()
}

/// Keeps the newest [`REJECTED_KEPT`] files of `rejected/`.
fn prune(folder: &Path) {
    let Ok(entries) = fs::read_dir(folder) else {
        return;
    };
    let mut files: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .collect();
    if files.len() <= REJECTED_KEPT {
        return;
    }
    files.sort_by(|a, b| b.cmp(a));
    for (_, path) in &files[REJECTED_KEPT..] {
        let _ = fs::remove_file(path);
    }
}

/// What one ingest did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Drained {
    /// Saved or found saved already (a receipt): their files are gone.
    pub saved: usize,
    /// Moved to `rejected/`.
    pub rejected: usize,
    /// Still in the queue for the next time.
    pub left: usize,
}

/// One file of the queue.
#[derive(Deserialize)]
struct Item {
    request_id: String,
    url: String,
    #[serde(default)]
    title: Option<String>,
    created_at: String,
}

struct Share {
    item: Item,
    created: DateTime<Utc>,
}

impl Share {
    fn parse(bytes: &[u8]) -> Result<Share, String> {
        let item: Item = serde_json::from_slice(bytes).map_err(|error| format!("not a share: {error}"))?;
        let created = DateTime::parse_from_rfc3339(&item.created_at)
            .map_err(|error| format!("created_at {:?}: {error}", item.created_at))?
            .with_timezone(&Utc);
        Ok(Share { item, created })
    }

    /// As the browser extension's capture, to the inbox; an empty title is found by the metadata.
    fn request(&self) -> CaptureRequest {
        CaptureRequest {
            request_id: Some(self.item.request_id.clone()),
            url: self.item.url.clone(),
            title: self.item.title.clone().filter(|title| !title.trim().is_empty()),
            collection_id: None,
            tags: None,
            reading: false,
        }
    }
}

/// On a phone with a share sheet: its queue folder, before the library opens.
pub fn manage(app: &tauri::App, folder: Option<PathBuf>) {
    if let Some(folder) = folder {
        app.manage(Queue::new(folder));
    }
}

/// Takes the queue in on a thread of its own, with the change events a capture sends, so the
/// interface reads what came. Nothing without a queue or before the library is open: its opening
/// calls this again.
pub fn ingest(app: &AppHandle) {
    if app.try_state::<Queue>().is_none() || app.try_state::<Arc<DbState>>().is_none() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let queue = app.state::<Queue>();
        let db = app.state::<Arc<DbState>>().inner().clone();
        let drained = queue.drain(&db.conn, |saved| capture::after_save(&app, db.clone(), saved));
        if drained != Drained::default() {
            eprintln!("Koona Pin: shared links: {drained:?}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> Mutex<Connection> {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::register_functions(&conn).unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        crate::migrations::migrate(&mut conn, None).unwrap();
        Mutex::new(conn)
    }

    fn folder(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!("koonapin-share-{name}-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&folder).unwrap();
        folder
    }

    fn share(folder: &Path, file: &str, request_id: &str, url: &str, created_at: &str) -> PathBuf {
        let path = folder.join(file);
        let json = serde_json::json!({ "request_id": request_id, "url": url, "title": "", "created_at": created_at });
        fs::write(&path, json.to_string()).unwrap();
        path
    }

    fn bookmarks(conn: &Mutex<Connection>) -> Vec<(String, String, Option<String>)> {
        let conn = conn.lock().unwrap();
        let mut statement = conn.prepare("SELECT url, title, source FROM bookmarks WHERE url NOT LIKE 'https://koona.app/%' ORDER BY id").unwrap();
        statement.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().map(Result::unwrap).collect()
    }

    fn names(folder: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(folder)
            .map(|entries| entries.flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        names.sort();
        names
    }

    const ID: &str = "6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f";

    #[test]
    fn a_share_becomes_one_bookmark_in_the_inbox_and_its_file_goes() {
        let (conn, folder) = (library(), folder("once"));
        share(&folder, &format!("{ID}.json"), ID, "https://example.com/a", "2026-10-20T09:41:00Z");
        let mut heard = Vec::new();
        let drained = Queue::new(folder.clone()).drain(&conn, |saved| heard.push((saved.newly_created, saved.outcome.clone())));
        assert_eq!(drained, Drained { saved: 1, rejected: 0, left: 0 });
        assert_eq!(heard, [(true, "created".to_owned())]);
        assert_eq!(bookmarks(&conn), [("https://example.com/a".into(), "https://example.com/a".into(), Some("share".into()))]);
        let triaged: Option<String> = conn.lock().unwrap().query_row("SELECT triaged_at FROM bookmarks WHERE url = 'https://example.com/a'", [], |r| r.get(0)).unwrap();
        assert_eq!(triaged, None, "waits in the inbox");
        assert!(names(&folder).is_empty());
    }

    #[test]
    fn the_same_file_twice_is_one_bookmark() {
        let (conn, folder) = (library(), folder("twice"));
        let queue = Queue::new(folder.clone());
        for _ in 0..2 {
            share(&folder, &format!("{ID}.json"), ID, "https://example.com/a", "2026-10-20T09:41:00Z");
            assert_eq!(queue.drain(&conn, |_| {}).saved, 1);
        }
        assert_eq!(bookmarks(&conn).len(), 1);
        assert!(names(&folder).is_empty());
    }

    #[test]
    fn two_files_of_one_request_are_one_bookmark() {
        let (conn, folder) = (library(), folder("one-request"));
        share(&folder, "first.json", ID, "https://example.com/a", "2026-10-20T09:41:00Z");
        share(&folder, "second.json", ID, "https://example.com/a", "2026-10-20T09:42:00Z");
        let mut created = 0;
        let drained = Queue::new(folder.clone()).drain(&conn, |saved| created += usize::from(saved.newly_created));
        assert_eq!(drained, Drained { saved: 2, rejected: 0, left: 0 });
        assert_eq!((created, bookmarks(&conn).len()), (1, 1));
        assert!(names(&folder).is_empty());
    }

    #[test]
    fn a_request_id_used_for_another_link_is_put_aside() {
        let (conn, folder) = (library(), folder("conflict"));
        share(&folder, "first.json", ID, "https://example.com/a", "2026-10-20T09:41:00Z");
        share(&folder, "second.json", ID, "https://example.com/b", "2026-10-20T09:42:00Z");
        assert_eq!(Queue::new(folder.clone()).drain(&conn, |_| {}), Drained { saved: 1, rejected: 1, left: 0 });
        assert_eq!(bookmarks(&conn).len(), 1);
        assert_eq!(names(&folder.join(REJECTED)), ["second.json"]);
    }

    /// The app ended after the save's commit, before the file was deleted: the file is read again
    /// at the next start, and its receipt answers it.
    #[test]
    fn a_file_left_after_its_commit_stays_one_bookmark() {
        let (conn, folder) = (library(), folder("leftover"));
        share(&folder, &format!("{ID}.json"), ID, "https://example.com/a", "2026-10-20T09:41:00Z");
        let request = CaptureRequest {
            request_id: Some(ID.into()),
            url: "https://example.com/a".into(),
            title: None,
            collection_id: None,
            tags: None,
            reading: false,
        };
        assert!(capture::save(&conn.lock().unwrap(), &request, Source::Share).unwrap().newly_created);
        let mut heard = Vec::new();
        let drained = Queue::new(folder.clone()).drain(&conn, |saved| heard.push(saved.newly_created));
        assert_eq!(drained, Drained { saved: 1, rejected: 0, left: 0 });
        assert_eq!(heard, [false], "no second bookmark to announce");
        assert_eq!(bookmarks(&conn).len(), 1);
        assert!(names(&folder).is_empty());
    }

    #[test]
    fn a_bad_file_is_put_aside_and_holds_nothing_up() {
        let (conn, folder) = (library(), folder("bad"));
        fs::write(folder.join("broken.json"), "{\"request_id\":").unwrap();
        share(&folder, "good.json", ID, "https://example.com/a", "2026-10-20T09:41:00Z");
        assert_eq!(Queue::new(folder.clone()).drain(&conn, |_| {}), Drained { saved: 1, rejected: 1, left: 0 });
        assert_eq!(bookmarks(&conn).len(), 1);
        assert_eq!(names(&folder), [REJECTED]);
        assert_eq!(names(&folder.join(REJECTED)), ["broken.json"]);
    }

    #[test]
    fn a_share_still_being_written_waits_and_an_abandoned_one_goes() {
        let (conn, folder) = (library(), folder("tmp"));
        share(&folder, &format!("{ID}.json.tmp"), ID, "https://example.com/a", "2026-10-20T09:41:00Z");
        let old = share(&folder, "abandoned.json.tmp", ID, "https://example.com/b", "2026-10-20T09:41:00Z");
        fs::File::options().write(true).open(&old).unwrap().set_modified(SystemTime::now() - ABANDONED * 2).unwrap();
        assert_eq!(Queue::new(folder.clone()).drain(&conn, |_| {}), Drained::default());
        assert!(bookmarks(&conn).is_empty());
        assert_eq!(names(&folder), [format!("{ID}.json.tmp")]);
    }

    #[test]
    fn a_share_that_fails_by_itself_waits_and_the_rest_go_on() {
        let (conn, folder) = (library(), folder("one-fails"));
        conn.lock()
            .unwrap()
            .execute_batch("CREATE TEMP TRIGGER refuse BEFORE INSERT ON bookmarks WHEN NEW.url LIKE '%refused%' BEGIN SELECT RAISE(ABORT, 'refused'); END;")
            .unwrap();
        share(&folder, "a.json", ID, "https://example.com/refused", "2026-10-20T09:41:00Z");
        share(&folder, "b.json", "0b5e7c1d-2f4a-4e6b-8c9d-0e1f2a3b4c5d", "https://example.com/b", "2026-10-20T09:42:00Z");
        assert_eq!(Queue::new(folder.clone()).drain(&conn, |_| {}), Drained { saved: 1, rejected: 0, left: 1 });
        assert_eq!(bookmarks(&conn).len(), 1);
        assert_eq!(names(&folder), ["a.json"]);
    }

    #[test]
    fn the_files_put_aside_are_the_newest_fifty() {
        let (conn, folder) = (library(), folder("rejected-cap"));
        let rejected = folder.join(REJECTED);
        fs::create_dir_all(&rejected).unwrap();
        for i in 0..REJECTED_KEPT + 5 {
            let path = rejected.join(format!("old-{i:02}.json"));
            fs::write(&path, "{").unwrap();
            let when = SystemTime::now() - Duration::from_secs(3600 + (REJECTED_KEPT + 5 - i) as u64);
            fs::File::options().write(true).open(&path).unwrap().set_modified(when).unwrap();
        }
        fs::write(folder.join("broken.json"), "{").unwrap();
        assert_eq!(Queue::new(folder.clone()).drain(&conn, |_| {}).rejected, 1);
        let kept = names(&rejected);
        assert_eq!(kept.len(), REJECTED_KEPT);
        assert!(kept.contains(&"broken.json".to_owned()));
        assert!(!kept.contains(&"old-00.json".to_owned()) && kept.contains(&"old-54.json".to_owned()));
    }

    /// The links the share sheet takes and refuses (queue-fixtures/links, read by its Kotlin tests
    /// too): what it calls saved, the app takes.
    #[test]
    fn the_sheet_and_the_app_agree_on_links() {
        let links = Path::new(env!("CARGO_MANIFEST_DIR")).join("plugins/koona-share/queue-fixtures/links");
        let read = |name: &str| {
            let text = fs::read_to_string(links.join(name)).unwrap();
            text.lines().map(str::trim).filter(|line| !line.is_empty()).map(String::from).collect::<Vec<_>>()
        };
        for url in read("accepted.txt") {
            assert!(capture::validate_url(&url).is_ok(), "{url}");
        }
        for url in read("refused.txt") {
            assert!(capture::validate_url(&url).is_err(), "{url}");
        }
        let longest = format!("https://example.com/{}", "a".repeat(8192 - 20));
        assert!(capture::validate_url(&longest).is_ok());
        assert!(capture::validate_url(&format!("{longest}a")).is_err());
    }

    #[test]
    fn a_library_that_takes_no_writes_leaves_the_queue_as_it_is() {
        let (conn, folder) = (library(), folder("read-only"));
        conn.lock().unwrap().pragma_update(None, "query_only", true).unwrap();
        share(&folder, "a.json", ID, "https://example.com/a", "2026-10-20T09:41:00Z");
        share(&folder, "b.json", "0b5e7c1d-2f4a-4e6b-8c9d-0e1f2a3b4c5d", "https://example.com/b", "2026-10-20T09:42:00Z");
        assert_eq!(Queue::new(folder.clone()).drain(&conn, |_| {}), Drained { saved: 0, rejected: 0, left: 2 });
        assert_eq!(names(&folder), ["a.json", "b.json"]);
    }

    #[test]
    fn the_oldest_share_is_saved_first() {
        let (conn, folder) = (library(), folder("order"));
        share(&folder, "a.json", "0b5e7c1d-2f4a-4e6b-8c9d-0e1f2a3b4c5d", "https://example.com/later", "2026-10-20T11:00:00+02:00");
        share(&folder, "b.json", ID, "https://example.com/earlier", "2026-10-20T08:30:00Z");
        Queue::new(folder).drain(&conn, |_| {});
        let urls: Vec<String> = bookmarks(&conn).into_iter().map(|(url, ..)| url).collect();
        assert_eq!(urls, ["https://example.com/earlier", "https://example.com/later"]);
    }

    #[test]
    fn without_a_folder_there_is_nothing_to_take() {
        let conn = library();
        let missing = std::env::temp_dir().join(format!("koonapin-share-none-{}", uuid::Uuid::new_v4().simple()));
        assert_eq!(Queue::new(missing).drain(&conn, |_| {}), Drained::default());
    }

    #[test]
    fn two_ingests_at_once_take_each_share_once() {
        let (conn, folder) = (library(), folder("at-once"));
        for i in 0..20 {
            let id = uuid::Uuid::new_v4().to_string();
            share(&folder, &format!("{id}.json"), &id, &format!("https://example.com/{i}"), "2026-10-20T09:41:00Z");
        }
        let queue = Queue::new(folder.clone());
        let created = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..2 {
                scope.spawn(|| {
                    let drained = queue.drain(&conn, |saved| {
                        created.fetch_add(usize::from(saved.newly_created), std::sync::atomic::Ordering::Relaxed);
                    });
                    assert_eq!((drained.rejected, drained.left), (0, 0));
                });
            }
        });
        assert_eq!(created.into_inner(), 20);
        assert_eq!(bookmarks(&conn).len(), 20);
        assert!(names(&folder).is_empty());
    }

    /// The format's examples (plugins/koona-share/queue-fixtures): what the Kotlin side writes
    /// (`written`, its tests compare them byte for byte) and what another writer may (`accepted`)
    /// are saved; `rejected` are put aside.
    #[test]
    fn the_shared_fixtures_are_taken_or_put_aside() {
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("plugins/koona-share/queue-fixtures");
        let (conn, folder) = (library(), folder("fixtures"));
        let mut expected = Drained::default();
        for kind in ["written", "accepted", "rejected"] {
            for entry in fs::read_dir(fixtures.join(kind)).unwrap().flatten() {
                fs::copy(entry.path(), folder.join(format!("{kind}-{}", entry.file_name().to_string_lossy()))).unwrap();
                *if kind == "rejected" { &mut expected.rejected } else { &mut expected.saved } += 1;
            }
        }
        assert_eq!(Queue::new(folder.clone()).drain(&conn, |_| {}), expected);
        assert!(names(&folder.join(REJECTED)).iter().all(|name| name.starts_with("rejected-")));
        assert_eq!(names(&folder.join(REJECTED)).len(), expected.rejected);
        let saved = bookmarks(&conn);
        assert_eq!(saved.len(), expected.saved);
        let title = |url: &str| saved.iter().find(|(u, ..)| u == url).map(|(_, title, _)| title.clone()).unwrap();
        assert_eq!(title("https://example.org/quotes"), "Ink \"&\" Switch \\ essays\n\tпривет 東京 😀\u{1}");
        assert_eq!(title("https://www.inkandswitch.com/essay/local-first/"), "Local-first software: you own your data, in spite of the cloud");
        // No title: the address until the metadata names it, as a capture without one.
        assert_eq!(title("https://example.com/a?b=1&c=%D0%BF#top"), "https://example.com/a?b=1&c=%D0%BF#top");
        assert_eq!(title("https://example.net/null-title"), "https://example.net/null-title");
    }
}
