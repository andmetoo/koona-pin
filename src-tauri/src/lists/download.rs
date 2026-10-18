//! The one-click download of a list (NP-138): `koonapin://import?url=https://…`
//! asks first, and only **Download** sends a request. It goes through the same
//! guard as previews (NP-019, `metadata.rs`): https on every hop, at most five
//! redirects, no local or private address, no proxy, Referer or cookies, at
//! most 2 MB counted while the body streams, 15 seconds in all. The content
//! type is not trusted: the text is parsed as a list afterwards, as a file is.
//!
//! A file opened with the app comes here too, by its path ([`read_list_file`]).

use super::{format, read_file, ListError};
use crate::metadata::{self, FetchError, Limits};
use crate::net_guard;
use crate::open_requests;
use reqwest::{header, redirect};
use serde::Serialize;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;
use ts_rs::TS;
use url::Url;

/// The event of the dialog's progress bar while a list downloads.
pub const PROGRESS_EVENT: &str = "list-download-progress";

/// What a list download may do.
pub struct DownloadLimits {
    /// Addresses, timeouts (the whole exchange in `timeout`), size and redirects.
    pub net: Limits,
    /// The scheme every hop must have: https; tests stand a path in for it.
    pub secure: fn(&Url) -> bool,
}

fn https(url: &Url) -> bool {
    url.scheme() == "https"
}

impl DownloadLimits {
    pub const PUBLIC: DownloadLimits = DownloadLimits {
        net: Limits {
            allow: net_guard::public_ip,
            connect_timeout: Duration::from_secs(6),
            timeout: Duration::from_secs(15),
            max_body: format::MAX_BYTES,
            max_redirects: 5,
        },
        secure: https,
    };
}

/// Why a list was not downloaded: the reason the dialog gives (K3, state 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadError {
    /// The address, or one it redirects to, is not https.
    NotHttps,
    /// A local or private address, or a name of one: nothing was sent there.
    Refused,
    /// The server answered, but not with the file.
    Status(u16),
    /// More than 2 MB.
    TooBig,
    /// More than 15 seconds in all.
    Timeout,
    /// No connection, a TLS failure, a broken answer.
    Unreachable,
    TooManyRedirects,
}

impl From<FetchError> for DownloadError {
    fn from(error: FetchError) -> Self {
        match error {
            FetchError::Refused => DownloadError::Refused,
            FetchError::Timeout => DownloadError::Timeout,
            FetchError::Failed => DownloadError::Unreachable,
        }
    }
}

/// A downloaded body and the address it came from, after the redirects.
#[derive(Debug)]
pub struct Downloaded {
    pub bytes: Vec<u8>,
    pub url: Url,
}

/// The client of list downloads: the guard's resolver, no proxy or Referer,
/// gzip (the 2 MB count is of what it unpacks), redirects followed by
/// [`download`] itself so that each hop is checked before it is asked.
/// reqwest is built without a cookie store: no cookies are sent or kept.
pub fn client(limits: &DownloadLimits) -> reqwest::Result<reqwest::Client> {
    let mut headers = header::HeaderMap::new();
    headers.insert(
        header::ACCEPT,
        header::HeaderValue::from_static("application/vnd.koona.list+json, application/json;q=0.9, */*;q=0.5"),
    );
    metadata::guarded(&limits.net)
        .gzip(true)
        .redirect(redirect::Policy::none())
        .default_headers(headers)
        .user_agent(metadata::FEED_USER_AGENT)
        .build()
}

/// Downloads `url` under `limits`; `progress` hears the bytes so far and the size when it is given.
pub async fn download(
    client: &reqwest::Client,
    url: &str,
    limits: &DownloadLimits,
    progress: impl FnMut(usize, Option<usize>),
) -> Result<Downloaded, DownloadError> {
    match tokio::time::timeout(limits.net.timeout, within(client, url, limits, progress)).await {
        Ok(result) => result,
        Err(_) => Err(DownloadError::Timeout),
    }
}

