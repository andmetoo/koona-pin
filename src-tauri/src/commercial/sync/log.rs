//! Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//!
//! Sync's log, `sync.log` beside `sync.json`: what the status model notes (phases, pairing, hub
//! changes, errors, dropped frames, closes, stops) and what the supervisor decides, so a computer
//! stuck yesterday can still say why today. The sync report copies its tail.
//!
//! Only ids (their first eight hex digits), states, codes and counts go in: nothing of the library,
//! no device name, email, token, key or lease. The lines are made by the callers from those alone;
//! [`short`] and [`word`] are what they use for ids and for text that came from the relay.
//!
//! A line never waits for the disk: it goes to a thread that appends it, and a full queue drops it
//! (counted, and said in the next line written). A write that fails is forgotten: sync goes on.
//! The file is cut at [`CAP`], the older half kept as `sync.log.1`, so the two hold at most twice
//! that. The last lines also stay in memory, for a report when the file can't be read.

use chrono::{DateTime, Utc};
use std::collections::VecDeque;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use uuid::Uuid;

pub const FILE: &str = "sync.log";
/// The file before the last cut.
pub const OLD_FILE: &str = "sync.log.1";
/// Bytes a file grows to before it is cut.
pub const CAP: u64 = 256 * 1024;
/// Lines waiting for the writer; more are dropped.
const QUEUE: usize = 1024;
/// Lines kept in memory.
const RECENT: usize = 200;

/// The first eight hex digits of an id: enough to tell a computer's entries apart in a report.
pub fn short(id: &Uuid) -> String {
    id.simple().to_string()[..8].to_string()
}

/// A word from the relay (a close reason, an error code) as it is if it is one: lower-case
/// letters, digits and `_`, at most 32. Anything else is `other`.
pub fn word(text: &str) -> &str {
    let ok = !text.is_empty() && text.len() <= 32 && text.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    if ok {
        text
    } else {
        "other"
    }
}

/// The time a line starts with.
pub fn stamp(at: DateTime<Utc>) -> String {
    at.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

enum Message {
    Line(String),
    Flush(mpsc::Sender<()>),
}

/// The log of one folder; clones share it.
#[derive(Clone)]
pub struct SyncLog {
    inner: Arc<Inner>,
}

struct Inner {
    path: PathBuf,
    cap: u64,
    /// None until the first line, and after the writer thread could not be started.
    sender: Mutex<Option<SyncSender<Message>>>,
    started: Mutex<bool>,
    recent: Mutex<VecDeque<String>>,
    dropped: Arc<AtomicU64>,
}

impl std::fmt::Debug for SyncLog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SyncLog").field("path", &self.inner.path).finish()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl SyncLog {
    /// `sync.log` in `folder`; nothing is written until the first line.
    pub fn new(folder: &Path) -> SyncLog {
        SyncLog::with_cap(folder.join(FILE), CAP)
    }

    fn with_cap(path: PathBuf, cap: u64) -> SyncLog {
        SyncLog {
            inner: Arc::new(Inner {
                path,
                cap,
                sender: Mutex::new(None),
                started: Mutex::new(false),
                recent: Mutex::new(VecDeque::with_capacity(RECENT)),
                dropped: Arc::new(AtomicU64::new(0)),
            }),
        }
    }

    pub fn path(&self) -> &Path {
        &self.inner.path
    }

    fn old_path(&self) -> PathBuf {
        old_path(&self.inner.path)
    }

    /// One line at `at`. Never waits for the disk and never fails.
    pub fn line(&self, at: DateTime<Utc>, text: &str) {
        let line = format!("{} {}", stamp(at), text.replace(['\n', '\r'], " "));
        {
            let mut recent = lock(&self.inner.recent);
            if recent.len() == RECENT {
                recent.pop_front();
            }
            recent.push_back(line.clone());
        }
        let Some(sender) = self.sender() else { return };
        match sender.try_send(Message::Line(line)) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                self.inner.dropped.fetch_add(1, Ordering::Relaxed);
            }
            Err(TrySendError::Disconnected(_)) => *lock(&self.inner.sender) = None,
        }
    }

    /// The writer's queue, the thread started on first use.
    fn sender(&self) -> Option<SyncSender<Message>> {
        let mut started = lock(&self.inner.started);
        if !*started {
            *started = true;
            let (sender, receiver) = mpsc::sync_channel(QUEUE);
            let writer = Writer::new(self.inner.path.clone(), self.inner.cap);
            let dropped = self.inner.dropped.clone();
            let spawned = std::thread::Builder::new().name("sync-log".into()).spawn(move || write_lines(writer, receiver, dropped));
            if spawned.is_ok() {
                *lock(&self.inner.sender) = Some(sender);
            }
        }
        lock(&self.inner.sender).clone()
    }

    /// Waits up to `wait` for the lines sent so far to be written.
    pub fn flush(&self, wait: Duration) {
        let Some(sender) = lock(&self.inner.sender).clone() else { return };
        let (done, written) = mpsc::channel();
        if sender.send(Message::Flush(done)).is_ok() {
            let _ = written.recv_timeout(wait);
        }
    }

    /// The last `count` lines: of the files when they read, else of those kept in memory.
    pub fn tail(&self, count: usize) -> Vec<String> {
        self.flush(Duration::from_millis(500));
        let read = |path: &Path| fs::read(path).ok().map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
        let current = read(&self.inner.path);
        let lines: Vec<String> = match (read(&self.old_path()), current) {
            (old, Some(current)) => old.unwrap_or_default().lines().chain(current.lines()).map(str::to_string).collect(),
            (Some(old), None) => old.lines().map(str::to_string).collect(),
            (None, None) => lock(&self.inner.recent).iter().cloned().collect(),
        };
        let skip = lines.len().saturating_sub(count);
        lines.into_iter().skip(skip).collect()
    }
}

