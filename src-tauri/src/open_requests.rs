//! Lists opened from outside the window (NP-139, NP-142): a `.kpin` file given
//! to the app by a double-click or Open With, and a `koonapin://import?url=…`
//! link from a page. They arrive as arguments of the first start, as arguments
//! of a second start (the single-instance callback) or, on macOS, as
//! `RunEvent::Opened`; every one goes through [`parse`] into one buffer.
//!
//! Nothing is read or downloaded here: the interface takes the request with
//! `take_pending_opens` and asks the person first. A page can fire the link at
//! any time, so only one request waits; later ones are dropped until the
//! interface has taken it.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use ts_rs::TS;
use url::Url;

/// The event that tells the interface a request is waiting; it then calls
/// `take_pending_opens`. The payload is empty: the buffer is the one source.
pub const OPEN_REQUEST_EVENT: &str = "open-request";

/// The link's scheme, registered for macOS and Windows by the deep-link plugin
/// and on Linux by `koonapin.desktop`.
pub const SCHEME: &str = "koonapin";

/// Longer arguments are not a link anyone would publish.
const MAX_LINK: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "kebab-case")]
#[ts(export)]
pub enum OpenRequest {
    /// An existing `.kpin` file, by its absolute path.
    KpinPath { path: String },
    /// The `https` address of a list from `koonapin://import?url=…`.
    KpinUrl { url: String },
}

/// The one request waiting for the interface, and whether the interface has
/// a list dialog open (or a list waiting for it), as it says with `set_list_open`.
#[derive(Default)]
pub struct PendingOpens(Mutex<Option<OpenRequest>>, AtomicBool);

impl PendingOpens {
    /// Keeps the request unless one already waits; `true` when kept.
    pub fn offer(&self, request: OpenRequest) -> bool {
        let mut pending = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if pending.is_some() {
            return false;
        }
        *pending = Some(request);
        true
    }

    pub fn take(&self) -> Option<OpenRequest> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    /// The interface has a list of its own: a new one is refused there.
    pub fn list_open(&self) -> bool {
        self.1.load(Ordering::Relaxed)
    }

    /// Offers the request for the interface; `true` only when it gets a dialog of its own, so
    /// the window comes forward for it. One the interface refuses is still handed over, for the
    /// interface to say so.
    pub fn hand_over(&self, request: OpenRequest) -> bool {
        let open = self.list_open();
        self.offer(request) && !open
    }
}

/// One argument or opened URL as a request, or `None` for anything else.
/// `cwd` resolves a relative path given on a command line.
pub fn parse(arg: &str, cwd: &Path) -> Option<OpenRequest> {
    let arg = arg.trim();
    // An option of the app (`--autostart`, `--activation-token=…`) or of WebView2 is never a file
    // or a link, whatever follows.
    if arg.is_empty() || arg.starts_with('-') || arg.len() > MAX_LINK {
        return None;
    }
    if starts_with_ignore_case(arg, &format!("{SCHEME}:")) {
        return import_link(arg).map(|url| OpenRequest::KpinUrl { url });
    }
    // Linux file managers pass `%U` as `file://` addresses, macOS opens files that way.
    let path = if starts_with_ignore_case(arg, "file:") {
        let url = Url::parse(arg).ok()?;
        // An encoded slash or NUL would be decoded into the path and name another file than the
        // address shows. `to_file_path` refuses a host other than `localhost` on Unix.
        let path = url.path().to_ascii_lowercase();
        if path.contains("%2f") || path.contains("%5c") || path.contains("%00") {
            return None;
        }
        url.to_file_path().ok()?
    } else if arg.contains("://") {
        return None;
    } else {
        cwd.join(arg)
    };
    kpin_file(&path).map(|path| OpenRequest::KpinPath { path })
}

/// The first acceptable request among command-line arguments; the program itself is skipped.
pub fn from_args<I, S>(args: I, cwd: &Path) -> Option<OpenRequest>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().skip(1).find_map(|arg| parse(arg.as_ref(), cwd))
}

fn starts_with_ignore_case(text: &str, prefix: &str) -> bool {
    text.len() >= prefix.len() && text.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

/// `koonapin://import?url=https://…`: the list's address, which must be https with a host and no
/// user name or password. A trailing slash after `import` is forgiven (some launchers add one);
/// anything else, or more than one `url`, is refused.
fn import_link(arg: &str) -> Option<String> {
    let link = Url::parse(arg).ok()?;
    if link.scheme() != SCHEME || !link.host_str()?.eq_ignore_ascii_case("import") {
        return None;
    }
    if !matches!(link.path(), "" | "/") || link.fragment().is_some() {
        return None;
    }
    let mut values = link.query_pairs().filter(|(key, _)| key == "url").map(|(_, value)| value.into_owned());
    let (Some(value), None) = (values.next(), values.next()) else {
        return None;
    };
    let target = Url::parse(value.trim()).ok()?;
    let fine = target.scheme() == "https"
        && target.host_str().is_some_and(|host| !host.is_empty())
        && target.username().is_empty()
        && target.password().is_none();
    fine.then(|| target.to_string())
}

fn is_kpin(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("kpin"))
}