async fn within(
    client: &reqwest::Client,
    url: &str,
    limits: &DownloadLimits,
    mut progress: impl FnMut(usize, Option<usize>),
) -> Result<Downloaded, DownloadError> {
    let mut current = Url::parse(url.trim()).map_err(|_| DownloadError::NotHttps)?;
    let max = limits.net.max_body;
    for _ in 0..=limits.net.max_redirects {
        if !(limits.secure)(&current) {
            return Err(DownloadError::NotHttps);
        }
        // No credentials go anywhere, not even ones written into the address.
        if !current.username().is_empty() || current.password().is_some() || !net_guard::allowed_url(&current, limits.net.allow) {
            return Err(DownloadError::Refused);
        }
        let mut response = client.get(current.clone()).send().await.map_err(|e| DownloadError::from(metadata::failure(&e)))?;
        let status = response.status();
        if status.is_redirection() {
            let next = response
                .headers()
                .get(header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|to| current.join(to.trim()).ok());
            let Some(next) = next else {
                return Err(DownloadError::Unreachable);
            };
            current = next;
            continue;
        }
        if !status.is_success() {
            return Err(DownloadError::Status(status.as_u16()));
        }
        // A size given is only a hint, and none at all for a compressed body (what counts is what
        // it unpacks to): the count below decides.
        let total = match response.headers().contains_key(header::CONTENT_ENCODING) {
            true => None,
            false => response.content_length().map(|n| usize::try_from(n).unwrap_or(usize::MAX)),
        };
        if total.is_some_and(|n| n > max) {
            return Err(DownloadError::TooBig);
        }
        let mut bytes = Vec::new();
        progress(0, total);
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    if bytes.len() + chunk.len() > max {
                        return Err(DownloadError::TooBig);
                    }
                    bytes.extend_from_slice(&chunk);
                    progress(bytes.len(), total);
                }
                Ok(None) => return Ok(Downloaded { bytes, url: current }),
                Err(e) => return Err(metadata::failure(&e).into()),
            }
        }
    }
    Err(DownloadError::TooManyRedirects)
}

/// The answer of `download_list`: the list's text, or why there is none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "outcome", rename_all = "snake_case")]
#[ts(export)]
pub enum ListDownload {
    /// The text, to preview and import; `url` is where it came from after the redirects.
    Done { text: String, url: String },
    NotHttps,
    Refused,
    Status { status: u16 },
    TooBig,
    Timeout,
    Unreachable,
    TooManyRedirects,
    /// Not UTF-8 text: not a list, whatever its type said.
    NotAList,
    /// The person pressed Cancel.
    Cancelled,
}

impl From<DownloadError> for ListDownload {
    fn from(error: DownloadError) -> Self {
        match error {
            DownloadError::NotHttps => ListDownload::NotHttps,
            DownloadError::Refused => ListDownload::Refused,
            DownloadError::Status(status) => ListDownload::Status { status },
            DownloadError::TooBig => ListDownload::TooBig,
            DownloadError::Timeout => ListDownload::Timeout,
            DownloadError::Unreachable => ListDownload::Unreachable,
            DownloadError::TooManyRedirects => ListDownload::TooManyRedirects,
        }
    }
}

/// The bytes of the download so far, for the dialog's bar. `ticket` is the
/// dialog's number for this download: a late event of an earlier one is ignored.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct ListDownloadProgress {
    pub ticket: u32,
    pub received: u32,
    /// As the server gave it, when it did and the body is not compressed.
    pub total: Option<u32>,
}

/// The download in progress with its ticket, for Cancel. One dialog downloads at a time.
static CANCEL: Mutex<Option<(u32, Arc<Notify>)>> = Mutex::new(None);

/// The highest ticket cancelled so far. Tickets only grow (the interface counts
/// them for the whole session), so a Cancel that reaches Rust before its
/// download has started is not lost: the download sees it and stops at once.
static CANCELLED: AtomicU32 = AtomicU32::new(0);

/// Holds the download's place in [`CANCEL`] and gives it up on every way
/// out, unless a newer download took it meanwhile.
struct CancelSlot(Arc<Notify>);