fn old_path(path: &Path) -> PathBuf {
    path.with_file_name(format!("{}.1", path.file_name().and_then(|n| n.to_str()).unwrap_or(FILE)))
}

/// The writer thread: appends what comes, a batch at a time; a failure loses that batch only.
fn write_lines(mut writer: Writer, receiver: Receiver<Message>, dropped: Arc<AtomicU64>) {
    while let Ok(first) = receiver.recv() {
        let mut batch = String::new();
        let mut flushed = Vec::new();
        let mut next = Some(first);
        while let Some(message) = next.take() {
            match message {
                Message::Line(line) => {
                    let lost = dropped.swap(0, Ordering::Relaxed);
                    if lost > 0 {
                        batch.push_str(&format!("{} {lost} lines dropped: the log fell behind\n", stamp(Utc::now())));
                    }
                    batch.push_str(&line);
                    batch.push('\n');
                }
                Message::Flush(done) => flushed.push(done),
            }
            next = receiver.try_recv().ok();
        }
        if !batch.is_empty() {
            let _ = writer.append(&batch);
        }
        for done in flushed {
            let _ = done.send(());
        }
    }
}

/// Appends to the file and cuts it at the cap.
pub struct Writer {
    path: PathBuf,
    cap: u64,
    /// The file's size as last known; read again after a failure.
    size: Option<u64>,
}

impl Writer {
    pub fn new(path: PathBuf, cap: u64) -> Writer {
        Writer { path, cap, size: None }
    }

    pub fn append(&mut self, text: &str) -> io::Result<()> {
        let result = self.try_append(text);
        if result.is_err() {
            self.size = None;
        }
        result
    }