/// An existing regular file whose name ends in `.kpin`, as an absolute path. A link is followed
/// and its target checked the same way: a `.kpin` link to another file is refused.
pub(crate) fn kpin_file(path: &Path) -> Option<String> {
    if !is_kpin(path) {
        return None;
    }
    let path: PathBuf = std::fs::canonicalize(path).ok()?;
    if !is_kpin(&path) || !std::fs::metadata(&path).ok()?.is_file() {
        return None;
    }
    path.to_str().map(str::to_owned)
}

/// Keeps the request unless one waits, and tells the interface either way: taking from an empty
/// buffer is harmless, and a request kept while no one listened is not stranded. An interface that
/// is not loaded yet takes it with `take_pending_opens` when it starts. `true` when kept for a
/// dialog of its own: one that the interface will refuse, because its list dialog is open, is
/// handed over (the interface says it is refused) but is `false`, so the window is not brought
/// forward for it.
pub fn keep(app: &AppHandle, request: OpenRequest) -> bool {
    let Some(pending) = app.try_state::<PendingOpens>() else {
        return false;
    };
    let kept = pending.hand_over(request);
    let _ = app.emit(OPEN_REQUEST_EVENT, ());
    kept
}

/// The arguments of a second start: `Some(kept)` when they named a file or a link.
pub fn keep_args(app: &AppHandle, args: &[String], cwd: &Path) -> Option<bool> {
    from_args(args, cwd).map(|request| keep(app, request))
}

/// The interface tells whether its list dialog is open or a list waits for it (NP-138).
#[tauri::command]
pub fn set_list_open(pending: tauri::State<'_, PendingOpens>, open: bool) {
    pending.1.store(open, Ordering::Relaxed);
}

