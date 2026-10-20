//! The picture cache (NP-146): previews and icons kept small on this
//! computer, so they show without the network and scrolling asks no site:
//!
//! ```text
//! thumbs/<aa>/<key>.jpg         a preview or a feed post's thumbnail: JPEG q80, at most 640 px wide
//! thumbs/<aa>/<key>.png         the same with real transparency
//! thumbs/<aa>/<key>.icon.png    an icon: at most 96 × 96
//! thumbs/<aa>/<key>.icon.svg    an SVG icon as it came, up to 64 KB
//! thumbs/<aa>/<key>.miss        the last fetch failed (`.icon.miss` for an icon): see [`Miss`]
//! ```
//!
//! `key` is the SHA-256 of the source address, `aa` its first two letters:
//! one Google icon serves every link of a domain, a saved feed post reuses
//! its thumbnail. No table: the folder is the index. It sits beside the
//! library, on Windows in the local (not roaming) AppData ([`root_for`]),
//! and is never synced, exported, backed up or sent anywhere.
//!
//! The WebView asks through the `kpimg` scheme ([`protocol`]) by what shows
//! the picture, never by address: `b/<bookmark id>/image`, `b/<id>/icon`,
//! `p/<feed post id>/thumb`, `f/<feed uid>/icon`. The address is read on a
//! read-only connection of its own, never the library's writer, then the
//! file is served, or fetched under [`LIMITS`]: the newest request first, at
//! most [`PARALLEL`] at a time and [`PER_HOST`] per site, one fetch per file
//! however many ask. A request that waits [`SLOT_WAIT`] for its turn gets a
//! 404 and the card loads the source address itself. A saved link's pictures
//! are fetched in the background ([`warm`]); the rest on first display.
//!
//! Files are written under a `.partial-` name and renamed. [`sweep`] removes
//! what no bookmark (the trash included), feed post or feed icon refers to,
//! a day after it was written, and keeps the folder under [`CAP`].

use crate::db::{Bookmark, DbState};
use crate::feeds::cache::FeedCache;
use crate::library::Paths;
use crate::library_state::Library;
use crate::metadata::{self, FetchError, Limits};
use crate::net_guard;
use image::imageops::FilterType;
use image::metadata::Orientation;
use image::{DynamicImage, GenericImageView, ImageDecoder, ImageFormat, ImageReader};
use percent_encoding::percent_decode_str;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};
use tauri::http::{header, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder};
use tokio::sync::{oneshot, watch, Notify, Semaphore};
use url::Url;

/// The folder of the cache.
pub const FOLDER: &str = "thumbs";
/// The scheme the WebView asks for pictures by: `kpimg://localhost/…`, on
/// Windows `http://kpimg.localhost/…`.
pub const SCHEME: &str = "kpimg";
/// Part of the name of a file being written; never a key.
const PARTIAL: &str = ".partial-";
const DAY: Duration = Duration::from_secs(24 * 60 * 60);
/// A file nothing refers to stays this long after it was written: a link
/// saved a moment ago, a restore, a post still on screen.
const GRACE: Duration = DAY;
/// The whole folder; over it, the oldest written go down to 90%.
pub const CAP: u64 = 1024 * 1024 * 1024;
/// Fetches at once, the displayed and the warmed together.
pub const PARALLEL: usize = 8;
/// Of those, at most this many to one site.
pub const PER_HOST: usize = 2;
/// A displayed picture waits this long for its fetch to start, then the card
/// loads the source address itself; the fetch stays queued a while.
pub const SLOT_WAIT: Duration = Duration::from_secs(3);
/// A queued fetch nobody waits for any more gives up after this; a warm one after [`WARM_QUEUED`].
const QUEUED: Duration = Duration::from_secs(30);
const WARM_QUEUED: Duration = Duration::from_secs(10 * 60);
/// Connection failures in a row that make the network suspect, as the
/// preview refresh does: then every miss is a 404 at once for [`BREAKER_FOR`].
const BREAKER_AFTER: u32 = 5;
const BREAKER_FOR: Duration = Duration::from_secs(60);

const PREVIEW_WIDTH: u32 = 640;
const ICON_SIDE: u32 = 96;
const JPEG_QUALITY: u8 = 80;
const MAX_SVG: usize = 64 * 1024;
/// Against image bombs: a header can promise any size.
const MAX_SIDE: u32 = 8000;
const MAX_ALLOC: u64 = 100 * 1024 * 1024;
/// Fast, and smooth enough at these sizes: a 4000 × 3000 JPEG is decoded and
/// made a preview in about 45 ms (release build).
const FILTER: FilterType = FilterType::Triangle;

const CACHE_CONTROL: &str = "private, max-age=31536000, immutable";
/// Every answer: an SVG from a local scheme must never run as a page.
const SANDBOX: &str = "sandbox; default-src 'none'";
/// The header of the answer to an address the guard refuses.
pub const REFUSED_HEADER: &str = "X-Kpimg";

/// A picture request: the metadata guard, 6 s to connect, 15 s in all, up to 5 MB.
pub const LIMITS: Limits = Limits {
    allow: net_guard::public_ip,
    connect_timeout: Duration::from_secs(6),
    timeout: Duration::from_secs(15),
    max_body: 5 * 1024 * 1024,
    max_redirects: 5,
};

/// Not in a public build: with this set, end-to-end tests serve pictures from this computer.
#[cfg(not(feature = "public-release"))]
pub const LOOPBACK_ENV: &str = "KOONAPIN_THUMBS_LOOPBACK";

#[cfg(not(feature = "public-release"))]
fn loopback_or_public(ip: std::net::IpAddr) -> bool {
    ip.is_loopback() || net_guard::public_ip(ip)
}

#[cfg(not(feature = "public-release"))]
const LOOPBACK_LIMITS: Limits = Limits { allow: loopback_or_public, ..LIMITS };

/// Decodes at once: each may take 100 MB.
static DECODES: Semaphore = Semaphore::const_new(2);
static QUEUE: LazyLock<Queue> = LazyLock::new(|| Queue::new(PARALLEL, PER_HOST));
/// The fetch under way for each file: whoever asks meanwhile waits for it.
static FLIGHTS: LazyLock<Mutex<HashMap<String, Flight>>> = LazyLock::new(Default::default);
/// The order of requests: the newest is fetched first.
static RANKS: AtomicU64 = AtomicU64::new(1);
/// A purge or a cleared feed cache asks the sweep to run ([`sweep_soon`]).
static SWEEP: Notify = Notify::const_new();

/// What a picture is made into.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Size {
    /// A card's preview, a feed post's thumbnail.
    Preview,
    /// A bookmark's or a feed's icon.
    Icon,
}

impl Size {
    /// What the file name says after the key: an address can be both a preview and an icon.
    fn tag(self) -> &'static str {
        match self {
            Size::Preview => "",
            Size::Icon => "icon.",
        }
    }
}

/// A file of the cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Jpeg,
    Png,
    Svg,
}

impl Format {
    pub fn ext(self) -> &'static str {
        match self {
            Format::Jpeg => "jpg",
            Format::Png => "png",
            Format::Svg => "svg",
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            Format::Jpeg => "image/jpeg",
            Format::Png => "image/png",
            Format::Svg => "image/svg+xml",
        }
    }

    /// What a size class may be kept as, in the order looked for.
    fn of(size: Size) -> &'static [Format] {
        match size {
            Size::Preview => &[Format::Jpeg, Format::Png],
            Size::Icon => &[Format::Png, Format::Svg],
        }
    }
}

/// Why the last fetch kept nothing, written in the `.miss` file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Miss {
    /// Gone, forbidden, not a picture, too large: tried again after 7 days.
    Failed,
    /// No answer in time: tried again after a day.
    Timeout,
    /// The guard refused the address (local, not http): the card shows its cover, not the web.
    Refused,
}

impl Miss {
    fn content(self) -> &'static [u8] {
        match self {
            Miss::Failed => b"",
            Miss::Timeout => b"timeout",
            Miss::Refused => b"refused",
        }
    }

    fn read(bytes: &[u8]) -> Miss {
        match bytes {
            b"timeout" => Miss::Timeout,
            b"refused" => Miss::Refused,
            _ => Miss::Failed,
        }
    }

    fn retry(self) -> Duration {
        match self {
            Miss::Timeout => DAY,
            Miss::Failed | Miss::Refused => 7 * DAY,
        }
    }
}

/// What the WebView asks for, by the path of a `kpimg` address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Picture {
    /// `b/<id>/image`: `bookmarks.image_url`.
    BookmarkImage(i64),
    /// `b/<id>/icon`: `bookmarks.favicon_url`.
    BookmarkIcon(i64),
    /// `p/<id>/thumb`: `feed_items.thumbnail_url` in `feeds.db`.
    PostThumb(i64),
    /// `f/<uid>/icon`: `feed_state.icon_url` in `feeds.db`, as the feed list shows it.
    FeedIcon(String),
}

