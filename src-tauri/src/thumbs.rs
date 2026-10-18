//! The picture cache (NP-146): previews and icons kept small beside the
//! library, so they show without the network and scrolling asks no site:
//!
//! ```text
//! thumbs/<aa>/<key>.jpg    a preview or a feed post's thumbnail: JPEG q80, at most 640 px wide
//! thumbs/<aa>/<key>.png    an icon: at most 96 × 96
//! thumbs/<aa>/<key>.svg    an SVG icon as it came, up to 64 KB
//! thumbs/<aa>/<key>.miss   empty: the last fetch failed; tried again after 7 days
//! ```
//!
//! `key` is the SHA-256 of the source address, `aa` its first two letters:
//! one Google icon serves every link of a domain, a saved feed post reuses
//! its thumbnail. No table: the folder is the index, a file's mtime its last
//! use. Not synced, exported, backed up or sent anywhere.
//!
//! The WebView asks through the `kpimg` scheme ([`protocol`]) by what shows
//! the picture, never by address: `b/<bookmark id>/image`, `b/<id>/icon`,
//! `p/<feed post id>/thumb`, `f/<feed uid>/icon`. The address is read from
//! the database in a short step, the lock let go, then the file is served or
//! fetched under [`LIMITS`], at most [`PARALLEL`] at a time, one fetch per
//! key however many ask. A saved link's pictures are fetched at once in the
//! background ([`warm`]); the rest on first display.
//!
//! Files are written under a temporary name and renamed. [`sweep`] removes
//! what no bookmark (the trash included), feed post or feed icon refers to,
//! a day after its last use, and keeps the folder under [`CAP`].

use crate::db::{Bookmark, DbState};
use crate::feeds::cache::FeedCache;
use crate::library_state::Library;
use crate::metadata::{self, FetchError, Limits};
use crate::net_guard;
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, ImageFormat, ImageReader};
use percent_encoding::percent_decode_str;
use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, SystemTime};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder};
use tokio::sync::{Notify, OnceCell, Semaphore};
use url::Url;

/// The folder of the cache in the library folder, beside `offline/`.
pub const FOLDER: &str = "thumbs";
/// The scheme the WebView asks for pictures by: `kpimg://localhost/…`, on
/// Windows `http://kpimg.localhost/…`.
pub const SCHEME: &str = "kpimg";
/// Files being written; never a key.
const TEMP: &str = ".tmp-";
const MISS: &str = "miss";
const DAY: Duration = Duration::from_secs(24 * 60 * 60);
/// A failed fetch is not tried again sooner.
const RETRY: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// A file nothing refers to stays this long after its last use: a link saved
/// a moment ago, a restore, a post still on screen.
const GRACE: Duration = DAY;
/// A served file's mtime is moved forward at most this often.
const TOUCH: Duration = DAY;
/// The whole folder; over it, the least recently used go down to 90%.
pub const CAP: u64 = 1024 * 1024 * 1024;
/// Fetches at once, the displayed and the warmed together.
pub const PARALLEL: usize = 4;
/// Of those, at most this many warm a saved link: what is on screen comes first.
const WARMING: usize = 2;

const PREVIEW_WIDTH: u32 = 640;
const ICON_SIDE: u32 = 96;
const JPEG_QUALITY: u8 = 80;
const MAX_SVG: usize = 64 * 1024;
/// Against image bombs: a header can promise any size.
const MAX_SIDE: u32 = 8000;
const MAX_ALLOC: u64 = 64 * 1024 * 1024;
/// Fast, and smooth enough at these sizes: a 4000 × 3000 JPEG is decoded and made a preview in about 45 ms (release build).
const FILTER: FilterType = FilterType::Triangle;

const CACHE_CONTROL: &str = "private, max-age=31536000, immutable";

/// A picture request: the image guard's rules, 15 s in all, up to 5 MB.
pub const LIMITS: Limits = Limits {
    allow: net_guard::public_ip,
    connect_timeout: Duration::from_secs(6),
    timeout: Duration::from_secs(15),
    max_body: 5 * 1024 * 1024,
    max_redirects: 5,
};