    fn try_append(&mut self, text: &str) -> io::Result<()> {
        let size = match self.size {
            Some(size) => size,
            None => fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0),
        };
        let size = if size > 0 && size + text.len() as u64 > self.cap {
            // `rename` replaces the older file on every system the app runs on.
            fs::rename(&self.path, old_path(&self.path))?;
            0
        } else {
            size
        };
        if let Some(folder) = self.path.parent() {
            fs::create_dir_all(folder)?;
        }
        let mut file = fs::OpenOptions::new().create(true).append(true).open(&self.path)?;
        file.write_all(text.as_bytes())?;
        self.size = Some(size + text.len() as u64);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("koonapin-sync-log-{name}-{}", Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn at(s: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_794_700_000 + s, 0).unwrap()
    }

    #[test]
    fn lines_reach_the_file_with_their_time() {
        let dir = folder("lines");
        let log = SyncLog::new(&dir);
        log.line(at(0), "phase Connecting");
        log.line(at(1), "closed: 1012 silent\nsecond line");
        log.flush(Duration::from_secs(5));
        let text = fs::read_to_string(dir.join(FILE)).unwrap();
        assert_eq!(text, "2026-11-14T23:46:40Z phase Connecting\n2026-11-14T23:46:41Z closed: 1012 silent second line\n");
        assert_eq!(log.tail(1), vec!["2026-11-14T23:46:41Z closed: 1012 silent second line".to_string()]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_file_is_cut_at_the_cap_and_one_older_kept() {
        let dir = folder("cut");
        let path = dir.join(FILE);
        let mut writer = Writer::new(path.clone(), 100);
        for n in 0..12 {
            writer.append(&format!("line {n:02} of twenty bytes\n")[..20]).unwrap();
        }
        let current = fs::metadata(&path).unwrap().len();
        let old = fs::metadata(dir.join(OLD_FILE)).unwrap().len();
        assert!(current <= 100 && old <= 100, "{current} and {old}");
        assert_eq!(current + old, 12 * 20 - 100, "two cuts: the first 100 bytes are gone");
        // A third cut replaces the older file.
        for _ in 0..5 {
            writer.append(&"x".repeat(20)).unwrap();
        }
        assert!(fs::metadata(dir.join(OLD_FILE)).unwrap().len() <= 100);
        assert!(!dir.join("sync.log.2").exists());
        // A writer started later (the next run) knows the size from the file.
        let mut again = Writer::new(path.clone(), 100);
        let before = fs::metadata(&path).unwrap().len();
        again.append("y\n").unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), before + 2);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_tail_reads_across_the_cut() {
        let dir = folder("tail");
        let log = SyncLog::with_cap(dir.join(FILE), 64);
        for n in 0..10 {
            log.line(at(n), &format!("n{n}"));
        }
        let tail = log.tail(4);
        assert_eq!(tail.len(), 4);
        assert!(tail[3].ends_with(" n9") && tail[0].ends_with(" n6"), "{tail:?}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_write_that_fails_is_forgotten() {
        // A file where the folder should be: every write fails.
        let dir = folder("fails");
        let blocker = dir.join("not-a-folder");
        fs::write(&blocker, "x").unwrap();
        let mut writer = Writer::new(blocker.join(FILE), CAP);
        assert!(writer.append("a\n").is_err());
        let log = SyncLog::new(&blocker);
        for n in 0..(QUEUE as i64 + 50) {
            log.line(at(n), "phase Online");
        }
        log.flush(Duration::from_secs(5));
        // Nothing on disk, but the report still has the recent lines.
        assert_eq!(log.tail(3).len(), 3);
        assert!(log.tail(3)[2].ends_with("phase Online"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn ids_are_cut_and_relay_words_checked() {
        let id = Uuid::parse_str("0192f3a4-b5c6-7d8e-9f01-23456789abcd").unwrap();
        assert_eq!(short(&id), "0192f3a4");
        assert_eq!(word("silent"), "silent");
        assert_eq!(word("device_key"), "device_key");
        assert_eq!(word("someone@example.com"), "other");
        assert_eq!(word("https://example.com/v1/sync"), "other");
        assert_eq!(word(""), "other");
        assert_eq!(word(&"a".repeat(40)), "other");
    }
}