impl Picture {
    /// The path of a request, after its `/`: percent-encoded as one segment
    /// (`b%2F12%2Fimage`, as `convertFileSrc` makes it) or not.
    pub fn parse(path: &str) -> Option<Picture> {
        // A whole address's query (`?v=`) is not part of it.
        let path = path.split(['?', '#']).next().unwrap_or_default();
        let path = path.strip_prefix('/').unwrap_or(path);
        let decoded = percent_decode_str(path).decode_utf8().ok()?;
        let parts: Vec<&str> = decoded.split('/').collect();
        let id = |s: &str| (!s.is_empty() && s.len() <= 18 && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse::<i64>().ok()).flatten();
        match parts.as_slice() {
            ["b", n, "image"] => Some(Picture::BookmarkImage(id(n)?)),
            ["b", n, "icon"] => Some(Picture::BookmarkIcon(id(n)?)),
            ["p", n, "thumb"] => Some(Picture::PostThumb(id(n)?)),
            ["f", uid, "icon"] if uid_like(uid) => Some(Picture::FeedIcon(uid.to_string())),
            _ => None,
        }
    }

    pub fn size(&self) -> Size {
        match self {
            Picture::BookmarkImage(_) | Picture::PostThumb(_) => Size::Preview,
            Picture::BookmarkIcon(_) | Picture::FeedIcon(_) => Size::Icon,
        }
    }
}

/// A subscription's `uid`: a UUID, or what sync or OPML brought; nothing that
/// could be more than a value in a query.
fn uid_like(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The source address of a library picture; none for an empty one. Bookmarks
/// in the trash too: the trash shows its cards.
pub fn library_source(conn: &Connection, picture: &Picture) -> rusqlite::Result<Option<String>> {
    let (column, id) = match picture {
        Picture::BookmarkImage(id) => ("image_url", *id),
        Picture::BookmarkIcon(id) => ("favicon_url", *id),
        _ => return Ok(None),
    };
    let address: Option<Option<String>> =
        conn.query_row(&format!("SELECT {column} FROM bookmarks WHERE id = ?1"), [id], |r| r.get(0)).optional()?;
    Ok(address.flatten().filter(|a| !a.trim().is_empty()))
}

/// The source address of a feed picture, from the feed cache.
pub fn feed_source(conn: &Connection, picture: &Picture) -> rusqlite::Result<Option<String>> {
    let address: Option<Option<String>> = match picture {
        Picture::PostThumb(id) => conn.query_row("SELECT thumbnail_url FROM feed_items WHERE id = ?1", [id], |r| r.get(0)).optional()?,
        Picture::FeedIcon(uid) => conn.query_row("SELECT icon_url FROM feed_state WHERE feed_uid = ?1", [uid], |r| r.get(0)).optional()?,
        _ => return Ok(None),
    };
    Ok(address.flatten().filter(|a| !a.trim().is_empty()))
}

/// Every address the library refers to: pictures and icons of all bookmarks,
/// those in the trash included.
pub fn library_addresses(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    conn.prepare(
        "SELECT image_url FROM bookmarks WHERE image_url IS NOT NULL
         UNION SELECT favicon_url FROM bookmarks WHERE favicon_url IS NOT NULL",
    )?
    .query_map([], |r| r.get(0))?
    .collect()
}

/// Every address the feed cache refers to: post thumbnails and feed icons.
pub fn feed_addresses(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    conn.prepare(
        "SELECT thumbnail_url FROM feed_items WHERE thumbnail_url IS NOT NULL
         UNION SELECT icon_url FROM feed_state WHERE icon_url IS NOT NULL",
    )?
    .query_map([], |r| r.get(0))?
    .collect()
}

/// The file name of an address: the hex SHA-256 of it, as it is stored.
pub fn key(address: &str) -> String {
    crate::hash::sha256_hex(address.as_bytes())
}

/// The keys of a set of addresses.
pub fn keys<'a>(addresses: impl IntoIterator<Item = &'a String>) -> HashSet<String> {
    addresses.into_iter().map(|a| key(a)).collect()
}

fn file(root: &Path, key: &str, size: Size, ext: &str) -> PathBuf {
    root.join(&key[..2]).join(format!("{key}.{}{ext}", size.tag()))
}

/// The cache of the library at `paths`: beside it, but on Windows in the
/// local AppData, since the library is in the roaming one; beside it there
/// too when the data folder is set by `KOONAPIN_DATA_DIR`. A phone's goes to
/// the cache folder the system gives the app (NP-151).
pub fn root_for(paths: &Paths) -> PathBuf {
    if let Some(cache) = &paths.cache {
        return cache.join(FOLDER);
    }
    #[cfg(windows)]
    if std::env::var_os(crate::db::DATA_DIR_ENV).is_none() {
        if let Some(local) = dirs::data_local_dir() {
            return local.join(crate::db::BRAND_FOLDER).join(crate::db::DATA_FOLDER).join(FOLDER);
        }
    }
    paths.folder().join(FOLDER)
}

/// Time Machine leaves the folder out, as `tmutil addexclusion` would; best effort.
#[cfg(target_os = "macos")]
fn exclude_from_backups(path: &Path) {
    use std::os::unix::ffi::OsStrExt;
    // The binary plist of the string "com.apple.backupd", as tmutil writes it.
    const VALUE: &[u8] = b"bplist00_\x10\x11com.apple.backupd\x08\x00\x00\x00\x00\x00\x00\x01\x01\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x1c";
    let (Ok(path), Ok(name)) = (
        std::ffi::CString::new(path.as_os_str().as_bytes()),
        std::ffi::CString::new("com.apple.metadata:com_apple_backup_excludeItem"),
    ) else {
        return;
    };
    // SAFETY: both strings are NUL-terminated and outlive the call; VALUE is a static buffer of its length.
    unsafe {
        libc::setxattr(path.as_ptr(), name.as_ptr(), VALUE.as_ptr().cast(), VALUE.len(), 0, 0);
    }
}

#[cfg(not(target_os = "macos"))]
fn exclude_from_backups(_: &Path) {}

fn age(modified: SystemTime, now: SystemTime) -> Duration {
    now.duration_since(modified).unwrap_or_default()
}

/// What the folder holds for `key`.
#[derive(Debug, PartialEq, Eq)]
enum Cached {
    File(PathBuf, Format),
    /// A fetch failed within its retry window.
    Miss(Miss),
    Nothing,
}

fn cached(root: &Path, key: &str, size: Size, now: SystemTime) -> Cached {
    for &format in Format::of(size) {
        let path = file(root, key, size, format.ext());
        if path.is_file() {
            return Cached::File(path, format);
        }
    }
    let path = file(root, key, size, "miss");
    let Some(modified) = fs::metadata(&path).and_then(|m| m.modified()).ok() else {
        return Cached::Nothing;
    };
    let miss = Miss::read(&fs::read(&path).unwrap_or_default());
    if age(modified, now) < miss.retry() {
        Cached::Miss(miss)
    } else {
        Cached::Nothing
    }
}

/// Writes `bytes` under a `.partial-` name beside `path` and renames it into place.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().ok_or_else(|| std::io::Error::other("no folder"))?;
    fs::create_dir_all(dir)?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let temp = dir.join(format!("{name}{PARTIAL}{}", uuid::Uuid::new_v4().simple()));
    fs::write(&temp, bytes)?;
    fs::rename(&temp, path).inspect_err(|_| {
        let _ = fs::remove_file(&temp);
    })
}

/// The newest-first queue of fetches: at most `total` at once, `per_host` to one site.
pub struct Queue {
    total: usize,
    per_host: usize,
    state: Mutex<QueueState>,
}

#[derive(Default)]
struct QueueState {
    running: usize,
    hosts: HashMap<String, usize>,
    waiting: Vec<Waiter>,
    next: u64,
}

struct Waiter {
    id: u64,
    host: String,
    rank: Arc<AtomicU64>,
    granted: oneshot::Sender<()>,
}

/// A fetch's turn; given back when dropped.
pub struct Slot<'q> {
    queue: &'q Queue,
    host: String,
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        let mut state = self.queue.state.lock().unwrap_or_else(|e| e.into_inner());
        release(&mut state, &self.host);
        self.queue.dispatch(&mut state);
    }
}

fn release(state: &mut QueueState, host: &str) {
    state.running = state.running.saturating_sub(1);
    if let Some(n) = state.hosts.get_mut(host) {
        *n = n.saturating_sub(1);
        if *n == 0 {
            state.hosts.remove(host);
        }
    }
}

impl Queue {
    pub fn new(total: usize, per_host: usize) -> Queue {
        Queue {
            total,
            per_host,
            state: Mutex::default(),
        }
    }

    fn free(&self, state: &QueueState, host: &str) -> bool {
        state.running < self.total && state.hosts.get(host).copied().unwrap_or(0) < self.per_host
    }

    fn take(state: &mut QueueState, host: &str) {
        state.running += 1;
        *state.hosts.entry(host.to_string()).or_default() += 1;
    }

    /// Hands free turns to the highest-ranked waiters whose site has room.
    fn dispatch(&self, state: &mut QueueState) {
        loop {
            let best = state
                .waiting
                .iter()
                .enumerate()
                .filter(|(_, w)| self.free(state, &w.host))
                .max_by_key(|(_, w)| (w.rank.load(Ordering::Relaxed), w.id))
                .map(|(i, _)| i);
            let Some(index) = best else { return };
            let waiter = state.waiting.swap_remove(index);
            Queue::take(state, &waiter.host);
            if waiter.granted.send(()).is_err() {
                release(state, &waiter.host);
            }
        }
    }