static FETCHES: Semaphore = Semaphore::const_new(PARALLEL);
static WARMS: Semaphore = Semaphore::const_new(WARMING);
/// The fetch under way for each file: the requests that come meanwhile wait for it.
static FLIGHTS: LazyLock<Mutex<HashMap<String, Arc<OnceCell<Option<Stored>>>>>> = LazyLock::new(Default::default);
/// A purge asks the sweep to run ([`purged`]).
static SWEEP: Notify = Notify::const_new();

/// What a picture is made into.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Size {
    /// A card's preview, a feed post's thumbnail.
    Preview,
    /// A bookmark's or a feed's icon.
    Icon,
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
            Size::Preview => &[Format::Jpeg],
            Size::Icon => &[Format::Png, Format::Svg],
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

/// The file name of an address: the hex SHA-256 of it, as it is stored.
pub fn key(address: &str) -> String {
    Sha256::digest(address.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn file(root: &Path, key: &str, ext: &str) -> PathBuf {
    root.join(&key[..2]).join(format!("{key}.{ext}"))
}

/// The cache of the library in `folder`.
pub fn root_of(folder: &Path) -> PathBuf {
    folder.join(FOLDER)
}

fn root<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    Some(root_of(&app.try_state::<Arc<Library>>()?.paths.folder()))
}

fn age(path: &Path, now: SystemTime) -> Option<Duration> {
    let modified = fs::metadata(path).and_then(|m| m.modified()).ok()?;
    Some(now.duration_since(modified).unwrap_or_default())
}

/// A file kept for `key` in this size class.
type Stored = (PathBuf, Format);

/// What the folder holds for `key`.
#[derive(Debug, PartialEq, Eq)]
enum Cached {
    File(PathBuf, Format),
    /// A fetch failed less than [`RETRY`] ago.
    Miss,
    Nothing,
}

fn cached(root: &Path, key: &str, size: Size, now: SystemTime) -> Cached {
    for &format in Format::of(size) {
        let path = file(root, key, format.ext());
        if path.is_file() {
            return Cached::File(path, format);
        }
    }
    match age(&file(root, key, MISS), now) {
        Some(age) if age < RETRY => Cached::Miss,
        _ => Cached::Nothing,
    }
}

/// Writes `bytes` under a temporary name beside `path` and renames it into place.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().ok_or_else(|| std::io::Error::other("no folder"))?;
    fs::create_dir_all(dir)?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let temp = dir.join(format!("{TEMP}{name}-{}", uuid::Uuid::new_v4().simple()));
    fs::write(&temp, bytes)?;
    fs::rename(&temp, path).inspect_err(|_| {
        let _ = fs::remove_file(&temp);
    })
}

/// The file's mtime is its last use; moved at most once a day so serving stays a read.
fn touch(path: &Path, now: SystemTime) {
    if age(path, now).is_some_and(|age| age > TOUCH) {
        if let Ok(file) = fs::File::options().write(true).open(path) {
            let _ = file.set_modified(now);
        }
    }
}

/// Why a picture is not kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fault {
    /// No connection, no answer in time, a server error: tried again on the next display.
    Offline,
    /// Refused, gone, not a picture, too large: a `.miss` for [`RETRY`].
    Bad,
}

/// The client every picture request goes through, and its limits.
pub struct Fetcher {
    client: reqwest::Client,
    limits: &'static Limits,
}

impl Fetcher {
    pub fn new(limits: &'static Limits) -> reqwest::Result<Fetcher> {
        Ok(Fetcher { client: metadata::client(limits)?, limits })
    }
}

fn fetcher() -> Option<&'static Fetcher> {
    static FETCHER: OnceLock<Option<Fetcher>> = OnceLock::new();
    FETCHER.get_or_init(|| Fetcher::new(&LIMITS).ok()).as_ref()
}

