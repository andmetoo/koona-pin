//! Offline copies of articles (NP-126): the article reading mode extracted,
//! kept with its pictures in a folder per bookmark beside the library:
//!
//! ```text
//! offline/<bookmark id>/article.html   pictures as src="koona-offline:NN.ext"
//! offline/<bookmark id>/article.json   the rest of [`OfflineArticle`]
//! offline/<bookmark id>/images/NN.ext
//! ```
//!
//! A copy never leaves the computer: no sync, no export, no server; the row
//! in `offline_copies` (schema 12) only says it is there. Only the person
//! makes one, from what the reader already extracted, so nothing behind a
//! paywall is fetched. Pictures are fetched under the reader's guard
//! ([`LIMITS`]); one that fails or is over a limit keeps its web address.
//!
//! A copy is written to a temporary folder and renamed into place, so an
//! update replaces it whole. The rename and the row change happen under the
//! library lock, as does [`sweep`], so the sweep never sees one without the
//! other.

use crate::db;
use crate::error::{CommandError, ErrorCode, ErrorDetail};
use crate::metadata::{self, Limits};
use crate::net_guard;
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use scraper::{Html, Node, StrTendril};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tokio::sync::Semaphore;
use ts_rs::TS;
use url::Url;

/// The folder of copies in the library folder.
pub const FOLDER: &str = "offline";
const ARTICLE: &str = "article.html";
const META: &str = "article.json";
const IMAGES: &str = "images";
/// What a saved picture's address starts with in `article.html`.
pub const SCHEME: &str = "koona-offline:";
/// Folders being written or replaced; names never parse as a bookmark id.
const STAGING: &str = ".partial-";
const REPLACED: &str = ".old-";
/// A staging folder older than this was left by a save that never finished.
const STALE: Duration = Duration::from_secs(24 * 60 * 60);

/// `app_settings` key of «Save articles I open in Reading» (NP-126, Settings →
/// Reading): `true` turns it on; off by default.
pub const SAVE_SETTING: &str = "reading.save_offline";

/// Whether an article opened from Reading is saved for offline.
pub fn save_on_open(conn: &Connection) -> bool {
    db::setting(conn, SAVE_SETTING).is_ok_and(|v| v == "true")
}

/// A picture request: the reader's rules ([`crate::reader::LIMITS`]), up to 5 MB.
pub const LIMITS: Limits = Limits {
    allow: net_guard::public_ip,
    connect_timeout: Duration::from_secs(6),
    timeout: Duration::from_secs(20),
    max_body: 5 * 1024 * 1024,
    max_redirects: 5,
};

/// How much of an article's pictures a copy keeps.
pub struct Caps {
    pub images: usize,
    pub bytes: u64,
    /// All pictures together; what is not in by then keeps its web address.
    pub time: Duration,
    pub parallel: usize,
    /// The article's HTML as the reader extracted it.
    pub html: usize,
}

pub const CAPS: Caps = Caps {
    images: 80,
    bytes: 40 * 1024 * 1024,
    time: Duration::from_secs(60),
    parallel: 4,
    html: 8 * 1024 * 1024,
};

/// The article as reading mode extracted and cleaned it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OfflineArticle {
    /// The page it was read from, after redirects: relative pictures resolve against it.
    pub url: String,
    pub title: String,
    pub author: Option<String>,
    pub site: Option<String>,
    pub published: Option<String>,
    pub description: Option<String>,
    pub language: Option<String>,
    pub html: String,
    pub words: i64,
}

/// A copy on this computer, as the row says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct OfflineCopy {
    pub bookmark_id: i64,
    pub saved_at: String,
    pub url: String,
    /// The folder's size: the article, its metadata and pictures.
    pub bytes: i64,
    /// Pictures kept in the copy.
    pub images: i64,
    pub words: i64,
}

/// A copy to read: its pictures are `data:` addresses in `article.html`.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct OfflineCopyContent {
    pub copy: OfflineCopy,
    pub article: OfflineArticle,
}

/// Every copy on this computer, those of bookmarks in the trash included:
/// Settings → Storage tells what the folder holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct OfflineStats {
    pub count: i64,
    pub bytes: i64,
}

/// The folder of copies of the library open on `conn`; none for a library in memory.
pub fn root(conn: &Connection) -> Option<PathBuf> {
    let path = Path::new(conn.path().filter(|p| !p.is_empty())?);
    Some(path.parent()?.join(FOLDER))
}

fn root_of(conn: &Connection) -> Result<PathBuf, CommandError> {
    root(conn).ok_or_else(|| CommandError::internal("the library has no folder"))
}

fn folder(root: &Path, id: i64) -> PathBuf {
    root.join(id.to_string())
}

/// The picture formats a copy keeps; anything else stays on the web.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageKind {
    Png,
    Jpeg,
    Gif,
    Webp,
    Avif,
}

impl ImageKind {
    const ALL: [ImageKind; 5] = [ImageKind::Png, ImageKind::Jpeg, ImageKind::Gif, ImageKind::Webp, ImageKind::Avif];

    pub fn ext(self) -> &'static str {
        match self {
            ImageKind::Png => "png",
            ImageKind::Jpeg => "jpg",
            ImageKind::Gif => "gif",
            ImageKind::Webp => "webp",
            ImageKind::Avif => "avif",
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            ImageKind::Png => "image/png",
            ImageKind::Jpeg => "image/jpeg",
            ImageKind::Gif => "image/gif",
            ImageKind::Webp => "image/webp",
            ImageKind::Avif => "image/avif",
        }
    }

    /// From a `Content-Type` header, parameters aside.
    pub fn from_content_type(value: &str) -> Option<ImageKind> {
        let essence = value.split(';').next()?.trim().to_ascii_lowercase();
        match essence.as_str() {
            "image/jpg" | "image/pjpeg" => Some(ImageKind::Jpeg),
            other => ImageKind::ALL.into_iter().find(|k| k.mime() == other),
        }
    }

    fn from_ext(ext: &str) -> Option<ImageKind> {
        ImageKind::ALL.into_iter().find(|k| k.ext() == ext)
    }

    /// From the first bytes of the file: a header that says one thing and a
    /// body that is another (an HTML error page as `image/png`) is not kept.
    pub fn sniff(bytes: &[u8]) -> Option<ImageKind> {
        if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            Some(ImageKind::Png)
        } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
            Some(ImageKind::Jpeg)
        } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
            Some(ImageKind::Gif)
        } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
            Some(ImageKind::Webp)
        } else if is_avif(bytes) {
            Some(ImageKind::Avif)
        } else {
            None
        }
    }
}