    /// A turn for `host` within `wait`; the higher `rank`, the sooner. None when the wait ran out.
    pub async fn acquire(&self, host: &str, rank: Arc<AtomicU64>, wait: Duration) -> Option<Slot<'_>> {
        let (id, granted) = {
            let mut state = self.state.lock().ok()?;
            if self.free(&state, host) && state.waiting.is_empty() {
                Queue::take(&mut state, host);
                return Some(Slot { queue: self, host: host.to_string() });
            }
            let (tx, rx) = oneshot::channel();
            state.next += 1;
            let id = state.next;
            state.waiting.push(Waiter { id, host: host.to_string(), rank, granted: tx });
            // Room for this one even with others waiting: another site's.
            self.dispatch(&mut state);
            (id, rx)
        };
        let mut granted = granted;
        match tokio::time::timeout(wait, &mut granted).await {
            Ok(Ok(())) => Some(Slot { queue: self, host: host.to_string() }),
            _ => {
                let mut state = self.state.lock().ok()?;
                if let Some(index) = state.waiting.iter().position(|w| w.id == id) {
                    state.waiting.swap_remove(index);
                    return None;
                }
                drop(state);
                // Granted just as the wait ran out: the turn is given back.
                if granted.try_recv().is_ok() {
                    drop(Slot { queue: self, host: host.to_string() });
                }
                None
            }
        }
    }
}

/// Why a fetch kept nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fault {
    /// No connection, a server error: tried again on the next display, no `.miss`.
    Offline,
    Miss(Miss),
}

/// Where a fetch is.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Phase {
    Queued,
    Running,
    Done(Outcome),
}

/// What a request gets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    File(PathBuf, Format),
    /// The guard refused the address: the sentinel, and the card shows its cover.
    Refused,
    /// Nothing now: the card may load the source address itself.
    Nothing,
}

struct Flight {
    phase: watch::Receiver<Phase>,
    rank: Arc<AtomicU64>,
}

/// Ranks of displayed pictures are above every warm one's.
fn display_rank() -> u64 {
    (1 << 62) + RANKS.fetch_add(1, Ordering::Relaxed)
}

fn warm_rank() -> u64 {
    RANKS.fetch_add(1, Ordering::Relaxed)
}

/// The network looked down: misses are a 404 at once for a while.
#[derive(Default)]
struct Breaker {
    failures: u32,
    open_until: Option<Instant>,
}

/// A database read on a read-only connection of its own: the writer's lock
/// is never taken for a picture. Opened on first use, again after an error.
struct Reader {
    path: PathBuf,
    conn: Mutex<Option<Connection>>,
}

impl Reader {
    fn new(path: PathBuf) -> Reader {
        Reader { path, conn: Mutex::new(None) }
    }

    fn read<T>(&self, query: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Option<T> {
        let mut conn = self.conn.lock().ok()?;
        if conn.is_none() {
            let opened = Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).ok()?;
            let _ = opened.busy_timeout(Duration::from_secs(2));
            *conn = Some(opened);
        }
        match query(conn.as_ref()?) {
            Ok(value) => Some(value),
            Err(_) => {
                *conn = None;
                None
            }
        }
    }
}

/// The cache of the open library: its folder, the read-only connections, the client.
pub struct Thumbs {
    root: PathBuf,
    library: Reader,
    /// None while the feed cache is in memory or missing: no feed pictures, no sweep.
    feeds: Option<Reader>,
    client: reqwest::Client,
    limits: &'static Limits,
    breaker: Mutex<Breaker>,
}

impl Thumbs {
    /// `library` and `feeds` are the database files; `limits` is [`LIMITS`] outside tests.
    pub fn new(root: PathBuf, library: PathBuf, feeds: Option<PathBuf>, limits: &'static Limits) -> reqwest::Result<Thumbs> {
        Ok(Thumbs {
            root,
            library: Reader::new(library),
            feeds: feeds.map(Reader::new),
            client: metadata::client(limits)?,
            limits,
            breaker: Mutex::default(),
        })
    }

    fn source(&self, picture: &Picture) -> Option<String> {
        match picture {
            Picture::BookmarkImage(_) | Picture::BookmarkIcon(_) => self.library.read(|c| library_source(c, picture)).flatten(),
            Picture::PostThumb(_) | Picture::FeedIcon(_) => self.feeds.as_ref()?.read(|c| feed_source(c, picture)).flatten(),
        }
    }

    fn broken(&self) -> bool {
        let mut breaker = self.breaker.lock().unwrap_or_else(|e| e.into_inner());
        match breaker.open_until {
            Some(until) if Instant::now() < until => true,
            Some(_) => {
                breaker.open_until = None;
                false
            }
            None => false,
        }
    }

    /// A fetch's end: a connection failure counts towards the breaker, any answer resets it.
    fn connected(&self, ok: bool) {
        let mut breaker = self.breaker.lock().unwrap_or_else(|e| e.into_inner());
        if ok {
            breaker.failures = 0;
        } else {
            breaker.failures += 1;
            if breaker.failures >= BREAKER_AFTER {
                breaker.failures = 0;
                breaker.open_until = Some(Instant::now() + BREAKER_FOR);
            }
        }
    }
}

/// The body of a picture: an allowed http(s) address, a 2xx answer, at most
/// `max_body`. Through [`metadata::client`] as it is: no proxy, no cookies,
/// no Referer; the first address is checked here, each redirect by the client.
async fn download(thumbs: &Thumbs, url: Url) -> Result<Vec<u8>, Fault> {
    match metadata::check_address(&url, thumbs.limits.allow).await {
        Ok(()) => {}
        Err(FetchError::Refused) => return Err(Fault::Miss(Miss::Refused)),
        // A name that does not resolve: offline looks the same.
        Err(_) => return Err(Fault::Offline),
    }
    let mut response = thumbs.client.get(url).send().await.map_err(|e| {
        if e.is_redirect() {
            return Fault::Miss(Miss::Failed);
        }
        match metadata::failure(&e) {
            FetchError::Refused => Fault::Miss(Miss::Refused),
            // No connection at all, timed out or not, is the network's fault, not the picture's.
            _ if e.is_connect() => Fault::Offline,
            FetchError::Timeout => Fault::Miss(Miss::Timeout),
            FetchError::Failed => Fault::Offline,
        }
    })?;
    let status = response.status();
    if !status.is_success() {
        // 408 and 429 pass; a server error may too.
        let lasting = (status.is_client_error() && !matches!(status.as_u16(), 408 | 429)) || status.is_redirection();
        return Err(if lasting { Fault::Miss(Miss::Failed) } else { Fault::Offline });
    }
    let max = thumbs.limits.max_body;
    if response.content_length().is_some_and(|n| n > max as u64) {
        return Err(Fault::Miss(Miss::Failed));
    }
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => body.extend_from_slice(&chunk),
            Ok(None) => return Ok(body),
            Err(e) if e.is_timeout() => return Err(Fault::Miss(Miss::Timeout)),
            Err(_) => return Err(Fault::Offline),
        }
        if body.len() > max {
            return Err(Fault::Miss(Miss::Failed));
        }
    }
}

/// An SVG document, as far as its start tells: text, then `<svg` after any
/// prolog, comments or doctype; no script and no entity declarations.
fn looks_like_svg(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else { return false };
    let text = text.trim_start_matches('\u{feff}').trim_start();
    if !text.starts_with('<') {
        return false;
    }
    let lower = text.to_ascii_lowercase();
    let head = &lower[..lower.len().min(4096)];
    let Some(at) = head.find("<svg") else { return false };
    // Before `<svg` only the prolog: `<?xml`, comments, a doctype.
    let only_prolog = head[..at].split('<').skip(1).all(|tag| tag.starts_with('?') || tag.starts_with('!'));
    only_prolog && !lower.contains("<script") && !lower.contains("<!entity") && lower.contains("</svg>")
}

fn reader_limits() -> image::Limits {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(MAX_ALLOC);
    limits
}

/// Decodes by the bytes, whatever the header said: JPEG, PNG, GIF (its
/// first frame), WebP, ICO, BMP, under [`reader_limits`], turned as its EXIF says.
fn decode(bytes: &[u8]) -> Option<DynamicImage> {
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format().ok()?;
    let format = reader.format()?;
    if !matches!(format, ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::Gif | ImageFormat::WebP | ImageFormat::Ico | ImageFormat::Bmp) {
        return None;
    }
    reader.limits(reader_limits());
    let mut decoder = reader.into_decoder().ok()?;
    // The pixels' size before they are allocated: `into_decoder` checks only the sides.
    reader_limits().reserve(decoder.total_bytes()).ok()?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder).ok()?;
    image.apply_orientation(orientation);
    Some(image)
}

/// Some pixel shows what is behind it.
fn transparent(image: &DynamicImage) -> bool {
    image.color().has_alpha() && image.to_rgba8().pixels().any(|p| p.0[3] < 255)
}

/// A preview: taller than 2:1 cropped to its top, at most 640 px wide; JPEG
/// q80, or PNG when it has real transparency.
fn preview(image: DynamicImage) -> Option<(Vec<u8>, Format)> {
    let (w, h) = image.dimensions();
    if w == 0 || h == 0 {
        return None;
    }
    let image = if h > w.saturating_mul(2) { image.crop_imm(0, 0, w, w * 2) } else { image };
    let (w, h) = image.dimensions();
    let image = if w > PREVIEW_WIDTH {
        let height = ((h as u64 * PREVIEW_WIDTH as u64 + w as u64 / 2) / w as u64).max(1) as u32;
        image.resize_exact(PREVIEW_WIDTH, height, FILTER)
    } else {
        image
    };
    let mut out = Cursor::new(Vec::new());
    if transparent(&image) {
        DynamicImage::ImageRgba8(image.to_rgba8()).write_with_encoder(image::codecs::png::PngEncoder::new(&mut out)).ok()?;
        return Some((out.into_inner(), Format::Png));
    }
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY);
    DynamicImage::ImageRgb8(image.to_rgb8()).write_with_encoder(encoder).ok()?;
    Some((out.into_inner(), Format::Jpeg))
}