/// The body of a picture: an allowed http(s) address, a 2xx answer, at most `max_body`.
/// No cookies (the client keeps none), no Referer, the app's own User-Agent.
async fn download(fetcher: &Fetcher, address: &str) -> Result<Vec<u8>, Fault> {
    let url = Url::parse(address.trim()).map_err(|_| Fault::Bad)?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(Fault::Bad);
    }
    match metadata::check_address(&url, fetcher.limits.allow).await {
        Ok(()) => {}
        Err(FetchError::Refused) => return Err(Fault::Bad),
        // A name that does not resolve: offline looks the same.
        Err(_) => return Err(Fault::Offline),
    }
    let mut response = fetcher
        .client
        .get(url)
        .header(reqwest::header::USER_AGENT, metadata::FEED_USER_AGENT)
        .header(reqwest::header::ACCEPT, "image/webp,image/png,image/jpeg,image/gif,image/svg+xml,image/*;q=0.8")
        .send()
        .await
        .map_err(|e| if e.is_redirect() || metadata::failure(&e) == FetchError::Refused { Fault::Bad } else { Fault::Offline })?;
    let status = response.status();
    if !status.is_success() {
        // 408 and 429 pass; a server error may too.
        let lasting = status.is_client_error() && !matches!(status.as_u16(), 408 | 429) || status.is_redirection();
        return Err(if lasting { Fault::Bad } else { Fault::Offline });
    }
    let max = fetcher.limits.max_body;
    if response.content_length().is_some_and(|n| n > max as u64) {
        return Err(Fault::Bad);
    }
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => body.extend_from_slice(&chunk),
            Ok(None) => return Ok(body),
            Err(_) => return Err(Fault::Offline),
        }
        if body.len() > max {
            return Err(Fault::Bad);
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
    let before = &head[..at];
    let only_prolog = before.split('<').skip(1).all(|tag| tag.starts_with('?') || tag.starts_with('!'));
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
/// first frame), WebP, ICO, BMP, under [`reader_limits`].
fn decode(bytes: &[u8]) -> Option<DynamicImage> {
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format().ok()?;
    let format = reader.format()?;
    if !matches!(format, ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::Gif | ImageFormat::WebP | ImageFormat::Ico | ImageFormat::Bmp) {
        return None;
    }
    reader.limits(reader_limits());
    reader.decode().ok()
}

/// Transparent parts on white: a JPEG has no alpha.
fn on_white(image: &DynamicImage) -> image::RgbImage {
    if !image.color().has_alpha() {
        return image.to_rgb8();
    }
    let rgba = image.to_rgba8();
    image::RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let [r, g, b, a] = rgba.get_pixel(x, y).0;
        let blend = |c: u8| ((c as u32 * a as u32 + 255 * (255 - a as u32) + 127) / 255) as u8;
        image::Rgb([blend(r), blend(g), blend(b)])
    })
}

/// A preview: taller than 2:1 cropped to its top, at most 640 px wide, JPEG q80.
fn preview(image: DynamicImage) -> Option<Vec<u8>> {
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
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY);
    DynamicImage::ImageRgb8(on_white(&image)).write_with_encoder(encoder).ok()?;
    Some(out.into_inner())
}

/// An icon: within 96 × 96, PNG.
fn icon(image: DynamicImage) -> Option<Vec<u8>> {
    let (w, h) = image.dimensions();
    if w == 0 || h == 0 {
        return None;
    }
    let image = if w > ICON_SIDE || h > ICON_SIDE { image.resize(ICON_SIDE, ICON_SIDE, FILTER) } else { image };
    let image = if image.color().has_alpha() { DynamicImage::ImageRgba8(image.to_rgba8()) } else { DynamicImage::ImageRgb8(image.to_rgb8()) };
    let mut out = Cursor::new(Vec::new());
    image.write_with_encoder(image::codecs::png::PngEncoder::new(&mut out)).ok()?;
    Some(out.into_inner())
}

/// What a fetched body is kept as; none when it is not a picture this size class takes.
fn make(bytes: &[u8], size: Size) -> Option<(Vec<u8>, Format)> {
    if size == Size::Icon && looks_like_svg(bytes) {
        return (bytes.len() <= MAX_SVG).then(|| (bytes.to_vec(), Format::Svg));
    }
    let image = decode(bytes)?;
    match size {
        Size::Preview => preview(image).map(|b| (b, Format::Jpeg)),
        Size::Icon => icon(image).map(|b| (b, Format::Png)),
    }
}