/// An ISO-BMFF `ftyp` box whose major or compatible brands name AVIF.
fn is_avif(bytes: &[u8]) -> bool {
    if bytes.len() < 16 || &bytes[4..8] != b"ftyp" {
        return false;
    }
    let size = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let end = size.clamp(16, bytes.len());
    let avif = |brand: &[u8]| brand == b"avif" || brand == b"avis";
    // Major brand, minor version, then compatible brands.
    avif(&bytes[8..12]) || bytes[16..end].as_chunks::<4>().0.iter().any(|brand| avif(brand))
}

/// A picture's file name as `article.html` names it: `NN.ext`, nothing that
/// could step out of the folder.
fn picture_name(src: &str) -> Option<(&str, ImageKind)> {
    let name = src.strip_prefix(SCHEME)?;
    let (stem, ext) = name.split_once('.')?;
    let kind = ImageKind::from_ext(ext)?;
    (!stem.is_empty() && stem.len() <= 3 && stem.bytes().all(|b| b.is_ascii_digit())).then_some((name, kind))
}

/// Calls `edit` on each element of an article fragment and serializes it again.
fn edit_elements(html: &str, mut edit: impl FnMut(&str, &mut scraper::node::Element) -> bool) -> String {
    let mut document = Html::parse_fragment(html);
    let ids: Vec<_> = document.tree.nodes().map(|n| n.id()).collect();
    for id in ids {
        let Some(mut node) = document.tree.get_mut(id) else { continue };
        let keep = match node.value() {
            Node::Element(element) => {
                let name = element.name().to_string();
                edit(&name, element)
            }
            _ => true,
        };
        if !keep {
            node.detach();
        }
    }
    document.root_element().inner_html()
}

fn attr<'e>(element: &'e scraper::node::Element, name: &str) -> Option<&'e str> {
    element.attrs.iter().find(|(k, _)| &*k.local == name).map(|(_, v)| &**v)
}

fn set_attr(element: &mut scraper::node::Element, name: &str, value: &str) {
    for (k, v) in element.attrs.iter_mut() {
        if &*k.local == name {
            *v = StrTendril::from_slice(value);
        }
    }
}

/// The web address of an `<img src>`, resolved against the article.
fn picture_url(src: &str, base: Option<&Url>) -> Option<Url> {
    let src = src.trim();
    let url = match base {
        Some(base) => base.join(src).ok()?,
        None => Url::parse(src).ok()?,
    };
    matches!(url.scheme(), "http" | "https").then_some(url)
}

/// The web pictures of an article, each once, in order, at most `max`.
pub fn picture_urls(html: &str, base: &str, max: usize) -> Vec<Url> {
    let base = Url::parse(base).ok();
    let mut seen = HashSet::new();
    let mut urls = Vec::new();
    edit_elements(html, |name, element| {
        if name == "img" {
            if let Some(url) = attr(element, "src").and_then(|src| picture_url(src, base.as_ref())) {
                if urls.len() < max && seen.insert(url.clone()) {
                    urls.push(url);
                }
            }
        }
        true
    });
    urls
}

/// The article as a copy stores it: each saved picture's `src` becomes
/// `koona-offline:NN.ext`, the rest are web addresses resolved against the
/// article. `srcset`, `sizes` and `<source>` go: they would load the web
/// versions instead of the saved one.
pub fn rewrite(html: &str, base: &str, saved: &HashMap<Url, String>) -> String {
    let base = Url::parse(base).ok();
    edit_elements(html, |name, element| {
        if name == "source" {
            return false;
        }
        element.attrs.retain(|k, _| !matches!(&*k.local, "srcset" | "sizes"));
        if name == "img" {
            if let Some(url) = attr(element, "src").and_then(|src| picture_url(src, base.as_ref())) {
                let src = match saved.get(&url) {
                    Some(file) => format!("{SCHEME}{file}"),
                    None => url.to_string(),
                };
                set_attr(element, "src", &src);
            }
        }
        true
    })
}

/// The article to read: each `koona-offline:` picture becomes the `data:`
/// address `picture` gives for its file name; one it has none for loses
/// its `src` rather than show a broken address.
pub fn inline(html: &str, mut picture: impl FnMut(&str, ImageKind) -> Option<Vec<u8>>) -> String {
    edit_elements(html, |name, element| {
        if name != "img" {
            return true;
        }
        let Some(src) = attr(element, "src").filter(|s| s.starts_with(SCHEME)).map(str::to_string) else {
            return true;
        };
        match picture_name(&src).and_then(|(file, kind)| picture(file, kind).map(|bytes| (kind, bytes))) {
            Some((kind, bytes)) => {
                let data = format!("data:{};base64,{}", kind.mime(), base64::engine::general_purpose::STANDARD.encode(bytes));
                set_attr(element, "src", &data);
            }
            None => element.attrs.retain(|k, _| &*k.local != "src"),
        }
        true
    })
}

/// One picture under `limits`: an allowed address, a 2xx answer whose type
/// and first bytes agree on a kept format, no larger than `max_body`.
async fn fetch_picture(client: &reqwest::Client, url: &Url, limits: &Limits) -> Option<(Vec<u8>, ImageKind)> {
    metadata::check_address(url, limits.allow).await.ok()?;
    let mut response = client.get(url.clone()).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let kind = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(ImageKind::from_content_type)?;
    if response.content_length().is_some_and(|n| n > limits.max_body as u64) {
        return None;
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        body.extend_from_slice(&chunk);
        if body.len() > limits.max_body {
            return None;
        }
    }
    (ImageKind::sniff(&body) == Some(kind)).then_some((body, kind))
}