impl CancelSlot {
    fn take(ticket: u32) -> Self {
        let cancel = Arc::new(Notify::new());
        *CANCEL.lock().unwrap_or_else(|e| e.into_inner()) = Some((ticket, cancel.clone()));
        // Cancelled before it got here: the permit makes the download stop at its first await.
        if ticket != 0 && CANCELLED.load(Ordering::SeqCst) >= ticket {
            cancel.notify_one();
        }
        CancelSlot(cancel)
    }
}

impl Drop for CancelSlot {
    fn drop(&mut self) {
        let mut current = CANCEL.lock().unwrap_or_else(|e| e.into_inner());
        if current.as_ref().is_some_and(|(_, c)| Arc::ptr_eq(c, &self.0)) {
            *current = None;
        }
    }
}

/// A download that `cancel` can stop at any point, as the dialog's answer.
pub async fn fetch_list(url: &str, limits: &DownloadLimits, cancel: &Notify, progress: impl FnMut(usize, Option<usize>)) -> ListDownload {
    let Ok(client) = client(limits) else {
        return ListDownload::Unreachable;
    };
    let result = tokio::select! {
        result = download(&client, url, limits, progress) => result,
        _ = cancel.notified() => return ListDownload::Cancelled,
    };
    match result {
        Ok(downloaded) => match String::from_utf8(downloaded.bytes) {
            Ok(text) => ListDownload::Done { text, url: downloaded.url.to_string() },
            Err(_) => ListDownload::NotAList,
        },
        Err(error) => error.into(),
    }
}

/// **Download** in the dialog (K3, state 1 → 2).
#[tauri::command]
pub async fn download_list(app: AppHandle, url: String, ticket: u32) -> ListDownload {
    let slot = CancelSlot::take(ticket);
    let mut shown = Instant::now() - Duration::from_secs(1);
    let progress = |received: usize, total: Option<usize>| {
        if shown.elapsed() >= Duration::from_millis(100) || total == Some(received) {
            shown = Instant::now();
            let clamp = |n: usize| n.min(u32::MAX as usize) as u32;
            let _ = app.emit(PROGRESS_EVENT, ListDownloadProgress { ticket, received: clamp(received), total: total.map(clamp) });
        }
    };
    fetch_list(&url, &DownloadLimits::PUBLIC, &slot.0, progress).await
}

/// **Cancel** while a list downloads, or a dialog that goes while one runs:
/// nothing more is read, and nothing was kept. `ticket` is the download's; one
/// that has not started yet stops as soon as it does.
#[tauri::command]
pub fn cancel_list_download(ticket: u32) {
    CANCELLED.fetch_max(ticket, Ordering::SeqCst);
    let mut current = CANCEL.lock().unwrap_or_else(|e| e.into_inner());
    if current.as_ref().is_some_and(|(mine, _)| *mine <= ticket) {
        if let Some((_, cancel)) = current.take() {
            cancel.notify_one();
        }
    }
}

/// The answer of `read_list_file`: the text of a `.kpin` the system opened with the app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "outcome", rename_all = "snake_case")]
#[ts(export)]
pub enum ListFile {
    Read { text: String, name: String },
    NotAList,
    TooBig,
    Unreadable,
}