/// Fetches, makes and writes the file of `key`, or its `.miss`.
async fn fetch_and_store(root: &Path, key: &str, address: &str, size: Size, fetcher: &Fetcher) -> Option<Stored> {
    let _permit = FETCHES.acquire().await.ok()?;
    // A fetch that finished while this one waited.
    match cached(root, key, size, SystemTime::now()) {
        Cached::File(path, format) => return Some((path, format)),
        Cached::Miss => return None,
        Cached::Nothing => {}
    }
    let made = match download(fetcher, address).await {
        Ok(body) => tokio::task::spawn_blocking(move || make(&body, size)).await.ok().flatten().ok_or(Fault::Bad),
        Err(fault) => Err(fault),
    };
    let (root, key) = (root.to_path_buf(), key.to_string());
    tokio::task::spawn_blocking(move || {
        let miss = file(&root, &key, MISS);
        match made {
            Ok((bytes, format)) => {
                let path = file(&root, &key, format.ext());
                write_atomic(&path, &bytes).ok()?;
                let _ = fs::remove_file(miss);
                Some((path, format))
            }
            Err(Fault::Bad) => {
                let _ = write_atomic(&miss, &[]);
                None
            }
            Err(Fault::Offline) => None,
        }
    })
    .await
    .ok()
    .flatten()
}

/// The file of `address` in this size class: from the folder, or fetched now.
/// Requests for one file while it is fetched share that fetch.
pub async fn obtain(root: &Path, address: &str, size: Size, fetcher: &Fetcher) -> Option<Stored> {
    let key = key(address);
    let (r, k) = (root.to_path_buf(), key.clone());
    match tokio::task::spawn_blocking(move || cached(&r, &k, size, SystemTime::now())).await.ok()? {
        Cached::File(path, format) => return Some((path, format)),
        Cached::Miss => return None,
        Cached::Nothing => {}
    }
    let flight = format!("{}|{key}|{size:?}", root.display());
    let cell = FLIGHTS.lock().ok()?.entry(flight.clone()).or_default().clone();
    let stored = cell.get_or_init(|| fetch_and_store(root, &key, address, size, fetcher)).await.clone();
    if let Ok(mut flights) = FLIGHTS.lock() {
        if flights.get(&flight).is_some_and(|c| Arc::ptr_eq(c, &cell)) {
            flights.remove(&flight);
        }
    }
    stored
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(status).body(Vec::new()).unwrap_or_default()
}

/// The address of `picture`, read in a short step; neither lock is held after.
fn source<R: Runtime>(app: &AppHandle<R>, picture: &Picture) -> Option<String> {
    match picture {
        Picture::BookmarkImage(_) | Picture::BookmarkIcon(_) => {
            let db = app.try_state::<Arc<DbState>>()?;
            let conn = db.conn.lock().ok()?;
            library_source(&conn, picture).ok().flatten()
        }
        Picture::PostThumb(_) | Picture::FeedIcon(_) => {
            let cache = app.try_state::<Arc<FeedCache>>()?;
            let conn = cache.conn.lock().ok()?;
            feed_source(&conn, picture).ok().flatten()
        }
    }
}

async fn answer<R: Runtime>(app: AppHandle<R>, picture: Picture) -> Response<Vec<u8>> {
    let not_found = || empty(StatusCode::NOT_FOUND);
    let Some(root) = root(&app) else { return not_found() };
    let size = picture.size();
    let Ok(Some(address)) = tokio::task::spawn_blocking(move || source(&app, &picture)).await else {
        return not_found();
    };
    let Some(fetcher) = fetcher() else { return not_found() };
    let Some((path, format)) = obtain(&root, &address, size, fetcher).await else {
        return not_found();
    };
    let read = tokio::task::spawn_blocking(move || {
        let bytes = fs::read(&path).ok()?;
        touch(&path, SystemTime::now());
        Some(bytes)
    });
    match read.await.ok().flatten() {
        Some(bytes) => Response::builder()
            .header(header::CONTENT_TYPE, format.mime())
            .header(header::CACHE_CONTROL, CACHE_CONTROL)
            .body(bytes)
            .unwrap_or_else(|_| not_found()),
        // Swept meanwhile: the next display fetches it again.
        None => not_found(),
    }
}