/// A copy written to its staging folder, not yet in place. Dropped without
/// [`install`], the folder goes.
pub struct Staged {
    dir: Option<PathBuf>,
    pub bytes: i64,
    pub images: i64,
}

impl Drop for Staged {
    fn drop(&mut self) {
        if let Some(dir) = self.dir.take() {
            let _ = fs::remove_dir_all(dir);
        }
    }
}

/// Downloads the article's pictures and writes the copy into a staging
/// folder under `root`. Up to `caps.parallel` pictures at a time; the
/// library is not locked meanwhile.
pub async fn stage(root: &Path, id: i64, article: &OfflineArticle, limits: &'static Limits, caps: &Caps) -> Result<Staged, CommandError> {
    if article.html.len() > caps.html {
        return Err(CommandError::invalid("The article is too large to keep"));
    }
    let dir = root.join(format!("{STAGING}{id}-{}", uuid::Uuid::new_v4().simple()));
    let images = dir.join(IMAGES);
    fs::create_dir_all(&images).map_err(CommandError::internal)?;
    let mut staged = Staged { dir: Some(dir.clone()), bytes: 0, images: 0 };

    let urls = picture_urls(&article.html, &article.url, caps.images);
    let mut saved = HashMap::new();
    if !urls.is_empty() {
        let client = metadata::client(limits).map_err(CommandError::internal)?;
        let deadline = tokio::time::Instant::now() + caps.time;
        let slots = Arc::new(Semaphore::new(caps.parallel.max(1)));
        let total = Arc::new(AtomicU64::new(0));
        let budget = caps.bytes;
        let mut tasks = tokio::task::JoinSet::new();
        for (index, url) in urls.into_iter().enumerate() {
            let (client, slots, total, images) = (client.clone(), slots.clone(), total.clone(), images.clone());
            tasks.spawn(async move {
                let fetched = tokio::time::timeout_at(deadline, async {
                    let _slot = slots.acquire().await.ok()?;
                    fetch_picture(&client, &url, limits).await
                })
                .await
                .ok()
                .flatten();
                let (bytes, kind) = fetched?;
                let size = bytes.len() as u64;
                // Reserved before writing: pictures that arrive after the budget is spent stay on the web.
                if total.fetch_add(size, Ordering::SeqCst) + size > budget {
                    total.fetch_sub(size, Ordering::SeqCst);
                    return None;
                }
                let file = format!("{:02}.{}", index + 1, kind.ext());
                if tokio::fs::write(images.join(&file), &bytes).await.is_err() {
                    total.fetch_sub(size, Ordering::SeqCst);
                    return None;
                }
                Some((url, file, size))
            });
        }
        while let Some(done) = tasks.join_next().await {
            if let Ok(Some((url, file, size))) = done {
                saved.insert(url, file);
                staged.bytes += size as i64;
            }
        }
    }
    staged.images = saved.len() as i64;

    let html = rewrite(&article.html, &article.url, &saved);
    let mut meta = serde_json::to_value(article).map_err(CommandError::internal)?;
    if let Some(fields) = meta.as_object_mut() {
        fields.remove("html");
    }
    let meta = serde_json::to_vec_pretty(&meta).map_err(CommandError::internal)?;
    fs::write(dir.join(ARTICLE), &html).map_err(CommandError::internal)?;
    fs::write(dir.join(META), &meta).map_err(CommandError::internal)?;
    staged.bytes += (html.len() + meta.len()) as i64;
    Ok(staged)
}

/// Whether the copy in `dir` is the one its row describes: its metadata
/// names the row's page. A restored library's rows meet the folders of the
/// library it replaced by bookmark id; the same page under the same id is
/// the same article whichever bookmark holds it. Not by the bookmark's uid:
/// sync gives a bookmark another uid when two devices saved the same
/// address. Metadata that cannot be read tells nothing either way.
fn belongs(dir: &Path, url: &str) -> bool {
    let Some(meta) = fs::read(dir.join(META)).ok().and_then(|m| serde_json::from_slice::<serde_json::Value>(&m).ok()) else {
        return true;
    };
    meta.get("url").and_then(|u| u.as_str()).is_none_or(|u| u == url)
}

/// Puts the old copy back after a failed replace. If that fails too it
/// stays in its `.old-` folder, which the sweep removes a day later.
fn put_back(old: &Path, target: &Path) {
    if let Err(error) = fs::rename(old, target) {
        eprintln!("The previous offline copy was not put back at {}: {error}", target.display());
    }
}

/// Puts a staged copy in place of the bookmark's old one, if any, and writes
/// its row. Called under the library lock. A bookmark deleted for good
/// meanwhile gets no copy.
pub fn install(conn: &Connection, root: &Path, id: i64, article: &OfflineArticle, mut staged: Staged) -> Result<OfflineCopy, CommandError> {
    let exists: bool = conn.query_row("SELECT EXISTS (SELECT 1 FROM bookmarks WHERE id = ?1)", [id], |r| r.get(0))?;
    if !exists {
        return Err(gone());
    }
    let Some(dir) = staged.dir.take() else {
        return Err(CommandError::internal("the copy was installed already"));
    };
    let target = folder(root, id);
    let replaced = target.exists().then(|| root.join(format!("{REPLACED}{id}-{}", uuid::Uuid::new_v4().simple())));
    if let Some(old) = &replaced {
        if let Err(error) = fs::rename(&target, old) {
            let _ = fs::remove_dir_all(&dir);
            return Err(CommandError::internal(error));
        }
    }
    if let Err(error) = fs::rename(&dir, &target) {
        let _ = fs::remove_dir_all(&dir);
        if let Some(old) = &replaced {
            put_back(old, &target);
        }
        return Err(CommandError::internal(error));
    }
    let copy = OfflineCopy {
        bookmark_id: id,
        saved_at: db::now(),
        url: article.url.clone(),
        bytes: staged.bytes,
        images: staged.images,
        words: article.words.max(0),
    };
    let written = conn.execute(
        "INSERT INTO offline_copies (bookmark_id, saved_at, url, bytes, images, words) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (bookmark_id) DO UPDATE SET saved_at = excluded.saved_at, url = excluded.url,
             bytes = excluded.bytes, images = excluded.images, words = excluded.words",
        params![copy.bookmark_id, copy.saved_at, copy.url, copy.bytes, copy.images, copy.words],
    );
    if let Err(error) = written {
        // The row still describes the old copy: it goes back in place.
        let _ = fs::remove_dir_all(&target);
        if let Some(old) = &replaced {
            put_back(old, &target);
        }
        return Err(error.into());
    }
    // Only now, with the row written, is the old copy no longer needed.
    if let Some(old) = replaced {
        let _ = fs::remove_dir_all(old);
    }
    Ok(copy)
}