/// A `.kpin` given by the system (`OpenRequest::KpinPath`), checked again as the
/// entry points check it: an existing regular file named `.kpin`, at most 2 MB, UTF-8.
#[tauri::command]
pub async fn read_list_file(path: String) -> ListFile {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = open_requests::kpin_file(std::path::Path::new(&path)) else {
            return ListFile::Unreadable;
        };
        let path = std::path::PathBuf::from(path);
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        match read_file(&path) {
            Ok(text) => ListFile::Read { text, name },
            Err(ListError::TooBig) => ListFile::TooBig,
            Err(ListError::NotAList) => ListFile::NotAList,
            Err(_) => ListFile::Unreadable,
        }
    })
    .await
    .unwrap_or(ListFile::Unreadable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{IpAddr, Ipv4Addr, TcpListener};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A server on 127.0.0.1 that answers each request with `reply(port, path)` and counts them.
    fn server(reply: impl Fn(u16, &str) -> Vec<u8> + Send + 'static) -> (u16, Arc<AtomicUsize>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let counted = hits.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                counted.fetch_add(1, Ordering::SeqCst);
                let mut request = [0u8; 4096];
                let read = stream.read(&mut request).unwrap_or(0);
                let head = String::from_utf8_lossy(&request[..read]).to_string();
                let path = head.split(' ').nth(1).unwrap_or("/").to_string();
                let _ = stream.write_all(&reply(port, &path));
            }
        });
        (port, hits)
    }

    fn ok(body: &str) -> Vec<u8> {
        format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).into_bytes()
    }

    fn found(location: &str) -> Vec<u8> {
        format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes()
    }

    /// Tests reach 127.0.0.1 only; the rest of 127/8 stands for the local network.
    fn first_loopback(ip: IpAddr) -> bool {
        ip == IpAddr::V4(Ipv4Addr::LOCALHOST)
    }

    /// The test server speaks plain HTTP: an address under `/plain/` stands for an http one.
    fn not_plain(url: &Url) -> bool {
        !url.path().starts_with("/plain/")
    }

    const TEST: DownloadLimits = DownloadLimits {
        net: Limits {
            allow: first_loopback,
            connect_timeout: Duration::from_secs(2),
            timeout: Duration::from_secs(1),
            max_body: 1024,
            max_redirects: 5,
        },
        secure: not_plain,
    };

    async fn get(url: &str) -> Result<Downloaded, DownloadError> {
        download(&client(&TEST).unwrap(), url, &TEST, |_, _| {}).await
    }

    #[tokio::test]
    async fn a_list_is_downloaded_through_its_redirects() {
        let (port, _) = server(|port, path| match path {
            "/a" => found(&format!("http://127.0.0.1:{port}/b")),
            "/b" => found("/list.kpin"),
            _ => ok("{\"format\":\"koona\"}"),
        });
        let got = get(&format!("http://127.0.0.1:{port}/a")).await.unwrap();
        assert_eq!(got.bytes, b"{\"format\":\"koona\"}");
        assert_eq!(got.url.path(), "/list.kpin");
    }

    #[tokio::test]
    async fn a_redirect_to_http_is_refused_before_it_is_asked() {
        let (target, hits) = server(|_, _| ok("{}"));
        let (hop, _) = server(move |_, _| found(&format!("http://127.0.0.1:{target}/plain/list.kpin")));
        assert_eq!(get(&format!("http://127.0.0.1:{hop}/")).await.unwrap_err(), DownloadError::NotHttps);
        assert_eq!(hits.load(Ordering::SeqCst), 0);
        // And the first address too; the real rule is the scheme.
        assert_eq!(get(&format!("http://127.0.0.1:{target}/plain/x")).await.unwrap_err(), DownloadError::NotHttps);
        assert!(!https(&Url::parse("http://koona.app/x.kpin").unwrap()));
        assert!(https(&Url::parse("https://koona.app/x.kpin").unwrap()));
    }

    #[tokio::test]
    async fn a_local_address_is_refused() {
        let (target, hits) = server(|_, _| ok("{}"));
        for local in [format!("http://127.0.0.3:{target}/"), format!("http://localhost:{target}/"), "http://10.0.0.1/".into()] {
            assert_eq!(get(&local).await.unwrap_err(), DownloadError::Refused, "{local}");
            let (hop, _) = server(move |_, _| found(&local));
            assert_eq!(get(&format!("http://127.0.0.1:{hop}/")).await.unwrap_err(), DownloadError::Refused);
        }
        assert_eq!(get(&format!("http://user:secret@127.0.0.1:{target}/")).await.unwrap_err(), DownloadError::Refused);
        assert_eq!(hits.load(Ordering::SeqCst), 0);
        // The real limits refuse this computer as well.
        assert!(!(DownloadLimits::PUBLIC.net.allow)(IpAddr::V4(Ipv4Addr::LOCALHOST)));
    }

    #[tokio::test]
    async fn an_oversize_list_is_refused_whether_its_size_is_given_or_not() {
        let big = "x".repeat(TEST.net.max_body + 1);
        let (given, _) = server(move |_, _| ok(&big));
        assert_eq!(get(&format!("http://127.0.0.1:{given}/")).await.unwrap_err(), DownloadError::TooBig);
        // No Content-Length: the body ends with the connection and is counted as it comes.
        let (streamed, _) = server(|_, _| {
            let mut reply = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
            reply.extend(std::iter::repeat_n(b'x', 4096));
            reply
        });
        assert_eq!(get(&format!("http://127.0.0.1:{streamed}/")).await.unwrap_err(), DownloadError::TooBig);
        // A size that lies small is no way past the count.
        let (lying, _) = server(|_, _| {
            let mut reply = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".to_vec();
            for _ in 0..8 {
                reply.extend(b"200\r\n");
                reply.extend(std::iter::repeat_n(b'x', 0x200));
                reply.extend(b"\r\n");
            }
            reply.extend(b"0\r\n\r\n");
            reply
        });
        assert_eq!(get(&format!("http://127.0.0.1:{lying}/")).await.unwrap_err(), DownloadError::TooBig);
    }

    #[tokio::test]
    async fn the_whole_download_has_one_deadline() {
        // A server that sends a byte now and then never trips a per-read timeout; the total one ends it.
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                std::thread::spawn(move || {
                    let mut request = [0u8; 4096];
                    let _ = stream.read(&mut request);
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n");
                    for _ in 0..100 {
                        std::thread::sleep(Duration::from_millis(100));
                        if stream.write_all(b"x").is_err() {
                            return;
                        }
                    }
                });
            }
        });
        let started = Instant::now();
        assert_eq!(get(&format!("http://127.0.0.1:{port}/")).await.unwrap_err(), DownloadError::Timeout);
        assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
    }

    #[tokio::test]
    async fn a_name_of_a_private_address_is_refused_by_the_resolver() {
        // Where a name is checked: the client's own resolver, after the address passed by name.
        // A name that resolves to a private address anywhere needs a hosts entry or a DNS server
        // the tests do not have; `localhost` is the one name every system resolves, and the
        // request is sent past the name check here to show that the resolver refuses it.
        fn nowhere(_: IpAddr) -> bool {
            false
        }
        let limits = DownloadLimits { net: Limits { allow: nowhere, ..TEST.net }, secure: not_plain };
        let (port, hits) = server(|_, _| ok("{}"));
        let error = client(&limits).unwrap().get(format!("http://localhost:{port}/")).send().await.unwrap_err();
        assert_eq!(DownloadError::from(metadata::failure(&error)), DownloadError::Refused);
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_compressed_list_is_counted_as_it_unpacks() {
        use flate2::{write::GzEncoder, Compression};
        let gzip = |size: usize| {
            let mut encoder = GzEncoder::new(Vec::new(), Compression::best());
            encoder.write_all(&vec![b' '; size]).unwrap();
            encoder.finish().unwrap()
        };
        let reply = |body: Vec<u8>| {
            let mut reply = format!("HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
            reply.extend(body);
            reply
        };
        let small = gzip(100);
        let bomb = gzip(TEST.net.max_body * 64);
        assert!(bomb.len() < TEST.net.max_body, "{} bytes on the wire", bomb.len());
        let (port, _) = server(move |_, path| reply(if path == "/bomb" { bomb.clone() } else { small.clone() }));
        assert_eq!(get(&format!("http://127.0.0.1:{port}/small")).await.unwrap().bytes, vec![b' '; 100]);
        assert_eq!(get(&format!("http://127.0.0.1:{port}/bomb")).await.unwrap_err(), DownloadError::TooBig);
    }

    #[tokio::test]
    async fn cancel_stops_a_download_mid_stream_and_frees_its_place() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                std::thread::spawn(move || {
                    let mut request = [0u8; 4096];
                    let _ = stream.read(&mut request);
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n");
                    for _ in 0..100 {
                        std::thread::sleep(Duration::from_millis(50));
                        if stream.write_all(b"x").is_err() {
                            return;
                        }
                    }
                });
            }
        });
        let slot = CancelSlot::take(1_000);
        let notify = slot.0.clone();
        let mut received = 0;
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            cancel_list_download(1_000);
        });
        let started = Instant::now();
        let outcome = fetch_list(&format!("http://127.0.0.1:{port}/"), &TEST, &notify, |n, _| received = n).await;
        assert_eq!(outcome, ListDownload::Cancelled);
        assert!(received > 0, "it was mid-stream");
        assert!(started.elapsed() < Duration::from_millis(900), "{:?}", started.elapsed());
        drop(slot);
        assert!(CANCEL.lock().unwrap().is_none());
        // A slot gives up its place on any way out, but not a newer download's.
        let first = CancelSlot::take(1_001);
        let second = CancelSlot::take(1_002);
        drop(first);
        assert!(CANCEL.lock().unwrap().as_ref().is_some_and(|(_, c)| Arc::ptr_eq(c, &second.0)));
        drop(second);
        assert!(CANCEL.lock().unwrap().is_none());
        // A Cancel that arrives before its download started is kept: the download stops at once,
        // while a later ticket is not touched.
        cancel_list_download(1_003);
        let early = CancelSlot::take(1_003);
        let started = Instant::now();
        let outcome = fetch_list(&format!("http://127.0.0.1:{port}/"), &TEST, &early.0, |_, _| {}).await;
        assert_eq!(outcome, ListDownload::Cancelled);
        assert!(started.elapsed() < Duration::from_millis(200), "{:?}", started.elapsed());
        drop(early);
        let later = CancelSlot::take(1_004);
        assert!(CANCEL.lock().unwrap().as_ref().is_some_and(|(t, _)| *t == 1_004));
        drop(later);
    }

    #[tokio::test]
    async fn statuses_and_endless_redirects_are_reasons() {
        let (port, _) = server(|port, path| match path {
            "/gone" => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
            _ => found(&format!("http://127.0.0.1:{port}/loop")),
        });
        assert_eq!(get(&format!("http://127.0.0.1:{port}/gone")).await.unwrap_err(), DownloadError::Status(404));
        assert_eq!(get(&format!("http://127.0.0.1:{port}/loop")).await.unwrap_err(), DownloadError::TooManyRedirects);
        assert_eq!(get("not an address").await.unwrap_err(), DownloadError::NotHttps);
    }

    #[tokio::test]
    async fn a_file_from_the_system_is_read_only_when_it_is_a_kpin() {
        let dir = std::env::temp_dir().join(format!("kpin-file-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let list = dir.join("Rust blogs.kpin");
        std::fs::write(&list, include_str!("../../tests/fixtures/kpin/valid.kpin")).unwrap();
        match read_list_file(list.to_string_lossy().into()).await {
            ListFile::Read { name, text } => {
                assert_eq!(name, "Rust blogs.kpin");
                assert!(format::parse(&text).is_ok());
            }
            other => panic!("{other:?}"),
        }
        let other = dir.join("notes.txt");
        std::fs::write(&other, "{}").unwrap();
        assert_eq!(read_list_file(other.to_string_lossy().into()).await, ListFile::Unreadable);
        assert_eq!(read_list_file(dir.join("missing.kpin").to_string_lossy().into()).await, ListFile::Unreadable);
        let big = dir.join("big.kpin");
        std::fs::write(&big, vec![b' '; format::MAX_BYTES + 1]).unwrap();
        assert_eq!(read_list_file(big.to_string_lossy().into()).await, ListFile::TooBig);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn outcomes_reach_the_interface_tagged() {
        let json = |d: ListDownload| serde_json::to_value(d).unwrap();
        assert_eq!(json(DownloadError::Status(404).into()), serde_json::json!({ "outcome": "status", "status": 404 }));
        assert_eq!(json(DownloadError::NotHttps.into()), serde_json::json!({ "outcome": "not_https" }));
    }
}