/// The `kpimg` scheme: `?v=` only tells the WebView a picture changed and is
/// not read. 400 for a path that names nothing, 404 when there is no picture
/// to give (no address, a failed fetch, offline); the interface then falls back.
pub fn protocol<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let Some(picture) = Picture::parse(request.uri().path()) else {
        responder.respond(empty(StatusCode::BAD_REQUEST));
        return;
    };
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        responder.respond(answer(app, picture).await);
    });
}

/// A saved link's picture and icon, fetched in the background once its
/// metadata is stored (a save, «Обновить превью»): nothing waits for it.
pub fn warm<R: Runtime>(app: &AppHandle<R>, bookmark: &Bookmark) {
    let Some(root) = root(app) else { return };
    let wanted: Vec<(String, Size)> = [(&bookmark.image_url, Size::Preview), (&bookmark.favicon_url, Size::Icon)]
        .into_iter()
        .filter_map(|(address, size)| address.as_ref().filter(|a| !a.trim().is_empty()).map(|a| (a.clone(), size)))
        .collect();
    if wanted.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let Some(fetcher) = fetcher() else { return };
        for (address, size) in wanted {
            let Ok(_turn) = WARMS.acquire().await else { return };
            obtain(&root, &address, size, fetcher).await;
        }
    });
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

/// What a sweep removed.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Swept {
    pub files: usize,
    pub bytes: u64,
}

/// Mark and sweep over the folder, outside every lock: files of keys not in
/// `referenced` a day after their last use, `.miss` markers past [`RETRY`],
/// temporary files a day old; then, over `cap`, the least recently used down to 90%.
pub fn sweep_folder(root: &Path, referenced: &HashSet<String>, now: SystemTime, cap: u64) -> Swept {
    let mut swept = Swept::default();
    let mut kept: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
    let remove = |path: &Path, bytes: u64, swept: &mut Swept| {
        if fs::remove_file(path).is_ok() {
            swept.files += 1;
            swept.bytes += bytes;
        }
    };
    let Ok(dirs) = fs::read_dir(root) else { return swept };
    for dir in dirs.flatten() {
        let Ok(files) = fs::read_dir(dir.path()) else { continue };
        for entry in files.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let modified = meta.modified().unwrap_or(now);
            let age = now.duration_since(modified).unwrap_or_default();
            if name.starts_with(TEMP) {
                if age > GRACE {
                    remove(&path, meta.len(), &mut swept);
                }
                continue;
            }
            let Some((stem, ext)) = name.split_once('.') else { continue };
            let known = matches!(ext, MISS | "jpg" | "png" | "svg") && stem.len() == 64 && stem.bytes().all(|b| b.is_ascii_hexdigit());
            if !known {
                continue;
            }
            let stale = if ext == MISS { age > RETRY } else { false };
            if stale || (!referenced.contains(stem) && age > GRACE) {
                remove(&path, meta.len(), &mut swept);
            } else {
                kept.push((modified, meta.len(), path));
            }
        }
    }
    let mut total: u64 = kept.iter().map(|k| k.1).sum();
    if total > cap {
        kept.sort_by_key(|k| k.0);
        let target = cap / 10 * 9;
        for (_, bytes, path) in kept {
            if total <= target {
                break;
            }
            remove(&path, bytes, &mut swept);
            total = total.saturating_sub(bytes);
        }
    }
    swept
}

/// The keys of a set of addresses.
pub fn keys<'a>(addresses: impl IntoIterator<Item = &'a String>) -> HashSet<String> {
    addresses.into_iter().map(|a| key(a)).collect()
}