/// An icon: within 96 × 96, PNG.
fn icon(image: DynamicImage) -> Option<(Vec<u8>, Format)> {
    let (w, h) = image.dimensions();
    if w == 0 || h == 0 {
        return None;
    }
    let image = if w > ICON_SIDE || h > ICON_SIDE { image.resize(ICON_SIDE, ICON_SIDE, FILTER) } else { image };
    let image = if image.color().has_alpha() { DynamicImage::ImageRgba8(image.to_rgba8()) } else { DynamicImage::ImageRgb8(image.to_rgb8()) };
    let mut out = Cursor::new(Vec::new());
    image.write_with_encoder(image::codecs::png::PngEncoder::new(&mut out)).ok()?;
    Some((out.into_inner(), Format::Png))
}

/// What a fetched body is kept as; none when it is not a picture this size class takes.
fn make(bytes: &[u8], size: Size) -> Option<(Vec<u8>, Format)> {
    if size == Size::Icon && looks_like_svg(bytes) {
        return (bytes.len() <= MAX_SVG).then(|| (bytes.to_vec(), Format::Svg));
    }
    let image = decode(bytes)?;
    match size {
        Size::Preview => preview(image),
        Size::Icon => icon(image),
    }
}

/// Writes what a fetch gave: the file, or the `.miss` that says why not.
fn store(root: &Path, key: &str, size: Size, made: Result<(Vec<u8>, Format), Fault>) -> Outcome {
    let miss = file(root, key, size, "miss");
    match made {
        Ok((bytes, format)) => {
            let path = file(root, key, size, format.ext());
            if write_atomic(&path, &bytes).is_err() {
                return Outcome::Nothing;
            }
            let _ = fs::remove_file(miss);
            Outcome::File(path, format)
        }
        Err(Fault::Miss(kind)) => {
            let _ = write_atomic(&miss, kind.content());
            if kind == Miss::Refused {
                Outcome::Refused
            } else {
                Outcome::Nothing
            }
        }
        Err(Fault::Offline) => Outcome::Nothing,
    }
}

fn of_cached(cached: Cached) -> Option<Outcome> {
    match cached {
        Cached::File(path, format) => Some(Outcome::File(path, format)),
        Cached::Miss(Miss::Refused) => Some(Outcome::Refused),
        Cached::Miss(_) => Some(Outcome::Nothing),
        Cached::Nothing => None,
    }
}

/// One fetch: waits for its turn, fetches, decodes (two at a time), writes.
async fn fly(thumbs: Arc<Thumbs>, key: String, url: Url, size: Size, rank: Arc<AtomicU64>, queued: Duration, phase: watch::Sender<Phase>) -> Outcome {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let Some(slot) = QUEUE.acquire(&host, rank, queued).await else {
        return Outcome::Nothing;
    };
    let _ = phase.send(Phase::Running);
    let (root, k) = (thumbs.root.clone(), key.clone());
    // A fetch that finished while this one waited.
    if let Some(done) = tokio::task::spawn_blocking(move || of_cached(cached(&root, &k, size, SystemTime::now()))).await.ok().flatten() {
        return done;
    }
    let body = download(&thumbs, url).await;
    drop(slot);
    thumbs.connected(!matches!(body, Err(Fault::Offline) | Err(Fault::Miss(Miss::Timeout))));
    let made = match body {
        Ok(body) => {
            let Ok(_decoding) = DECODES.acquire().await else { return Outcome::Nothing };
            tokio::task::spawn_blocking(move || make(&body, size)).await.ok().flatten().ok_or(Fault::Miss(Miss::Failed))
        }
        Err(fault) => Err(fault),
    };
    let root = thumbs.root.clone();
    tokio::task::spawn_blocking(move || store(&root, &key, size, made)).await.unwrap_or(Outcome::Nothing)
}

/// The fetch of `address` in this size class, joined or started. A displayed
/// picture (`wait` set) waits that long for the fetch to start, then gives
/// up and leaves it queued; a warm one only starts it.
async fn fetch(thumbs: &Arc<Thumbs>, address: &str, size: Size, wait: Option<Duration>) -> Outcome {
    if thumbs.broken() {
        return Outcome::Nothing;
    }
    let key = key(address);
    let url = match Url::parse(address.trim()) {
        Ok(url) if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() => url,
        // Not the web: never asked, the card shows its cover.
        _ => {
            let root = thumbs.root.clone();
            return tokio::task::spawn_blocking(move || store(&root, &key, size, Err(Fault::Miss(Miss::Refused)))).await.unwrap_or(Outcome::Refused);
        }
    };
    let name = format!("{}|{key}|{size:?}", thumbs.root.display());
    let rank = if wait.is_some() { display_rank() } else { warm_rank() };
    let mut phase = {
        let Ok(mut flights) = FLIGHTS.lock() else { return Outcome::Nothing };
        match flights.get(&name) {
            Some(flight) => {
                // Asked again: it moves up.
                flight.rank.fetch_max(rank, Ordering::Relaxed);
                flight.phase.clone()
            }
            None => {
                let (tx, rx) = watch::channel(Phase::Queued);
                let rank = Arc::new(AtomicU64::new(rank));
                flights.insert(name.clone(), Flight { phase: rx.clone(), rank: rank.clone() });
                let queued = if wait.is_some() { QUEUED } else { WARM_QUEUED };
                let thumbs = thumbs.clone();
                tauri::async_runtime::spawn(async move {
                    let outcome = fly(thumbs, key, url, size, rank, queued, tx.clone()).await;
                    if let Ok(mut flights) = FLIGHTS.lock() {
                        flights.remove(&name);
                    }
                    let _ = tx.send(Phase::Done(outcome));
                });
                rx
            }
        }
    };
    let Some(wait) = wait else { return Outcome::Nothing };
    let started = matches!(tokio::time::timeout(wait, phase.wait_for(|p| *p != Phase::Queued)).await, Ok(Ok(_)));
    if !started {
        return Outcome::Nothing;
    }
    match phase.wait_for(|p| matches!(p, Phase::Done(_))).await.map(|p| (*p).clone()) {
        Ok(Phase::Done(outcome)) => outcome,
        _ => Outcome::Nothing,
    }
}

/// The 1 × 1 transparent PNG of a refused address.
fn sentinel() -> &'static [u8] {
    static PNG: OnceLock<Vec<u8>> = OnceLock::new();
    PNG.get_or_init(|| {
        let mut out = Cursor::new(Vec::new());
        let _ = DynamicImage::ImageRgba8(image::RgbaImage::new(1, 1)).write_to(&mut out, ImageFormat::Png);
        out.into_inner()
    })
}

fn respond_with(status: StatusCode, headers: &[(&str, &str)], body: Vec<u8>) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(status)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CONTENT_SECURITY_POLICY, SANDBOX);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(body).unwrap_or_default()
}

fn refused() -> Response<Vec<u8>> {
    respond_with(
        StatusCode::OK,
        &[("Content-Type", "image/png"), ("Cache-Control", "no-store"), (REFUSED_HEADER, "refused")],
        sentinel().to_vec(),
    )
}

/// The answer to a `kpimg` path: 200 with the file; 200 with a 1 × 1
/// transparent PNG and `X-Kpimg: refused` for an address the guard refuses
/// (show the cover, not the web); 404 when there is nothing now (no address,
/// a failed or slow fetch, offline: the card may load the address itself);
/// 400 for a path that names nothing. `?v=` is not read: it only tells the
/// WebView a picture changed.
pub async fn respond(thumbs: &Arc<Thumbs>, path: &str) -> Response<Vec<u8>> {
    let Some(picture) = Picture::parse(path) else {
        return respond_with(StatusCode::BAD_REQUEST, &[], Vec::new());
    };
    let size = picture.size();
    // The lookup, the stat and the read in one blocking step.
    let found = {
        let thumbs = thumbs.clone();
        tokio::task::spawn_blocking(move || {
            let address = thumbs.source(&picture)?;
            let hit = match cached(&thumbs.root, &key(&address), size, SystemTime::now()) {
                Cached::File(path, format) => fs::read(path).ok().map(|bytes| (bytes, format)),
                _ => None,
            };
            Some((address, hit))
        })
        .await
        .ok()
        .flatten()
    };
    let not_found = || respond_with(StatusCode::NOT_FOUND, &[], Vec::new());
    let Some((address, hit)) = found else { return not_found() };
    let served = |bytes: Vec<u8>, format: Format| respond_with(StatusCode::OK, &[("Content-Type", format.mime()), ("Cache-Control", CACHE_CONTROL)], bytes);
    if let Some((bytes, format)) = hit {
        return served(bytes, format);
    }
    let root = thumbs.root.clone();
    let k = key(&address);
    let known = tokio::task::spawn_blocking(move || of_cached(cached(&root, &k, size, SystemTime::now()))).await.ok().flatten();
    let outcome = match known {
        Some(outcome) => outcome,
        None => fetch(thumbs, &address, size, Some(SLOT_WAIT)).await,
    };
    match outcome {
        Outcome::File(path, format) => match tokio::task::spawn_blocking(move || fs::read(path)).await {
            Ok(Ok(bytes)) => served(bytes, format),
            // Swept meanwhile: the next display fetches it again.
            _ => not_found(),
        },
        Outcome::Refused => refused(),
        Outcome::Nothing => not_found(),
    }
}