fn copy_row(r: &rusqlite::Row) -> rusqlite::Result<OfflineCopy> {
    Ok(OfflineCopy {
        bookmark_id: r.get(0)?,
        saved_at: r.get(1)?,
        url: r.get(2)?,
        bytes: r.get(3)?,
        images: r.get(4)?,
        words: r.get(5)?,
    })
}

pub fn copy_of(conn: &Connection, id: i64) -> rusqlite::Result<Option<OfflineCopy>> {
    conn.query_row(
        "SELECT bookmark_id, saved_at, url, bytes, images, words FROM offline_copies WHERE bookmark_id = ?1",
        [id],
        copy_row,
    )
    .optional()
}

/// A copy's files as read from disk; [`content`] turns them into the article.
pub struct Files {
    copy: OfflineCopy,
    html: String,
    meta: Vec<u8>,
    pictures: HashMap<String, Vec<u8>>,
}

/// Reads the bookmark's copy, under the library lock: an update cannot swap
/// the folder halfway. None without a row or without its files.
pub fn read(conn: &Connection, root: &Path, id: i64) -> rusqlite::Result<Option<Files>> {
    let Some(copy) = copy_of(conn, id)? else {
        return Ok(None);
    };
    let dir = folder(root, id);
    let (Ok(html), Ok(meta)) = (fs::read_to_string(dir.join(ARTICLE)), fs::read(dir.join(META))) else {
        return Ok(None);
    };
    let mut pictures = HashMap::new();
    if let Ok(entries) = fs::read_dir(dir.join(IMAGES)) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if picture_name(&format!("{SCHEME}{name}")).is_some() {
                if let Ok(bytes) = fs::read(entry.path()) {
                    pictures.insert(name, bytes);
                }
            }
        }
    }
    Ok(Some(Files { copy, html, meta, pictures }))
}

/// The article of a copy with its pictures inline. None when its metadata
/// is not readable.
pub fn content(mut files: Files) -> Option<OfflineCopyContent> {
    let html = inline(&files.html, |name, _| files.pictures.remove(name));
    let mut meta: serde_json::Value = serde_json::from_slice(&files.meta).ok()?;
    meta.as_object_mut()?.insert("html".into(), html.into());
    let article = serde_json::from_value(meta).ok()?;
    Some(OfflineCopyContent { copy: files.copy, article })
}

/// Removes the bookmark's copy; true if it had one.
pub fn remove(conn: &Connection, root: &Path, id: i64) -> rusqlite::Result<bool> {
    let removed = conn.execute("DELETE FROM offline_copies WHERE bookmark_id = ?1", [id])? > 0;
    let _ = fs::remove_dir_all(folder(root, id));
    Ok(removed)
}

/// Removes every copy; returns how many there were.
pub fn remove_all(conn: &Connection, root: &Path) -> rusqlite::Result<usize> {
    let removed = conn.execute("DELETE FROM offline_copies", [])?;
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(removed)
}

/// The folders of bookmarks deleted for good (`db::purge_trash`); their rows
/// went with them.
pub fn forget(conn: &Connection, ids: impl IntoIterator<Item = i64>) {
    let Some(root) = root(conn) else { return };
    for id in ids {
        let _ = fs::remove_dir_all(folder(&root, id));
    }
}

/// Bookmarks outside the trash with a copy: «Offline N».
pub fn count(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT count(*) FROM offline_copies o JOIN bookmarks b ON b.id = o.bookmark_id WHERE b.deleted_at IS NULL",
        [],
        |r| r.get(0),
    )
}

pub fn stats(conn: &Connection) -> rusqlite::Result<OfflineStats> {
    conn.query_row("SELECT count(*), COALESCE(sum(bytes), 0) FROM offline_copies", [], |r| {
        Ok(OfflineStats { count: r.get(0)?, bytes: r.get(1)? })
    })
}

/// Makes the rows and the folders agree, at start and hourly with the trash
/// (`library_state`) and after a restore: a row whose folder is gone or
/// holds a copy of another page goes with that folder, a folder
/// without a row goes, a save that never finished goes after a
/// day. Under the library lock. A hard delete elsewhere (a purge synced from
/// another device, a restore) leaves folders behind until then. Returns the
/// rows removed: the list shows a copy no more.
pub fn sweep(conn: &Connection) -> rusqlite::Result<usize> {
    sweep_at(conn, SystemTime::now())
}

fn sweep_at(conn: &Connection, now: SystemTime) -> rusqlite::Result<usize> {
    let Some(root) = root(conn) else { return Ok(0) };
    let described: Vec<(i64, String)> = conn
        .prepare("SELECT bookmark_id, url FROM offline_copies")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let rows: HashSet<i64> = described.iter().map(|(id, _)| *id).collect();
    // A row whose folder is gone, or holds another page's copy: a restored
    // library's rows meet the folders of the library it replaced, by bookmark id.
    let missing: Vec<i64> = described
        .iter()
        .filter(|(id, url)| {
            let dir = folder(&root, *id);
            !dir.join(ARTICLE).is_file() || !belongs(&dir, url)
        })
        .map(|(id, _)| *id)
        .collect();
    if !missing.is_empty() {
        conn.execute(
            "DELETE FROM offline_copies WHERE bookmark_id IN (SELECT value FROM json_each(?1))",
            [db::id_list(&missing)?],
        )?;
    }
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            let orphan = match name.parse::<i64>() {
                Ok(id) => !rows.contains(&id) || missing.contains(&id),
                Err(_) if name.starts_with(STAGING) || name.starts_with(REPLACED) => entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .is_ok_and(|at| now.duration_since(at).unwrap_or_default() > STALE),
                Err(_) => false,
            };
            if orphan && path.is_dir() {
                let _ = fs::remove_dir_all(path);
            }
        }
    }
    Ok(missing.len())
}