/// A sweep of the open library's cache. The addresses are read in two short
/// steps, one per lock; without the feed cache, or with one only in memory,
/// the set would be incomplete and nothing is removed.
pub fn sweep<R: Runtime>(app: &AppHandle<R>) -> Option<Swept> {
    let root = root(app)?;
    let library = {
        let db = app.try_state::<Arc<DbState>>()?;
        let conn = db.conn.lock().ok()?;
        library_addresses(&conn).ok()?
    };
    let feeds = {
        let cache = app.try_state::<Arc<FeedCache>>()?;
        let conn = cache.conn.lock().ok()?;
        if conn.path().is_none_or(str::is_empty) {
            return None;
        }
        feed_addresses(&conn).ok()?
    };
    let referenced = keys(library.iter().chain(feeds.iter()));
    Some(sweep_folder(&root, &referenced, SystemTime::now(), CAP))
}

/// Bookmarks were deleted for good (`db::purge_trash`): the sweep runs soon.
pub fn purged() {
    SWEEP.notify_one();
}

/// The sweep at library open, and after each purge, a minute later so a
/// series of them is one sweep. Called once the library and the feed cache are managed.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let handle = app.clone();
            if let Ok(Some(swept)) = tokio::task::spawn_blocking(move || sweep(&handle)).await {
                if swept.files > 0 {
                    eprintln!("Picture cache: removed {} files, {} bytes", swept.files, swept.bytes);
                }
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
    use crate::library::{self, Paths};
    use image::{Rgba, RgbaImage};
    use std::io::{Read, Write};
    use std::net::{IpAddr, Ipv4Addr, TcpListener};
    use std::sync::atomic::{AtomicUsize, Ordering};

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
        assert_eq!(file(Path::new("/lib/thumbs"), &k, "jpg"), Path::new("/lib/thumbs").join(&k[..2]).join(format!("{k}.jpg")));
        assert_ne!(key("https://example.com/a.png"), key("https://example.com/a.png "), "the address as stored");
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
            assert_eq!(kind, Format::Jpeg);
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
        let first = decoded(&png).to_rgba8();
        let [r, _, b, _] = first.get_pixel(5, 5).0;
        assert!(r > 200 && b < 50, "{r} {b}");
    }

    #[test]
    fn previews_are_never_upscaled_tall_ones_are_cropped_and_alpha_goes_white() {
        let small = encoded(&picture(300, 200, 255), ImageFormat::Png);
        assert_eq!(decoded(&make(&small, Size::Preview).unwrap().0).dimensions(), (300, 200));
        let tall = encoded(&picture(400, 2000, 255), ImageFormat::Png);
        assert_eq!(decoded(&make(&tall, Size::Preview).unwrap().0).dimensions(), (400, 800));
        let tall_wide = encoded(&picture(1280, 4000, 255), ImageFormat::Png);
        assert_eq!(decoded(&make(&tall_wide, Size::Preview).unwrap().0).dimensions(), (640, 1280));
        let clear = encoded(&picture(50, 50, 0), ImageFormat::Png);
        let white = decoded(&make(&clear, Size::Preview).unwrap().0).to_rgb8();
        assert!(white.get_pixel(25, 25).0.iter().all(|&c| c > 245), "{:?}", white.get_pixel(25, 25));
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
        // Over the side limit, and within it but over the allocation limit (5000² × 4 bytes).
        for (w, h) in [(100_000, 100_000), (5000, 5000), (7999, 7999)] {
            let started = std::time::Instant::now();
            assert_eq!(make(&promised_png(w, h), Size::Preview), None);
            assert!(started.elapsed() < Duration::from_secs(1), "{w}×{h} took {:?}", started.elapsed());
        }
    }

    #[test]
    fn a_miss_holds_for_seven_days() {
        let root = folder("miss");
        let k = key("https://example.com/gone.png");
        let now = SystemTime::now();
        assert_eq!(cached(&root, &k, Size::Preview, now), Cached::Nothing);
        write_atomic(&file(&root, &k, MISS), &[]).unwrap();
        assert_eq!(cached(&root, &k, Size::Preview, now), Cached::Miss);
        assert_eq!(cached(&root, &k, Size::Icon, now + RETRY - DAY), Cached::Miss);
        assert_eq!(cached(&root, &k, Size::Icon, now + RETRY + DAY), Cached::Nothing);
        write_atomic(&file(&root, &k, "png"), b"png").unwrap();
        assert_eq!(cached(&root, &k, Size::Icon, now), Cached::File(file(&root, &k, "png"), Format::Png));
        assert_eq!(cached(&root, &k, Size::Preview, now), Cached::Miss, "a preview is its own file");
        let leftovers: Vec<_> = fs::read_dir(root.join(&k[..2])).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with(TEMP)).collect();
        assert!(leftovers.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    fn aged(path: &Path, at: SystemTime) {
        fs::File::options().write(true).open(path).unwrap().set_modified(at).unwrap();
    }

    fn put(root: &Path, address: &str, ext: &str, bytes: usize, at: SystemTime) -> PathBuf {
        let path = file(root, &key(address), ext);
        write_atomic(&path, &vec![0u8; bytes]).unwrap();
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
        let root = root_of(&folder);
        let shared = "https://www.google.com/s2/favicons?domain=example.com&sz=128";
        let live = add(&conn, "live", Some("https://example.com/live.jpg"), Some(shared));
        let trashed = add(&conn, "trashed", Some("https://example.com/trashed.jpg"), Some(shared));
        trash_bookmark(&conn, trashed).unwrap();
        let now = SystemTime::now();
        let old = now - 3 * DAY;
        let kept = [put(&root, "https://example.com/live.jpg", "jpg", 10, old), put(&root, shared, "png", 10, old), put(&root, "https://example.com/trashed.jpg", "jpg", 10, old)];
        let post = put(&root, "https://feed.example/post.jpg", "jpg", 10, old);
        let gone = put(&root, "https://example.com/deleted.jpg", "jpg", 10, old);
        let young = put(&root, "https://example.com/just-saved.jpg", "jpg", 10, now - Duration::from_secs(60));
        let gone_miss = put(&root, "https://example.com/deleted-miss.jpg", MISS, 0, old);
        let stale_miss = put(&root, "https://example.com/live.jpg", MISS, 0, now - RETRY - DAY);
        let temp = root.join("ab").join(format!("{TEMP}x.jpg-1"));
        write_atomic(&temp, b"half").unwrap();
        aged(&temp, old);
        let feeds = vec!["https://feed.example/post.jpg".to_string()];
        let referenced = keys(library_addresses(&conn).unwrap().iter().chain(feeds.iter()));
        let swept = sweep_folder(&root, &referenced, now, CAP);
        assert_eq!(swept.files, 4);
        for path in kept.iter().chain([&post, &young]) {
            assert!(path.is_file(), "{path:?} kept");
        }
        for path in [&gone, &gone_miss, &stale_miss, &temp] {
            assert!(!path.exists(), "{path:?} removed");
        }
        // Purged for good: the shared icon stays for the live one.
        crate::db::purge_trash(&conn, crate::db::Purge::All).unwrap();
        let referenced = keys(library_addresses(&conn).unwrap().iter().chain(feeds.iter()));
        assert_eq!(sweep_folder(&root, &referenced, now, CAP).files, 1);
        assert!(!kept[2].exists() && kept[0].is_file() && kept[1].is_file());
        let _ = live;
        drop(conn);
        fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn over_the_cap_the_least_recently_used_go_first() {
        let root = folder("cap");
        let now = SystemTime::now();
        let files: Vec<PathBuf> = (0..10).map(|i| put(&root, &format!("https://example.com/{i}.jpg"), "jpg", 100, now - Duration::from_secs(1000 - i * 10))).collect();
        let referenced = keys(&(0..10).map(|i| format!("https://example.com/{i}.jpg")).collect::<Vec<_>>());
        assert_eq!(sweep_folder(&root, &referenced, now, 1000).files, 0, "at the cap");
        // Over 800: down to 720, the three oldest go (700 left).
        let swept = sweep_folder(&root, &referenced, now, 800);
        assert_eq!(swept, Swept { files: 3, bytes: 300 });
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

    #[test]
    fn library_sources_include_the_trash_and_skip_empty_addresses() {
        let (folder, conn) = library("sources");
        let id = add(&conn, "a", Some("https://example.com/a.jpg"), Some(""));
        trash_bookmark(&conn, id).unwrap();
        assert_eq!(library_source(&conn, &Picture::BookmarkImage(id)).unwrap().as_deref(), Some("https://example.com/a.jpg"));
        assert_eq!(library_source(&conn, &Picture::BookmarkIcon(id)).unwrap(), None);
        assert_eq!(library_source(&conn, &Picture::BookmarkImage(id + 100)).unwrap(), None);
        drop(conn);
        fs::remove_dir_all(folder).unwrap();
    }

    fn first_loopback(ip: IpAddr) -> bool {
        ip == IpAddr::V4(Ipv4Addr::LOCALHOST)
    }
    static TEST: Limits = Limits {
        allow: first_loopback,
        connect_timeout: Duration::from_secs(2),
        timeout: Duration::from_secs(4),
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
                    assert!(!text.contains("referer") && !text.contains("cookie"), "{text}");
                    assert!(text.contains("user-agent: koonapin/"), "{text}");
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

    #[tokio::test]
    async fn fetches_are_shared_kept_and_failures_remembered_or_not() {
        let jpeg = encoded(&picture(1000, 500, 255), ImageFormat::Jpeg);
        let (port, count) = server(move |path| match path {
            // Sent as PNG: the bytes decide.
            "/a.png" => answer("200 OK", "image/png", &jpeg),
            "/page.png" => answer("200 OK", "text/html", b"<html>login</html>"),
            "/forbidden.png" => answer("403 Forbidden", "text/plain", b"no"),
            "/busy.png" => answer("503 Service Unavailable", "text/plain", b"later"),
            "/huge.png" => answer("200 OK", "image/png", &vec![0u8; 100 * 1024]),
            _ => answer("404 Not Found", "text/plain", b"gone"),
        });
        let fetcher: &'static Fetcher = Box::leak(Box::new(Fetcher::new(&TEST).unwrap()));
        let root = folder("fetch");
        let a = format!("http://127.0.0.1:{port}/a.png");
        let mut many = tokio::task::JoinSet::new();
        for _ in 0..6 {
            let (root, a) = (root.clone(), a.clone());
            many.spawn(async move { obtain(&root, &a, Size::Preview, fetcher).await });
        }
        let results = many.join_all().await;
        assert!(results.iter().all(|r| r.as_ref().is_some_and(|(_, f)| *f == Format::Jpeg)));
        assert_eq!(count.load(Ordering::SeqCst), 1, "one fetch for all");
        let (path, _) = results[0].clone().unwrap();
        assert_eq!(decoded(&fs::read(&path).unwrap()).dimensions(), (640, 320));
        assert!(obtain(&root, &a, Size::Preview, fetcher).await.is_some());
        assert_eq!(count.load(Ordering::SeqCst), 1, "served from the folder");

        for bad in ["page", "forbidden", "missing", "huge"] {
            let address = format!("http://127.0.0.1:{port}/{bad}.png");
            assert_eq!(obtain(&root, &address, Size::Preview, fetcher).await, None);
            assert!(file(&root, &key(&address), MISS).is_file(), "{bad} leaves a miss");
            let before = count.load(Ordering::SeqCst);
            assert_eq!(obtain(&root, &address, Size::Preview, fetcher).await, None);
            assert_eq!(count.load(Ordering::SeqCst), before, "{bad} is not asked again");
        }
        let busy = format!("http://127.0.0.1:{port}/busy.png");
        assert_eq!(obtain(&root, &busy, Size::Preview, fetcher).await, None);
        assert!(!file(&root, &key(&busy), MISS).exists(), "a server error is tried again");
        // Nobody listens: offline leaves no miss.
        let closed = TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
        let offline = format!("http://127.0.0.1:{closed}/a.png");
        assert_eq!(obtain(&root, &offline, Size::Preview, fetcher).await, None);
        assert!(!file(&root, &key(&offline), MISS).exists());
        // Refused by the guard and not http: a miss, no request.
        for refused in ["http://10.0.0.1/a.png", "file:///etc/passwd", "data:image/png;base64,AAAA"] {
            assert_eq!(obtain(&root, refused, Size::Icon, fetcher).await, None);
            assert!(file(&root, &key(refused), MISS).is_file(), "{refused}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "a rough timing: cargo test --release thumbs::tests::resize_timing -- --ignored --nocapture"]
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