/// The `kpimg` scheme: it only spawns; [`respond`] answers.
pub fn protocol<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: tauri::http::Request<Vec<u8>>, responder: UriSchemeResponder) {
    let path = request.uri().path().to_string();
    let thumbs = ctx.app_handle().try_state::<Arc<Thumbs>>().map(|t| t.inner().clone());
    tauri::async_runtime::spawn(async move {
        let response = match thumbs {
            Some(thumbs) => respond(&thumbs, &path).await,
            // The library is still opening.
            None => respond_with(StatusCode::NOT_FOUND, &[], Vec::new()),
        };
        responder.respond(response);
    });
}

/// A saved link's picture and icon, fetched in the background once its
/// metadata is stored: a save, a capture, «Обновить превью» on one bookmark.
/// Not for a run over many. Nothing waits for it; what is displayed comes first.
pub fn warm<R: Runtime>(app: &AppHandle<R>, bookmark: &Bookmark) {
    let Some(thumbs) = app.try_state::<Arc<Thumbs>>().map(|t| t.inner().clone()) else { return };
    let wanted: Vec<(String, Size)> = [(&bookmark.image_url, Size::Preview), (&bookmark.favicon_url, Size::Icon)]
        .into_iter()
        .filter_map(|(address, size)| address.as_ref().filter(|a| !a.trim().is_empty()).map(|a| (a.clone(), size)))
        .collect();
    if wanted.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        for (address, size) in wanted {
            let (root, k) = (thumbs.root.clone(), key(&address));
            let known = tokio::task::spawn_blocking(move || cached(&root, &k, size, SystemTime::now())).await;
            if matches!(known, Ok(Cached::Nothing)) {
                fetch(&thumbs, &address, size, None).await;
            }
        }
    });
}

/// What a sweep removed.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Swept {
    pub files: usize,
    pub bytes: u64,
}

struct Entry {
    path: PathBuf,
    name: String,
    modified: SystemTime,
    bytes: u64,
}

fn list(root: &Path) -> Vec<Entry> {
    let mut entries = Vec::new();
    let Ok(dirs) = fs::read_dir(root) else { return entries };
    for dir in dirs.flatten() {
        let Ok(files) = fs::read_dir(dir.path()) else { continue };
        for entry in files.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_file() {
                entries.push(Entry {
                    path: entry.path(),
                    name: entry.file_name().to_string_lossy().into_owned(),
                    modified: meta.modified().unwrap_or_else(|_| SystemTime::now()),
                    bytes: meta.len(),
                });
            }
        }
    }
    entries
}

/// The key and the rest of a cache file's name, when it is one.
fn parse_name(name: &str) -> Option<(&str, &str)> {
    let (stem, rest) = name.split_once('.')?;
    let known = matches!(rest, "jpg" | "png" | "miss" | "icon.png" | "icon.svg" | "icon.miss");
    (known && stem.len() == 64 && stem.bytes().all(|b| b.is_ascii_hexdigit())).then_some((stem, rest))
}

/// Mark and sweep, outside every lock. The files are listed first, then
/// `referenced` is asked for the keys still in use, so a file written
/// meanwhile is not in the list; none means the set is incomplete and nothing
/// goes. Removed: files of other keys a day after they were written, `.miss`
/// past its retry, `.partial-` files a day old; then over `cap`, the oldest
/// written down to 90%.
pub fn sweep_folder(root: &Path, now: SystemTime, cap: u64, referenced: impl FnOnce() -> Option<HashSet<String>>) -> Option<Swept> {
    let entries = list(root);
    let referenced = referenced()?;
    let mut swept = Swept::default();
    let remove = |entry: &Entry, swept: &mut Swept| {
        if fs::remove_file(&entry.path).is_ok() {
            swept.files += 1;
            swept.bytes += entry.bytes;
        }
    };
    let mut kept = Vec::new();
    for entry in entries {
        let old = age(entry.modified, now) > GRACE;
        if entry.name.contains(PARTIAL) {
            if old {
                remove(&entry, &mut swept);
            }
            continue;
        }
        let Some((key, rest)) = parse_name(&entry.name) else { continue };
        let stale = rest.ends_with("miss") && age(entry.modified, now) > Miss::read(&fs::read(&entry.path).unwrap_or_default()).retry();
        if stale || (old && !referenced.contains(key)) {
            remove(&entry, &mut swept);
        } else {
            kept.push(entry);
        }
    }
    let mut total: u64 = kept.iter().map(|e| e.bytes).sum();
    if total > cap {
        kept.sort_by_key(|e| e.modified);
        let target = cap / 10 * 9;
        for entry in kept {
            if total <= target {
                break;
            }
            remove(&entry, &mut swept);
            total = total.saturating_sub(entry.bytes);
        }
    }
    Some(swept)
}

/// A sweep of the open library's cache; none when the feed cache is not on
/// disk, since its references would be missing.
pub fn sweep(thumbs: &Thumbs) -> Option<Swept> {
    let feeds = thumbs.feeds.as_ref()?;
    sweep_folder(&thumbs.root, SystemTime::now(), CAP, || {
        let library = thumbs.library.read(library_addresses)?;
        let feeds = feeds.read(feed_addresses)?;
        Some(keys(library.iter().chain(feeds.iter())))
    })
}

/// Bookmarks were deleted for good (`db::purge_trash`) or the feed cache
/// cleared: the sweep runs a minute later, once for a series of them.
pub fn sweep_soon() {
    SWEEP.notify_one();
}