/// The first step of a save, under the lock: the bookmark exists; returns
/// the folder of copies. Then [`stage`] without the lock, then [`finish`].
pub fn start(conn: &Connection, id: i64) -> Result<PathBuf, CommandError> {
    let exists: bool = conn.query_row("SELECT EXISTS (SELECT 1 FROM bookmarks WHERE id = ?1)", [id], |r| r.get(0))?;
    if !exists {
        return Err(gone());
    }
    root_of(conn)
}

/// The last step of a save, under the lock: the copy in place, and the
/// bookmark as the list now shows it.
pub fn finish(conn: &Connection, root: &Path, id: i64, article: &OfflineArticle, staged: Staged) -> Result<(OfflineCopy, db::Bookmark), CommandError> {
    let copy = install(conn, root, id, article, staged)?;
    Ok((copy, db::get_bookmark_by_id(conn, id)?))
}

fn gone() -> CommandError {
    CommandError::detailed(ErrorCode::NotFound, ErrorDetail::BookmarkGone, "The bookmark is gone")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{get_bookmarks, insert_or_update_bookmark, trash_bookmark, BookmarkQuery, Purge, Source};
    use crate::library::{self, Paths};
    use std::io::{Read, Write};
    use std::net::{IpAddr, Ipv4Addr, TcpListener};
    use std::sync::Mutex;

    /// A save as the command makes it.
    async fn save(db: &Mutex<Connection>, id: i64, article: &OfflineArticle, limits: &'static Limits, caps: &Caps) -> Result<(OfflineCopy, db::Bookmark), CommandError> {
        let root = start(&db.lock().unwrap(), id)?;
        let staged = stage(&root, id, article, limits, caps).await?;
        let conn = db.lock().unwrap();
        finish(&conn, &root, id, article, staged)
    }

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDRpicture";
    const GIF: &[u8] = b"GIF89a\x01\0\x01\0picture";

    fn first_loopback(ip: IpAddr) -> bool {
        ip == IpAddr::V4(Ipv4Addr::LOCALHOST)
    }
    static TEST: Limits = Limits {
        allow: first_loopback,
        connect_timeout: Duration::from_secs(2),
        timeout: Duration::from_secs(4),
        max_body: 1024,
        max_redirects: 5,
    };
    const TEST_CAPS: Caps = Caps { images: 80, bytes: 1 << 20, time: Duration::from_secs(10), parallel: 4, html: 1 << 20 };

    /// A server on `address` that answers each path with `route(path)`.
    fn server(address: &str, route: impl Fn(&str) -> Vec<u8> + Send + Sync + 'static) -> u16 {
        let listener = TcpListener::bind((address, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let route = Arc::new(route);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let route = route.clone();
                std::thread::spawn(move || {
                    let mut request = [0u8; 4096];
                    let n = stream.read(&mut request).unwrap_or(0);
                    let text = String::from_utf8_lossy(&request[..n]);
                    let path = text.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let _ = stream.write_all(&route(&path));
                });
            }
        });
        port
    }

    fn answer(status: &str, content_type: &str, body: &[u8]) -> Vec<u8> {
        let mut reply = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        reply.extend_from_slice(body);
        reply
    }

    fn pictures(path: &str) -> Vec<u8> {
        match path {
            "/a.png" | "/b.png" => answer("200 OK", "image/png", PNG),
            "/c.gif" => answer("200 OK", "image/gif; charset=binary", GIF),
            "/lies.png" => answer("200 OK", "image/png", b"<html>not a picture</html>"),
            "/page.png" => answer("200 OK", "text/html", PNG),
            "/huge.png" => answer("200 OK", "image/png", &[PNG, &[0u8; 2048]].concat()),
            "/hop.png" => b"HTTP/1.1 302 Found\r\nLocation: /a.png\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
            _ => answer("404 Not Found", "text/plain", b"gone"),
        }
    }

    fn library(name: &str) -> (PathBuf, Mutex<Connection>) {
        let folder = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.test-data")
            .join(format!("offline-{name}-{}", uuid::Uuid::new_v4()));
        let opened = library::open(&Paths::new(folder.join("koonapin.db"))).unwrap();
        (folder, Mutex::new(opened.conn))
    }

    fn add(conn: &Connection, path: &str) -> i64 {
        insert_or_update_bookmark(conn, &format!("https://example.com/{path}"), path, None, None, None, "example.com", None, None, Source::App)
            .unwrap()
            .id
    }

    fn article(url: &str, html: &str) -> OfflineArticle {
        OfflineArticle {
            url: url.into(),
            title: "Title".into(),
            author: Some("Author".into()),
            site: None,
            published: None,
            description: None,
            language: Some("en".into()),
            html: html.into(),
            words: 42,
        }
    }

    fn srcs(html: &str) -> Vec<String> {
        let document = Html::parse_fragment(html);
        let img = scraper::Selector::parse("img").unwrap();
        document.select(&img).map(|i| i.value().attr("src").unwrap_or("").to_string()).collect()
    }

    #[test]
    fn pictures_are_found_once_resolved_and_capped() {
        let html = r#"<p><img src="/a.png"><img src=" https://cdn.example.org/b.jpg "><img src="/a.png"><img src="data:image/png;base64,AAAA"><img src="javascript:x"><img></p>"#;
        let urls: Vec<String> = picture_urls(html, "https://example.com/post/1", 80).iter().map(Url::to_string).collect();
        assert_eq!(urls, ["https://example.com/a.png", "https://cdn.example.org/b.jpg"]);
        assert_eq!(picture_urls(html, "https://example.com/", 1).len(), 1);
        assert!(picture_urls("<p>No pictures</p>", "https://example.com/", 80).is_empty());
    }

    #[test]
    fn saved_pictures_point_into_the_copy_and_the_rest_stay_on_the_web() {
        let html = r#"<figure><picture><source srcset="/a.avif" type="image/avif"><img src="a.png" srcset="/a-2x.png 2x" sizes="100vw" alt="A"></picture></figure><p>Text <img src="/missing.png"></p>"#;
        let saved = HashMap::from([(Url::parse("https://example.com/post/a.png").unwrap(), "01.png".to_string())]);
        let out = rewrite(html, "https://example.com/post/", &saved);
        assert_eq!(srcs(&out), ["koona-offline:01.png", "https://example.com/missing.png"]);
        assert!(!out.contains("<source") && !out.contains("srcset") && !out.contains("sizes"), "{out}");
        assert!(out.contains(r#"alt="A""#) && out.contains("<p>Text "), "{out}");
    }

    #[test]
    fn a_copy_reads_with_its_pictures_inline() {
        let html = r#"<p><img src="koona-offline:01.png"><img src="koona-offline:02.gif"><img src="koona-offline:../../koonapin.db"><img src="https://example.com/x.png"></p>"#;
        let out = inline(html, |name, kind| (name == "01.png" && kind == ImageKind::Png).then(|| PNG.to_vec()));
        let found = srcs(&out);
        assert!(found[0].starts_with("data:image/png;base64,iVBORw0KGgo"), "{}", found[0]);
        assert_eq!(&found[1..], ["", "", "https://example.com/x.png"], "an unknown or missing file loses its src");
        assert!(!out.contains("koona-offline:"));
    }

    #[test]
    fn formats_are_told_by_their_header_and_their_bytes() {
        assert_eq!(ImageKind::from_content_type("image/PNG"), Some(ImageKind::Png));
        assert_eq!(ImageKind::from_content_type("image/jpg; q=1"), Some(ImageKind::Jpeg));
        assert_eq!(ImageKind::from_content_type("image/svg+xml"), None);
        assert_eq!(ImageKind::from_content_type("text/html"), None);
        assert_eq!(ImageKind::sniff(PNG), Some(ImageKind::Png));
        assert_eq!(ImageKind::sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), Some(ImageKind::Jpeg));
        assert_eq!(ImageKind::sniff(GIF), Some(ImageKind::Gif));
        assert_eq!(ImageKind::sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some(ImageKind::Webp));
        assert_eq!(ImageKind::sniff(b"\0\0\0\x1cftypavif\0\0\0\0avifmif1"), Some(ImageKind::Avif));
        assert_eq!(ImageKind::sniff(b"\0\0\0\x1cftypmif1\0\0\0\0mif1avif"), Some(ImageKind::Avif));
        assert_eq!(ImageKind::sniff(b"\0\0\0\x18ftypmp42\0\0\0\0isom"), None, "a video");
        assert_eq!(ImageKind::sniff(b"<svg xmlns="), None);
        assert_eq!(picture_name("koona-offline:07.webp").map(|p| p.1), Some(ImageKind::Webp));
        for refused in ["koona-offline:../a.png", "koona-offline:01.svg", "koona-offline:.png", "koona-offline:1234.png", "01.png"] {
            assert!(picture_name(refused).is_none(), "{refused}");
        }
    }

    #[tokio::test]
    async fn a_copy_keeps_good_pictures_and_leaves_the_rest_on_the_web() {
        let port = server("127.0.0.1", pictures);
        let hits = Arc::new(AtomicU64::new(0));
        let counted = hits.clone();
        let inside = server("127.0.0.1", move |path| {
            counted.fetch_add(1, Ordering::SeqCst);
            pictures(path)
        });
        let base = format!("http://127.0.0.1:{port}/post/");
        let html = format!(
            r#"<p>Hello</p><img src="/a.png"><img src="/c.gif"><img src="/lies.png"><img src="/page.png"><img src="/huge.png"><img src="/hop.png"><img src="/nothing.png"><img src="http://localhost:{inside}/a.png"><img src="http://127.0.0.2:{inside}/a.png">"#
        );
        let (root, conn) = library("pictures");
        let id = add(&conn.lock().unwrap(), "pictures");
        let (copy, bookmark) = save(&conn, id, &article(&base, &html), &TEST, &TEST_CAPS).await.unwrap();
        assert_eq!(copy.images, 3, "a.png, c.gif and the redirect to a.png");
        assert_eq!(bookmark.offline_at.as_deref(), Some(copy.saved_at.as_str()));
        let dir = root.join(FOLDER).join(id.to_string());
        let mut files: Vec<String> = fs::read_dir(dir.join(IMAGES)).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        files.sort();
        assert_eq!(files, ["01.png", "02.gif", "06.png"]);
        let stored = fs::read_to_string(dir.join(ARTICLE)).unwrap();
        let found = srcs(&stored);
        assert_eq!(&found[..2], ["koona-offline:01.png", "koona-offline:02.gif"]);
        assert_eq!(found[2], format!("http://127.0.0.1:{port}/lies.png"), "a page posing as a picture stays on the web");
        assert_eq!(found[4], format!("http://127.0.0.1:{port}/huge.png"), "over the size limit");
        assert_eq!(found[5], "koona-offline:06.png");
        assert_eq!(found[7], format!("http://localhost:{inside}/a.png"), "a local name is never requested");
        assert_eq!(found[8], format!("http://127.0.0.2:{inside}/a.png"), "nor a local address");
        assert_eq!(hits.load(Ordering::SeqCst), 0);
        let meta: serde_json::Value = serde_json::from_slice(&fs::read(dir.join(META)).unwrap()).unwrap();
        assert!(meta.get("html").is_none() && meta["title"] == "Title" && meta["words"] == 42);
        let size: u64 = walk(&dir);
        assert_eq!(copy.bytes as u64, size, "the folder's size");
        assert!(fs::read_dir(root.join(FOLDER)).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with('.')), "no staging left");

        // Read back: the pictures are inline, the metadata whole.
        let content = content(read(&conn.lock().unwrap(), &root.join(FOLDER), id).unwrap().unwrap()).unwrap();
        assert_eq!(content.copy, copy);
        assert_eq!((content.article.title.as_str(), content.article.author.as_deref(), content.article.words), ("Title", Some("Author"), 42));
        let inlined = srcs(&content.article.html);
        assert!(inlined[0].starts_with("data:image/png;base64,") && inlined[1].starts_with("data:image/gif;base64,"));
        assert!(content.article.html.contains("<p>Hello</p>"));
    }

    fn walk(dir: &Path) -> u64 {
        fs::read_dir(dir)
            .unwrap()
            .map(|e| {
                let path = e.unwrap().path();
                if path.is_dir() { walk(&path) } else { fs::metadata(path).unwrap().len() }
            })
            .sum()
    }

    #[tokio::test]
    async fn pictures_stop_at_the_count_and_the_total_size() {
        let port = server("127.0.0.1", pictures);
        let base = format!("http://127.0.0.1:{port}/");
        let html = r#"<img src="/a.png"><img src="/b.png"><img src="/c.gif">"#;
        let (root, conn) = library("caps");
        let id = add(&conn.lock().unwrap(), "caps");
        let few = Caps { images: 2, ..TEST_CAPS };
        assert_eq!(stage(&root, id, &article(&base, html), &TEST, &few).await.unwrap().images, 2);
        let small = Caps { bytes: (PNG.len() + GIF.len()) as u64, parallel: 1, ..TEST_CAPS };
        assert_eq!(stage(&root, id, &article(&base, html), &TEST, &small).await.unwrap().images, 2, "the third does not fit");
        let tiny = Caps { html: 4, ..TEST_CAPS };
        assert!(stage(&root, id, &article(&base, html), &TEST, &tiny).await.is_err());
        assert_eq!(fs::read_dir(&root).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().starts_with(STAGING)).count(), 0, "a dropped stage leaves nothing");
    }

    #[tokio::test]
    async fn copies_list_count_update_go_with_a_purge_and_stay_in_the_trash() {
        let (root, conn) = library("lifecycle");
        let offline = root.join(FOLDER);
        let (a, b, c) = {
            let conn = conn.lock().unwrap();
            (add(&conn, "a"), add(&conn, "b"), add(&conn, "c"))
        };
        let first = save(&conn, a, &article("https://example.com/a", "<p>First secret text</p>"), &TEST, &TEST_CAPS).await.unwrap().0;
        save(&conn, b, &article("https://example.com/b", "<p>B</p>"), &TEST, &TEST_CAPS).await.unwrap();
        // An update replaces the copy whole.
        let second = save(&conn, a, &article("https://example.com/a", "<p>Second</p>"), &TEST, &TEST_CAPS).await.unwrap().0;
        assert!(second.saved_at >= first.saved_at);
        let conn = conn.lock().unwrap();
        let text = fs::read_to_string(offline.join(a.to_string()).join(ARTICLE)).unwrap();
        assert_eq!(text, "<p>Second</p>");

        let only = BookmarkQuery { only_offline: true, ..Default::default() };
        let titles = |q: &BookmarkQuery| get_bookmarks(&conn, q).unwrap().items.into_iter().map(|b| b.title).collect::<Vec<_>>();
        assert_eq!(titles(&only), ["b", "a"]);
        assert_eq!(count(&conn).unwrap(), 2);
        assert_eq!(stats(&conn).unwrap().count, 2);
        let all = get_bookmarks(&conn, &BookmarkQuery::default()).unwrap().items;
        assert_eq!(all.iter().map(|b| b.offline_at.is_some()).collect::<Vec<_>>(), [false, true, true]);

        // Nothing of the text in an export.
        let (json, _) = crate::export::json(&conn, crate::export::Scope::Library, chrono::Utc::now()).unwrap();
        let (html, _) = crate::export::html(&conn, crate::export::Scope::Library).unwrap();
        assert!(!json.contains("Second") && !json.contains("offline") && !html.contains("Second"));

        // The trash keeps the copy, restoring brings it back to the list.
        trash_bookmark(&conn, a).unwrap();
        assert_eq!(count(&conn).unwrap(), 1);
        assert_eq!(titles(&only), ["b"]);
        assert!(offline.join(a.to_string()).exists());
        db::restore_bookmark(&conn, a, false).unwrap();
        assert_eq!(count(&conn).unwrap(), 2);
        // A purge deletes the folder.
        trash_bookmark(&conn, a).unwrap();
        db::purge_trash(&conn, Purge::All).unwrap();
        assert!(!offline.join(a.to_string()).exists());
        assert!(copy_of(&conn, a).unwrap().is_none());

        // Removing one, then all.
        assert!(remove(&conn, &offline, b).unwrap());
        assert!(!remove(&conn, &offline, b).unwrap());
        assert!(!offline.join(b.to_string()).exists());
        assert!(db::get_bookmark_by_id(&conn, b).unwrap().offline_at.is_none());
        assert!(read(&conn, &offline, c).unwrap().is_none(), "no copy, nothing to read");
    }

    #[tokio::test]
    async fn remove_all_and_the_sweep_leave_rows_and_folders_agreeing() {
        let (root, conn) = library("sweep");
        let offline = root.join(FOLDER);
        let ids: Vec<i64> = {
            let conn = conn.lock().unwrap();
            ["a", "b", "c"].iter().map(|p| add(&conn, p)).collect()
        };
        for id in &ids {
            save(&conn, *id, &article("https://example.com/", "<p>x</p>"), &TEST, &TEST_CAPS).await.unwrap();
        }
        let conn = conn.lock().unwrap();
        // A folder gone, a folder without a row, a fresh and a stale staging folder.
        fs::remove_dir_all(offline.join(ids[0].to_string())).unwrap();
        fs::create_dir_all(offline.join("999")).unwrap();
        let staging = offline.join(format!("{STAGING}5-abc"));
        fs::create_dir_all(&staging).unwrap();
        assert_eq!(sweep(&conn).unwrap(), 1);
        assert!(copy_of(&conn, ids[0]).unwrap().is_none());
        assert!(!offline.join("999").exists());
        assert!(staging.exists(), "a save may still be writing it");
        assert_eq!(sweep_at(&conn, SystemTime::now() + STALE + Duration::from_secs(60)).unwrap(), 0);
        assert!(!staging.exists(), "a day later it was left behind");
        assert_eq!(stats(&conn).unwrap().count, 2);
        assert!(offline.join(ids[1].to_string()).join(ARTICLE).exists());

        assert_eq!(remove_all(&conn, &offline).unwrap(), 2);
        assert_eq!(stats(&conn).unwrap(), OfflineStats { count: 0, bytes: 0 });
        assert_eq!(fs::read_dir(&offline).unwrap().count(), 0);
    }

    /// An update whose row cannot be written keeps the old copy whole: the
    /// folder and the row still agree, nothing half-replaced is left.
    #[tokio::test]
    async fn a_failed_update_keeps_the_old_copy() {
        let (root, conn) = library("failed-update");
        let offline = root.join(FOLDER);
        let id = add(&conn.lock().unwrap(), "a");
        let first = save(&conn, id, &article("https://example.com/a", "<p>First</p>"), &TEST, &TEST_CAPS).await.unwrap().0;
        conn.lock()
            .unwrap()
            .execute_batch(
                "CREATE TEMP TRIGGER refuse_insert BEFORE INSERT ON offline_copies BEGIN SELECT RAISE(ABORT, 'disk full'); END;
                 CREATE TEMP TRIGGER refuse_update BEFORE UPDATE ON offline_copies BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
            )
            .unwrap();
        assert!(save(&conn, id, &article("https://example.com/a", "<p>Second</p>"), &TEST, &TEST_CAPS).await.is_err());
        let conn = conn.lock().unwrap();
        assert_eq!(fs::read_to_string(offline.join(id.to_string()).join(ARTICLE)).unwrap(), "<p>First</p>");
        assert_eq!(copy_of(&conn, id).unwrap(), Some(first.clone()));
        let content = content(read(&conn, &offline, id).unwrap().unwrap()).unwrap();
        assert_eq!((content.copy, content.article.html.as_str()), (first, "<p>First</p>"));
        let names: Vec<String> = fs::read_dir(&offline).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, [id.to_string()], "no staging or replaced folder left");
    }

    /// A restored library's rows meet the folders of the library it
    /// replaced by bookmark id: a folder holding another page's copy goes
    /// with its row. A bookmark that got another uid from sync (two devices
    /// saved the same address) keeps its copy, and so does a copy whose
    /// metadata names a bookmark uid.
    #[tokio::test]
    async fn the_sweep_drops_rows_whose_folder_holds_another_page() {
        let (root, conn) = library("identity");
        let offline = root.join(FOLDER);
        let ids: Vec<i64> = {
            let conn = conn.lock().unwrap();
            ["a", "b", "c", "d"].iter().map(|p| add(&conn, p)).collect()
        };
        for (id, path) in ids.iter().zip(["a", "b", "c", "d"]) {
            save(&conn, *id, &article(&format!("https://example.com/{path}"), "<p>x</p>"), &TEST, &TEST_CAPS).await.unwrap();
        }
        let conn = conn.lock().unwrap();
        // Another library's row for the same id: another page.
        conn.execute("UPDATE offline_copies SET url = 'https://other.example/' WHERE bookmark_id = ?1", [ids[0]]).unwrap();
        // Sync's takeover of the same address gives the bookmark the arriving uid; its id stays.
        conn.execute("UPDATE bookmarks SET uid = ?1 WHERE id = ?2", params![db::new_uid(), ids[1]]).unwrap();
        // Metadata that names some bookmark uid, as a copy may: not read.
        let path = offline.join(ids[2].to_string()).join(META);
        let mut meta: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        meta.as_object_mut().unwrap().insert("bookmark_uid".into(), db::new_uid().into());
        fs::write(&path, serde_json::to_vec(&meta).unwrap()).unwrap();

        assert_eq!(sweep(&conn).unwrap(), 1);
        let kept = |id: i64| copy_of(&conn, id).unwrap().is_some() && offline.join(id.to_string()).exists();
        assert_eq!(ids.iter().map(|id| kept(*id)).collect::<Vec<_>>(), [false, true, true, true]);
        assert!(!offline.join(ids[0].to_string()).exists(), "the other page's folder goes too");
        assert!(read(&conn, &offline, ids[0]).unwrap().is_none());
        for id in &ids[1..] {
            assert!(content(read(&conn, &offline, *id).unwrap().unwrap()).is_some(), "still reads");
        }
        assert_eq!(sweep(&conn).unwrap(), 0, "the rest agree");
    }

    #[tokio::test]
    async fn a_bookmark_that_is_gone_gets_no_copy() {
        let (root, conn) = library("gone");
        let error = save(&conn, 12345, &article("https://example.com/", "<p>x</p>"), &TEST, &TEST_CAPS).await.unwrap_err();
        assert_eq!(error.detail, Some(ErrorDetail::BookmarkGone));
        // Deleted for good while the pictures were coming.
        let id = add(&conn.lock().unwrap(), "late");
        let staged = stage(&root.join(FOLDER), id, &article("https://example.com/", "<p>x</p>"), &TEST, &TEST_CAPS).await.unwrap();
        let conn = conn.lock().unwrap();
        trash_bookmark(&conn, id).unwrap();
        db::purge_trash(&conn, Purge::One(id)).unwrap();
        assert!(install(&conn, &root.join(FOLDER), id, &article("https://example.com/", "<p>x</p>"), staged).is_err());
        assert!(!root.join(FOLDER).join(id.to_string()).exists());
        assert_eq!(fs::read_dir(root.join(FOLDER)).unwrap().count(), 0);
    }

    #[test]
    fn the_setting_is_off_by_default() {
        let mut conn = Connection::open_in_memory().unwrap();
        library::configure(&conn).unwrap();
        crate::migrations::migrate(&mut conn, None).unwrap();
        assert!(!save_on_open(&conn));
        db::set_setting(&conn, SAVE_SETTING, "true").unwrap();
        assert!(save_on_open(&conn));
        assert!(root(&conn).is_none(), "a library in memory has no folder");
        assert_eq!(sweep(&conn).unwrap(), 0);
    }
}