/// The request waiting since the start or the last event, if any; taking it frees the buffer.
#[tauri::command]
pub fn take_pending_opens(pending: tauri::State<'_, PendingOpens>) -> Option<OpenRequest> {
    pending.take()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("koonapin-open-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn url(arg: &str) -> Option<String> {
        match parse(arg, Path::new("/")) {
            Some(OpenRequest::KpinUrl { url }) => Some(url),
            Some(other) => panic!("not a link: {other:?}"),
            None => None,
        }
    }

    #[test]
    fn accepts_an_import_link_with_an_https_list() {
        assert_eq!(
            url("koonapin://import?url=https://example.org/x.kpin").as_deref(),
            Some("https://example.org/x.kpin")
        );
        // Encoded, as a page writes it, with the scheme in capitals and a launcher's slash.
        assert_eq!(
            url("KoonaPin://import/?url=https%3A%2F%2Fkoona.app%2Fpin%2Flists%2Frust.kpin%3Fv%3D2").as_deref(),
            Some("https://koona.app/pin/lists/rust.kpin?v=2")
        );
    }

    #[test]
    fn refuses_other_links() {
        for arg in [
            "koonapin://import?url=http://example.org/x.kpin",
            "koonapin://import?url=file:///etc/passwd",
            "koonapin://import?url=javascript:alert(1)",
            "koonapin://import?url=https://user:secret@example.org/x.kpin",
            "koonapin://import?url=https://",
            "koonapin://import?url=not a url",
            "koonapin://import",
            "koonapin://import?list=https://example.org/x.kpin",
            "koonapin://import?url=https://a.example/x.kpin&url=https://b.example/y.kpin",
            "koonapin://export?url=https://example.org/x.kpin",
            "koonapin://import/more?url=https://example.org/x.kpin",
            "koonapin://import?url=https://example.org/x.kpin#frag",
            "koonapin:import?url=https://example.org/x.kpin",
            "https://example.org/x.kpin",
            "--autostart",
            "--activation-token=abc",
            "",
        ] {
            assert_eq!(parse(arg, Path::new("/")), None, "{arg}");
        }
        let long = format!("koonapin://import?url=https://example.org/{}", "a".repeat(MAX_LINK));
        assert_eq!(parse(&long, Path::new("/")), None);
    }

    #[test]
    fn accepts_an_existing_kpin_file_by_path_relative_path_or_file_url() {
        let dir = temp_dir();
        let file = dir.join("Rust blogs.KPIN");
        std::fs::write(&file, "{}").unwrap();
        let expected = OpenRequest::KpinPath {
            path: std::fs::canonicalize(&file).unwrap().to_str().unwrap().to_owned(),
        };
        assert_eq!(parse(file.to_str().unwrap(), Path::new("/")), Some(expected.clone()));
        assert_eq!(parse("Rust blogs.KPIN", &dir), Some(expected.clone()));
        let file_url = Url::from_file_path(&file).unwrap().to_string();
        assert!(file_url.contains("%20"), "{file_url}");
        assert_eq!(parse(&file_url, Path::new("/")), Some(expected));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_missing_files_other_extensions_folders_and_options() {
        let dir = temp_dir();
        std::fs::write(dir.join("list.json"), "{}").unwrap();
        std::fs::create_dir(dir.join("folder.kpin")).unwrap();
        std::fs::write(dir.join("-x.kpin"), "{}").unwrap();
        for arg in ["missing.kpin", "list.json", "folder.kpin", "-x.kpin", "ftp://host/list.kpin"] {
            assert_eq!(parse(arg, &dir), None, "{arg}");
        }
        // The same file by its full path is fine: only an argument that starts with `-` is refused.
        assert!(parse(dir.join("-x.kpin").to_str().unwrap(), Path::new("/")).is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn follows_a_link_only_to_a_kpin_file() {
        let dir = temp_dir();
        std::fs::write(dir.join("secret.txt"), "x").unwrap();
        std::fs::write(dir.join("real.kpin"), "{}").unwrap();
        std::os::unix::fs::symlink(dir.join("secret.txt"), dir.join("bait.kpin")).unwrap();
        std::os::unix::fs::symlink(dir.join("real.kpin"), dir.join("alias.kpin")).unwrap();
        std::os::unix::fs::symlink(dir.join("real.kpin"), dir.join("alias.txt")).unwrap();
        assert_eq!(parse("bait.kpin", &dir), None);
        assert_eq!(parse("alias.txt", &dir), None);
        let real = std::fs::canonicalize(dir.join("real.kpin")).unwrap();
        assert_eq!(
            parse("alias.kpin", &dir),
            Some(OpenRequest::KpinPath { path: real.to_str().unwrap().to_owned() })
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn refuses_file_addresses_with_a_host_or_an_encoded_slash() {
        let dir = temp_dir();
        std::fs::create_dir(dir.join("a")).unwrap();
        std::fs::write(dir.join("a").join("b.kpin"), "{}").unwrap();
        let folder = Url::from_directory_path(std::fs::canonicalize(&dir).unwrap()).unwrap();
        // The plain address works; the same file behind %2F, %2f or a host does not.
        assert!(parse(folder.join("a/b.kpin").unwrap().as_str(), Path::new("/")).is_some());
        for encoded in ["a%2Fb.kpin", "a%2fb.kpin"] {
            let arg = format!("{folder}{encoded}");
            assert_eq!(parse(&arg, Path::new("/")), None, "{arg}");
        }
        let with_host = folder.join("a/b.kpin").unwrap().as_str().replacen("file://", "file://example.org", 1);
        assert_eq!(parse(&with_host, Path::new("/")), None, "{with_host}");
        assert_eq!(parse("file://example.org/tmp/x.kpin", Path::new("/")), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn takes_the_first_acceptable_argument_after_the_program() {
        let args = [
            "koonapin://import?url=https://skipped.example/program-name.kpin",
            "--autostart",
            "koonapin://import?url=http://insecure.example/x.kpin",
            "koonapin://import?url=https://example.org/x.kpin",
            "koonapin://import?url=https://example.org/later.kpin",
        ];
        assert_eq!(
            from_args(args, Path::new("/")),
            Some(OpenRequest::KpinUrl { url: "https://example.org/x.kpin".into() })
        );
        assert_eq!(from_args(["koonapin", "--autostart"], Path::new("/")), None);
    }

    #[test]
    fn keeps_one_request_until_it_is_taken() {
        let pending = PendingOpens::default();
        let first = OpenRequest::KpinUrl { url: "https://example.org/a.kpin".into() };
        let second = OpenRequest::KpinUrl { url: "https://example.org/b.kpin".into() };
        assert!(pending.offer(first.clone()));
        assert!(!pending.offer(second.clone()));
        assert_eq!(pending.take(), Some(first));
        assert_eq!(pending.take(), None);
        assert!(pending.offer(second.clone()));
        assert_eq!(pending.take(), Some(second));
    }

    #[test]
    fn a_request_while_a_list_dialog_is_open_is_handed_over_but_brings_nothing_forward() {
        let pending = PendingOpens::default();
        let first = OpenRequest::KpinUrl { url: "https://example.org/a.kpin".into() };
        let second = OpenRequest::KpinUrl { url: "https://example.org/b.kpin".into() };
        assert!(pending.hand_over(first.clone()));
        assert_eq!(pending.take(), Some(first));
        pending.1.store(true, Ordering::Relaxed);
        assert!(!pending.hand_over(second.clone()), "the window stays where it is");
        assert_eq!(pending.take(), Some(second.clone()), "the interface still hears of it, to refuse it aloud");
        pending.1.store(false, Ordering::Relaxed);
        assert!(pending.hand_over(second));
    }
}