/// Manages the cache of the library just opened and sweeps it now and after
/// each [`sweep_soon`]. Called once, after the library and the feed cache.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let Some(library) = app.try_state::<Arc<Library>>() else { return };
    if app.try_state::<Arc<DbState>>().is_none() {
        return;
    }
    let root = root_for(&library.paths);
    if fs::create_dir_all(&root).is_ok() {
        exclude_from_backups(&root);
    }
    // The cache on disk only: one in memory is not this file.
    let feeds = app.try_state::<Arc<FeedCache>>().and_then(|cache| {
        let on_disk = cache.conn.lock().ok()?.path().is_some_and(|p| !p.is_empty());
        on_disk.then(|| cache.path.clone())
    });
    #[cfg(not(feature = "public-release"))]
    let limits: &'static Limits = if std::env::var_os(LOOPBACK_ENV).is_some() { &LOOPBACK_LIMITS } else { &LIMITS };
    #[cfg(feature = "public-release")]
    let limits: &'static Limits = &LIMITS;
    let thumbs = match Thumbs::new(root, library.paths.database.clone(), feeds, limits) {
        Ok(thumbs) => Arc::new(thumbs),
        Err(error) => {
            eprintln!("The picture cache cannot start: {error}");
            return;
        }
    };
    app.manage(thumbs.clone());
    tauri::async_runtime::spawn(async move {
        loop {
            let swept = {
                let thumbs = thumbs.clone();
                tokio::task::spawn_blocking(move || sweep(&thumbs)).await.ok().flatten()
            };
            if let Some(swept) = swept.filter(|s| s.files > 0) {
                eprintln!("Picture cache: removed {} files, {} bytes", swept.files, swept.bytes);
            }
            SWEEP.notified().await;
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{insert_or_update_bookmark, trash_bookmark, Source};
    use crate::library;
    use image::{Rgba, RgbaImage};
    use std::io::{Read, Write};
    use std::net::{IpAddr, Ipv4Addr, TcpListener};
    use std::sync::atomic::AtomicUsize;

    fn folder(name: &str) -> PathBuf {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.test-data")
            .join(format!("thumbs-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn picture(w: u32, h: u32, alpha: u8) -> DynamicImage {
        DynamicImage::ImageRgba8(RgbaImage::from_fn(w, h, |x, y| Rgba([(x % 256) as u8, (y % 256) as u8, 90, alpha])))
    }

    fn encoded(image: &DynamicImage, format: ImageFormat) -> Vec<u8> {
        let image = match format {
            ImageFormat::Jpeg | ImageFormat::Bmp => DynamicImage::ImageRgb8(image.to_rgb8()),
            _ => image.clone(),
        };
        let mut out = Cursor::new(Vec::new());
        image.write_to(&mut out, format).unwrap();
        out.into_inner()
    }

    fn decoded(bytes: &[u8]) -> DynamicImage {
        image::load_from_memory(bytes).unwrap()
    }

    #[test]
    fn keys_are_the_hex_sha256_of_the_address_under_its_first_two_letters() {
        let k = key("https://example.com/a.png");
        assert_eq!(k.len(), 64);
        assert!(k.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        assert_eq!(key("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let root = Path::new("/lib/thumbs");
        assert_eq!(file(root, &k, Size::Preview, "jpg"), root.join(&k[..2]).join(format!("{k}.jpg")));
        assert_eq!(file(root, &k, Size::Icon, "png"), root.join(&k[..2]).join(format!("{k}.icon.png")));
        assert_eq!(file(root, &k, Size::Icon, "miss"), root.join(&k[..2]).join(format!("{k}.icon.miss")));
        assert_ne!(key("https://example.com/a.png"), key("https://example.com/a.png "), "the address as stored");
        for name in [format!("{k}.jpg"), format!("{k}.png"), format!("{k}.miss"), format!("{k}.icon.png"), format!("{k}.icon.svg"), format!("{k}.icon.miss")] {
            assert_eq!(parse_name(&name).map(|p| p.0), Some(k.as_str()), "{name}");
        }
        for name in [format!("{k}.gif"), format!("{k}.jpg{PARTIAL}1"), "koonapin.db".into(), "ab.jpg".into()] {
            assert_eq!(parse_name(&name), None, "{name}");
        }
    }

    #[test]
    fn paths_parse_encoded_or_not_and_nothing_else() {
        assert_eq!(Picture::parse("/b%2F12%2Fimage"), Some(Picture::BookmarkImage(12)));
        assert_eq!(Picture::parse("/b/12/icon"), Some(Picture::BookmarkIcon(12)));
        assert_eq!(Picture::parse("/p%2F7%2Fthumb"), Some(Picture::PostThumb(7)));
        assert_eq!(
            Picture::parse("/f%2F0192f0c4-7a1b-7c3d-9e2f-0123456789ab%2Ficon"),
            Some(Picture::FeedIcon("0192f0c4-7a1b-7c3d-9e2f-0123456789ab".into()))
        );
        assert_eq!(Picture::parse("b/3/image"), Some(Picture::BookmarkImage(3)));
        for bad in [
            "/", "", "/b", "/b/12", "/b/12/image/x", "/b/-1/image", "/b/1e3/image", "/b//image", "/b/12/thumb", "/x/1/icon",
            "/f/..%2F..%2Fetc/icon", "/f/a%20b/icon", "/f//icon", "/b/99999999999999999999/image", "/b%2F12%2Fimage%FF",
            "/p/7/image", "/f/abc/thumb",
        ] {
            assert_eq!(Picture::parse(bad), None, "{bad}");
        }
        assert_eq!(Picture::BookmarkImage(1).size(), Size::Preview);
        assert_eq!(Picture::PostThumb(1).size(), Size::Preview);
        assert_eq!(Picture::BookmarkIcon(1).size(), Size::Icon);
        assert_eq!(Picture::FeedIcon("a".into()).size(), Size::Icon);
    }

    #[test]
    fn every_input_format_becomes_a_preview_and_an_icon() {
        let source = picture(800, 600, 255);
        for format in [ImageFormat::Jpeg, ImageFormat::Png, ImageFormat::Gif, ImageFormat::WebP, ImageFormat::Bmp, ImageFormat::Ico] {
            // ICO holds 256 px at most.
            let source = if format == ImageFormat::Ico { picture(200, 150, 255) } else { source.clone() };
            let bytes = encoded(&source, format);
            let (jpeg, kind) = make(&bytes, Size::Preview).unwrap_or_else(|| panic!("{format:?} preview"));
            assert_eq!(kind, Format::Jpeg, "{format:?}: opaque");
            assert_eq!(image::guess_format(&jpeg).unwrap(), ImageFormat::Jpeg);
            let expected = if source.width() > 640 { (640, 480) } else { source.dimensions() };
            assert_eq!(decoded(&jpeg).dimensions(), expected, "{format:?}");
            let (png, kind) = make(&bytes, Size::Icon).unwrap_or_else(|| panic!("{format:?} icon"));
            assert_eq!(kind, Format::Png);
            assert_eq!(image::guess_format(&png).unwrap(), ImageFormat::Png);
            assert_eq!(decoded(&png).dimensions(), (96, 72), "{format:?}");
        }
    }

    #[test]
    fn a_gif_gives_its_first_frame() {
        use image::codecs::gif::GifEncoder;
        use image::{Delay, Frame};
        let mut out = Vec::new();
        {
            let mut encoder = GifEncoder::new(&mut out);
            for colour in [[250, 10, 10, 255], [10, 10, 250, 255]] {
                let frame = Frame::from_parts(RgbaImage::from_pixel(20, 20, Rgba(colour)), 0, 0, Delay::from_numer_denom_ms(100, 1));
                encoder.encode_frame(frame).unwrap();
            }
        }
        let (png, _) = make(&out, Size::Icon).unwrap();
        let [r, _, b, _] = decoded(&png).to_rgba8().get_pixel(5, 5).0;
        assert!(r > 200 && b < 50, "{r} {b}");
    }

    /// A JPEG with an EXIF APP1 segment saying `orientation`.
    fn with_orientation(jpeg: &[u8], orientation: u16) -> Vec<u8> {
        let mut tiff = b"II*\0\x08\0\0\0\x01\0".to_vec();
        tiff.extend_from_slice(&0x0112u16.to_le_bytes());
        tiff.extend_from_slice(&3u16.to_le_bytes());
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&orientation.to_le_bytes());
        tiff.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(&tiff);
        let mut out = jpeg[..2].to_vec();
        out.extend_from_slice(&[0xFF, 0xE1]);
        out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        out.extend_from_slice(&payload);
        out.extend_from_slice(&jpeg[2..]);
        out
    }

    #[test]
    fn exif_orientation_is_applied_before_the_resize() {
        let jpeg = encoded(&picture(1200, 600, 255), ImageFormat::Jpeg);
        assert_eq!(decoded(&make(&jpeg, Size::Preview).unwrap().0).dimensions(), (640, 320));
        // 6: turned 90° clockwise to be seen upright, so it is tall.
        let turned = with_orientation(&jpeg, 6);
        assert_eq!(decoded(&make(&turned, Size::Preview).unwrap().0).dimensions(), (600, 1200));
        assert_eq!(decoded(&make(&turned, Size::Icon).unwrap().0).dimensions(), (48, 96));
    }

    #[test]
    fn previews_are_never_upscaled_tall_ones_are_cropped_and_transparent_ones_stay_png() {
        let small = encoded(&picture(300, 200, 255), ImageFormat::Png);
        assert_eq!(decoded(&make(&small, Size::Preview).unwrap().0).dimensions(), (300, 200));
        let tall = encoded(&picture(400, 2000, 255), ImageFormat::Png);
        assert_eq!(decoded(&make(&tall, Size::Preview).unwrap().0).dimensions(), (400, 800));
        let tall_wide = encoded(&picture(1280, 4000, 255), ImageFormat::Png);
        assert_eq!(decoded(&make(&tall_wide, Size::Preview).unwrap().0).dimensions(), (640, 1280));
        let clear = encoded(&picture(800, 400, 100), ImageFormat::Png);
        let (png, format) = make(&clear, Size::Preview).unwrap();
        assert_eq!(format, Format::Png);
        let kept = decoded(&png);
        assert_eq!(kept.dimensions(), (640, 320));
        assert!(kept.to_rgba8().get_pixel(10, 10).0[3] < 255);
        // An alpha channel that is opaque everywhere is a JPEG.
        assert_eq!(make(&encoded(&picture(50, 50, 255), ImageFormat::Png), Size::Preview).unwrap().1, Format::Jpeg);
        let tiny = encoded(&picture(16, 16, 128), ImageFormat::Png);
        let icon = decoded(&make(&tiny, Size::Icon).unwrap().0);
        assert_eq!(icon.dimensions(), (16, 16), "icons are not upscaled");
        assert!(icon.color().has_alpha(), "an icon keeps its transparency");
    }

    #[test]
    fn svg_icons_are_kept_as_they_are_within_reason() {
        let svg = br#"<?xml version="1.0"?><!-- logo --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>"#;
        assert_eq!(make(svg, Size::Icon), Some((svg.to_vec(), Format::Svg)));
        assert_eq!(make(svg, Size::Preview), None, "a preview is a raster");
        let script = br#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#;
        assert_eq!(make(script, Size::Icon), None);
        let entities = br#"<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa">]><svg>&a;</svg>"#;
        assert_eq!(make(entities, Size::Icon), None);
        assert_eq!(make(b"<html><body><svg></svg></body></html>", Size::Icon), None, "a page with an svg in it");
        let mut huge = br#"<svg xmlns="http://www.w3.org/2000/svg">"#.to_vec();
        huge.extend(std::iter::repeat_n(b' ', MAX_SVG));
        huge.extend_from_slice(b"</svg>");
        assert_eq!(make(&huge, Size::Icon), None);
        assert_eq!(make(b"not a picture at all", Size::Icon), None);
        assert_eq!(make(b"<html>Forbidden</html>", Size::Preview), None);
    }

    /// A PNG whose header promises `w` × `h`, with a valid checksum and no pixels.
    fn promised_png(w: u32, h: u32) -> Vec<u8> {
        let mut ihdr = b"IHDR".to_vec();
        ihdr.extend_from_slice(&w.to_be_bytes());
        ihdr.extend_from_slice(&h.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(&ihdr);
        png.extend_from_slice(&crc32fast::hash(&ihdr).to_be_bytes());
        png
    }

    #[test]
    fn a_bomb_is_refused_before_it_is_allocated() {
        // Over the side limit; within it but over the allocation limit (7999² × 4 bytes).
        for (w, h) in [(100_000, 100_000), (8001, 10), (7999, 7999)] {
            let started = std::time::Instant::now();
            assert!(decode(&promised_png(w, h)).is_none());
            assert_eq!(make(&promised_png(w, h), Size::Preview), None);
            assert!(started.elapsed() < Duration::from_millis(500), "{w}×{h} took {:?}", started.elapsed());
        }
    }

    #[test]
    fn misses_hold_for_their_retry_window() {
        let root = folder("miss");
        let k = key("https://example.com/gone.png");
        let now = SystemTime::now();
        assert_eq!(cached(&root, &k, Size::Preview, now), Cached::Nothing);
        write_atomic(&file(&root, &k, Size::Preview, "miss"), Miss::Failed.content()).unwrap();
        assert_eq!(cached(&root, &k, Size::Preview, now), Cached::Miss(Miss::Failed));
        assert_eq!(cached(&root, &k, Size::Preview, now + 6 * DAY), Cached::Miss(Miss::Failed));
        assert_eq!(cached(&root, &k, Size::Preview, now + 8 * DAY), Cached::Nothing);
        assert_eq!(cached(&root, &k, Size::Icon, now), Cached::Nothing, "an icon is its own file");
        write_atomic(&file(&root, &k, Size::Icon, "miss"), Miss::Timeout.content()).unwrap();
        assert_eq!(cached(&root, &k, Size::Icon, now), Cached::Miss(Miss::Timeout));
        assert_eq!(cached(&root, &k, Size::Icon, now + 2 * DAY), Cached::Nothing, "a timeout is tried again after a day");
        let r = key("http://10.0.0.1/x.png");
        write_atomic(&file(&root, &r, Size::Icon, "miss"), Miss::Refused.content()).unwrap();
        assert_eq!(cached(&root, &r, Size::Icon, now + 6 * DAY), Cached::Miss(Miss::Refused));
        write_atomic(&file(&root, &k, Size::Icon, "png"), b"png").unwrap();
        assert_eq!(cached(&root, &k, Size::Icon, now), Cached::File(file(&root, &k, Size::Icon, "png"), Format::Png));
        let partial = fs::read_dir(root.join(&k[..2])).unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains(PARTIAL));
        assert!(!partial);
        fs::remove_dir_all(root).unwrap();
    }

    fn aged(path: &Path, at: SystemTime) {
        fs::File::options().write(true).open(path).unwrap().set_modified(at).unwrap();
    }

    fn put(root: &Path, address: &str, size: Size, ext: &str, bytes: &[u8], at: SystemTime) -> PathBuf {
        let path = file(root, &key(address), size, ext);
        write_atomic(&path, bytes).unwrap();
        aged(&path, at);
        path
    }

    fn library(name: &str) -> (PathBuf, Connection) {
        let folder = folder(name);
        let opened = library::open(&Paths::new(folder.join("koonapin.db"))).unwrap();
        (folder, opened.conn)
    }

    fn add(conn: &Connection, path: &str, image: Option<&str>, icon: Option<&str>) -> i64 {
        insert_or_update_bookmark(conn, &format!("https://example.com/{path}"), path, None, image, icon, "example.com", None, None, Source::App)
            .unwrap()
            .id
    }

    #[test]
    fn the_sweep_keeps_what_any_bookmark_refers_to_the_trash_included() {
        let (folder, conn) = library("sweep");
        let root = folder.join(FOLDER);
        let shared = "https://www.google.com/s2/favicons?domain=example.com&sz=128";
        add(&conn, "live", Some("https://example.com/live.jpg"), Some(shared));
        let trashed = add(&conn, "trashed", Some("https://example.com/trashed.jpg"), Some(shared));
        trash_bookmark(&conn, trashed).unwrap();
        let now = SystemTime::now();
        let old = now - 3 * DAY;
        let live = put(&root, "https://example.com/live.jpg", Size::Preview, "jpg", b"x", old);
        let icon = put(&root, shared, Size::Icon, "png", b"x", old);
        let in_trash = put(&root, "https://example.com/trashed.jpg", Size::Preview, "jpg", b"x", old);
        let post = put(&root, "https://feed.example/post.jpg", Size::Preview, "jpg", b"x", old);
        let gone = put(&root, "https://example.com/deleted.jpg", Size::Preview, "jpg", b"x", old);
        let young = put(&root, "https://example.com/just-saved.jpg", Size::Preview, "jpg", b"x", now - Duration::from_secs(60));
        let gone_miss = put(&root, "https://example.com/deleted-miss.jpg", Size::Preview, "miss", b"", old);
        let stale_miss = put(&root, "https://example.com/live.jpg", Size::Icon, "miss", b"", now - 8 * DAY);
        let timeout_miss = put(&root, "https://example.com/live.jpg", Size::Preview, "miss", b"timeout", now - 2 * DAY);
        let partial = root.join("ab").join(format!("x.jpg{PARTIAL}1"));
        write_atomic(&partial, b"half").unwrap();
        aged(&partial, old);
        let feeds = vec!["https://feed.example/post.jpg".to_string()];
        let referenced = || Some(keys(library_addresses(&conn).unwrap().iter().chain(feeds.iter())));
        let swept = sweep_folder(&root, now, CAP, referenced).unwrap();
        assert_eq!(swept.files, 5);
        for path in [&live, &icon, &in_trash, &post, &young] {
            assert!(path.is_file(), "{path:?} kept");
        }
        for path in [&gone, &gone_miss, &stale_miss, &timeout_miss, &partial] {
            assert!(!path.exists(), "{path:?} removed");
        }
        // Purged for good: the shared icon stays for the live one.
        crate::db::purge_trash(&conn, crate::db::Purge::All).unwrap();
        assert_eq!(sweep_folder(&root, now, CAP, referenced).unwrap().files, 1);
        assert!(!in_trash.exists() && live.is_file() && icon.is_file());
        // Without the feed cache's references nothing goes.
        assert_eq!(sweep_folder(&root, now + 30 * DAY, 0, || None), None);
        assert!(live.is_file() && post.is_file());
        drop(conn);
        fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn over_the_cap_the_oldest_written_go_first() {
        let root = folder("cap");
        let now = SystemTime::now();
        let addresses: Vec<String> = (0..10).map(|i| format!("https://example.com/{i}.jpg")).collect();
        let files: Vec<PathBuf> =
            addresses.iter().enumerate().map(|(i, a)| put(&root, a, Size::Preview, "jpg", &[0; 100], now - Duration::from_secs(1000 - i as u64 * 10))).collect();
        assert_eq!(sweep_folder(&root, now, 1000, || Some(keys(&addresses))).unwrap().files, 0, "at the cap");
        // Over 800: down to 720, the three oldest go (700 left).
        assert_eq!(sweep_folder(&root, now, 800, || Some(keys(&addresses))).unwrap(), Swept { files: 3, bytes: 300 });
        for (i, path) in files.iter().enumerate() {
            assert_eq!(path.exists(), i >= 3, "{i}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn feed_addresses_come_from_posts_and_feed_icons() {
        let conn = crate::feeds::cache::open_in_memory().unwrap();
        conn.execute("INSERT INTO feed_state (feed_uid, icon_url) VALUES ('f1', 'https://feed.example/icon.png'), ('f2', NULL)", []).unwrap();
        conn.execute(
            "INSERT INTO feed_items (id, feed_uid, key, thumbnail_url, fetched_at) VALUES (5, 'f1', 'a', 'https://feed.example/a.jpg', '2026-10-01'), (6, 'f1', 'b', NULL, '2026-10-01')",
            [],
        )
        .unwrap();
        let mut found = feed_addresses(&conn).unwrap();
        found.sort();
        assert_eq!(found, ["https://feed.example/a.jpg", "https://feed.example/icon.png"]);
        assert_eq!(feed_source(&conn, &Picture::PostThumb(5)).unwrap().as_deref(), Some("https://feed.example/a.jpg"));
        assert_eq!(feed_source(&conn, &Picture::PostThumb(6)).unwrap(), None);
        assert_eq!(feed_source(&conn, &Picture::PostThumb(7)).unwrap(), None);
        assert_eq!(feed_source(&conn, &Picture::FeedIcon("f1".into())).unwrap().as_deref(), Some("https://feed.example/icon.png"));
        assert_eq!(feed_source(&conn, &Picture::FeedIcon("f2".into())).unwrap(), None);
    }

    #[tokio::test]
    async fn the_queue_serves_the_newest_first_and_two_per_site() {
        let queue: &'static Queue = Box::leak(Box::new(Queue::new(1, 1)));
        let rank = |n| Arc::new(AtomicU64::new(n));
        let first = queue.acquire("a", rank(1), SLOT_WAIT).await.unwrap();
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut waiting = tokio::task::JoinSet::new();
        for n in [2, 3, 4] {
            let order = order.clone();
            waiting.spawn(async move {
                let _slot = queue.acquire("b", Arc::new(AtomicU64::new(n)), SLOT_WAIT).await.unwrap();
                order.lock().unwrap().push(n);
                tokio::time::sleep(Duration::from_millis(5)).await;
            });
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(first);
        waiting.join_all().await;
        assert_eq!(*order.lock().unwrap(), [4, 3, 2]);

        let queue: &'static Queue = Box::leak(Box::new(Queue::new(8, 2)));
        let (_a1, _a2) = (queue.acquire("a", rank(1), SLOT_WAIT).await.unwrap(), queue.acquire("a", rank(1), SLOT_WAIT).await.unwrap());
        assert!(queue.acquire("a", rank(9), Duration::from_millis(50)).await.is_none(), "a third to one site waits");
        assert!(queue.acquire("b", rank(1), Duration::from_millis(50)).await.is_some(), "another site goes");
        let state = queue.state.lock().unwrap();
        assert_eq!((state.running, state.waiting.len()), (2, 0), "a wait that ran out holds no turn");
    }

    fn loopback(ip: IpAddr) -> bool {
        ip == IpAddr::V4(Ipv4Addr::LOCALHOST)
    }
    static TEST: Limits = Limits {
        allow: loopback,
        // Shorter than the whole request, as in [`LIMITS`]: Windows takes about 2 s to refuse a closed port.
        connect_timeout: Duration::from_millis(500),
        timeout: Duration::from_secs(2),
        max_body: 64 * 1024,
        max_redirects: 5,
    };

    /// A server that answers each path with `route(path)` and counts the requests.
    fn server(route: impl Fn(&str) -> Vec<u8> + Send + Sync + 'static) -> (u16, Arc<AtomicUsize>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (route, count) = (Arc::new(route), Arc::new(AtomicUsize::new(0)));
        let counted = count.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let (route, counted) = (route.clone(), counted.clone());
                std::thread::spawn(move || {
                    let mut request = [0u8; 4096];
                    let n = stream.read(&mut request).unwrap_or(0);
                    let text = String::from_utf8_lossy(&request[..n]).to_lowercase();
                    // Only the metadata client's own headers.
                    if text.contains("referer") || text.contains("cookie") || !text.contains("koonapin/") {
                        return;
                    }
                    counted.fetch_add(1, Ordering::SeqCst);
                    let path = text.split_whitespace().nth(1).unwrap_or("/").to_string();
                    std::thread::sleep(Duration::from_millis(50));
                    let _ = stream.write_all(&route(&path));
                });
            }
        });
        (port, count)
    }

    fn answer(status: &str, content_type: &str, body: &[u8]) -> Vec<u8> {
        let mut reply = format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
        reply.extend_from_slice(body);
        reply
    }

    fn miss_of(root: &Path, address: &str, size: Size) -> Option<Miss> {
        fs::read(file(root, &key(address), size, "miss")).ok().map(|b| Miss::read(&b))
    }

    #[tokio::test]
    async fn the_handler_serves_fetches_once_and_remembers_failures() {
        let jpeg = encoded(&picture(1000, 500, 255), ImageFormat::Jpeg);
        let (port, count) = server(move |path| match path {
            // Sent as PNG: the bytes decide.
            "/a.png" => answer("200 OK", "image/png", &jpeg),
            "/page.png" => answer("200 OK", "text/html", b"<html>login</html>"),
            "/forbidden.png" => answer("403 Forbidden", "text/plain", b"no"),
            "/busy.png" => answer("503 Service Unavailable", "text/plain", b"later"),
            "/huge.png" => answer("200 OK", "image/png", &vec![0u8; 100 * 1024]),
            "/slow.png" => {
                std::thread::sleep(Duration::from_secs(3));
                answer("200 OK", "image/png", b"late")
            }
            _ => answer("404 Not Found", "text/plain", b"gone"),
        });
        let (folder, conn) = library("handler");
        let at = |path: &str| format!("http://127.0.0.1:{port}/{path}");
        let a = add(&conn, "a", Some(&at("a.png")), Some("http://10.0.0.1/icon.png"));
        let bad: Vec<(&str, i64)> = ["page", "forbidden", "missing", "huge"].into_iter().map(|p| (p, add(&conn, p, Some(&at(&format!("{p}.png"))), None))).collect();
        let busy = add(&conn, "busy", Some(&at("busy.png")), Some("data:image/png;base64,AAAA"));
        let slow = add(&conn, "slow", Some(&at("slow.png")), None);
        let none = add(&conn, "none", None, None);
        let root = folder.join(FOLDER);
        let thumbs = Arc::new(Thumbs::new(root.clone(), folder.join("koonapin.db"), None, &TEST).unwrap());

        let mut many = tokio::task::JoinSet::new();
        for _ in 0..6 {
            let thumbs = thumbs.clone();
            many.spawn(async move { respond(&thumbs, &format!("/b%2F{a}%2Fimage")).await });
        }
        for response in many.join_all().await {
            assert_eq!(response.status(), 200);
            assert_eq!(response.headers()["content-type"], "image/jpeg");
            assert_eq!(response.headers()["cache-control"], CACHE_CONTROL);
            assert_eq!(response.headers()["x-content-type-options"], "nosniff");
            assert_eq!(response.headers()["content-security-policy"], SANDBOX);
            assert_eq!(decoded(response.body()).dimensions(), (640, 320));
        }
        assert_eq!(count.load(Ordering::SeqCst), 1, "one fetch for all");
        assert_eq!(respond(&thumbs, &format!("/b/{a}/image?v=1")).await.status(), 200);
        assert_eq!(count.load(Ordering::SeqCst), 1, "served from the folder");

        for (name, id) in &bad {
            assert_eq!(respond(&thumbs, &format!("/b/{id}/image")).await.status(), 404, "{name}");
            assert_eq!(miss_of(&root, &at(&format!("{name}.png")), Size::Preview), Some(Miss::Failed), "{name}");
            let before = count.load(Ordering::SeqCst);
            assert_eq!(respond(&thumbs, &format!("/b/{id}/image")).await.status(), 404);
            assert_eq!(count.load(Ordering::SeqCst), before, "{name} is not asked again");
        }
        assert_eq!(respond(&thumbs, &format!("/b/{busy}/image")).await.status(), 404);
        assert_eq!(miss_of(&root, &at("busy.png"), Size::Preview), None, "a server error is tried again");
        let response = respond(&thumbs, &format!("/b/{slow}/image")).await;
        assert_eq!(response.status(), 404);
        assert_eq!(miss_of(&root, &at("slow.png"), Size::Preview), Some(Miss::Timeout));

        // Refused by the guard, or not the web: the sentinel, no request.
        for path in [format!("/b/{a}/icon"), format!("/b/{busy}/icon")] {
            for _ in 0..2 {
                let response = respond(&thumbs, &path).await;
                assert_eq!(response.status(), 200, "{path}");
                assert_eq!(response.headers()[REFUSED_HEADER], "refused");
                assert_eq!(decoded(response.body()).dimensions(), (1, 1));
            }
        }
        assert_eq!(respond(&thumbs, &format!("/b/{none}/image")).await.status(), 404, "no address");
        assert_eq!(respond(&thumbs, "/b/999999/image").await.status(), 404, "no bookmark");
        assert_eq!(respond(&thumbs, "/p/1/thumb").await.status(), 404, "no feed cache");
        let malformed = respond(&thumbs, "/b/x/image").await;
        assert_eq!(malformed.status(), 400);
        assert_eq!(malformed.headers()["content-security-policy"], SANDBOX);
        // Windows keeps the files of open connections locked.
        drop(thumbs);
        drop(conn);
        let _ = fs::remove_dir_all(folder);
    }

    #[tokio::test]
    async fn offline_leaves_no_miss_and_trips_the_breaker() {
        let (folder, conn) = library("offline");
        let closed = TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
        let ids: Vec<i64> = (0..BREAKER_AFTER + 1).map(|i| add(&conn, &format!("o{i}"), Some(&format!("http://127.0.0.1:{closed}/{i}.png")), None)).collect();
        let root = folder.join(FOLDER);
        let thumbs = Arc::new(Thumbs::new(root.clone(), folder.join("koonapin.db"), None, &TEST).unwrap());
        for id in &ids[..BREAKER_AFTER as usize] {
            assert_eq!(respond(&thumbs, &format!("/b/{id}/image")).await.status(), 404);
        }
        assert!(thumbs.broken(), "five connection failures in a row");
        assert_eq!(respond(&thumbs, &format!("/b/{}/image", ids[BREAKER_AFTER as usize])).await.status(), 404);
        assert!(!root.exists() || list(&root).is_empty(), "offline writes no miss");
        drop(thumbs);
        drop(conn);
        let _ = fs::remove_dir_all(folder);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn time_machine_leaves_the_folder_out() {
        let root = folder("backups");
        exclude_from_backups(&root);
        let name = std::ffi::CString::new("com.apple.metadata:com_apple_backup_excludeItem").unwrap();
        let path = std::ffi::CString::new(root.to_str().unwrap()).unwrap();
        let mut value = [0u8; 128];
        // SAFETY: NUL-terminated strings and a buffer of the length given.
        let n = unsafe { libc::getxattr(path.as_ptr(), name.as_ptr(), value.as_mut_ptr().cast(), value.len(), 0, 0) };
        assert_eq!(n, 61);
        assert!(value.starts_with(b"bplist00") && value[60] == 0x1c);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "a rough timing: cargo test --release --lib thumbs::tests::resize_timing -- --ignored --nocapture"]
    fn resize_timing() {
        let big = encoded(&picture(4000, 3000, 255), ImageFormat::Jpeg);
        let png = encoded(&picture(3000, 3000, 200), ImageFormat::Png);
        for (name, bytes, size) in [("jpeg 4000×3000", &big, Size::Preview), ("png 3000×3000", &png, Size::Preview), ("png icon", &png, Size::Icon)] {
            let started = std::time::Instant::now();
            make(bytes, size).unwrap();
            println!("{name}: {:?}", started.elapsed());
        }
    }
}
