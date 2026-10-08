//! «Отправить отзыв» (NP-088, Р-9): the report the person sees before sending,
//! and the one request to the Edge Function `feedback` in Supabase. Nothing
//! here runs until the person presses «Отправить»; the interface never talks
//! to the network itself (the CSP allows IPC only).
use crate::browsers::CaptureStatus;
use crate::error::{CommandError, ErrorCode, ErrorDetail};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use ts_rs::TS;

/// The function's address, set for the build that ships
/// (`KOONAPIN_FEEDBACK_URL`); without it sending fails as a service failure.
pub const ENDPOINT: Option<&str> = option_env!("KOONAPIN_FEEDBACK_URL");
// The installer build (`--features public-release`) cannot ship a dialog that never sends.
#[cfg(feature = "public-release")]
const _: () = assert!(ENDPOINT.is_some(), "set KOONAPIN_FEEDBACK_URL for the installer build (supabase/README.md)");
pub const MAX_MESSAGE: usize = 5000;
const MAX_REPORT: usize = 10000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum FeedbackKind {
    Bug,
    Idea,
    Question,
}

/// What the dialog sends. `report` is the text the person saw, only when
/// «Приложить отчёт» is ticked.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct Feedback {
    pub kind: FeedbackKind,
    pub message: String,
    pub email: Option<String>,
    pub report: Option<String>,
    /// The interface's language, `en` or `ru`.
    pub language: String,
}

/// The body of the request; the version and the OS come from the app itself.
#[derive(Debug, Serialize, PartialEq)]
pub struct Payload {
    pub kind: FeedbackKind,
    pub message: String,
    pub email: Option<String>,
    pub report: Option<String>,
    pub app_version: String,
    pub os: String,
    pub language: String,
    pub source: &'static str,
}

/// Which proxy the request takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Proxy {
    /// The Windows proxy settings and the proxy environment variables.
    System,
    /// None: tests reach their local server directly, whatever the machine has set.
    None,
    /// A proxy on 127.0.0.1 at this port: for tests of proxy failures.
    Local(u16),
}

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub connect_timeout: Duration,
    pub timeout: Duration,
    pub proxy: Proxy,
}

pub const LIMITS: Limits = Limits {
    connect_timeout: Duration::from_secs(5),
    timeout: Duration::from_secs(15),
    proxy: Proxy::System,
};

fn invalid(detail: ErrorDetail, message: &str) -> CommandError {
    CommandError::detailed(ErrorCode::InvalidRequest, detail, message)
}

/// The same checks as the function, so the person hears about them at once.
pub fn payload(feedback: Feedback, app_version: &str, os: &str) -> Result<Payload, CommandError> {
    let message = feedback.message.trim().to_string();
    if message.is_empty() {
        return Err(invalid(ErrorDetail::EmptyMessage, "The message is empty"));
    }
    if message.chars().count() > MAX_MESSAGE {
        return Err(invalid(ErrorDetail::MessageTooLong, "The message is longer than 5000 characters"));
    }
    let email = feedback.email.map(|e| e.trim().to_string()).filter(|e| !e.is_empty());
    if email.as_deref().is_some_and(|e| !email_shape(e)) {
        return Err(invalid(ErrorDetail::InvalidEmail, "The email address does not look right"));
    }
    let report = feedback.report.filter(|r| !r.trim().is_empty());
    if report.as_deref().is_some_and(|r| r.chars().count() > MAX_REPORT) {
        return Err(CommandError::invalid("The report is too long"));
    }
    Ok(Payload {
        kind: feedback.kind,
        message,
        email,
        report,
        app_version: app_version.chars().take(40).collect(),
        os: os.chars().take(100).collect(),
        language: feedback.language.chars().take(10).collect(),
        source: "app",
    })
}

/// something@something.tld without spaces — the function's rule.
pub fn email_shape(email: &str) -> bool {
    // Characters, as the dialog, the function and Postgres count them, not UTF-8 bytes.
    if email.chars().count() > 254 || email.chars().any(char::is_whitespace) {
        return false;
    }
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    let Some((name, tld)) = domain.rsplit_once('.') else {
        return false;
    };
    !local.is_empty() && !domain.contains('@') && !name.is_empty() && tld.chars().count() >= 2
}

/// Sends the payload; the error says what the dialog should tell the person.
pub async fn send(endpoint: &str, payload: &Payload, limits: Limits) -> Result<(), CommandError> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(limits.connect_timeout)
        .timeout(limits.timeout)
        .user_agent(format!("KoonaPin/{}", payload.app_version));
    // The system proxy, unlike metadata requests: the address is fixed, there is no
    // name to guard, and some networks reach the internet only through a proxy.
    match limits.proxy {
        Proxy::System => {}
        Proxy::None => builder = builder.no_proxy(),
        Proxy::Local(port) => builder = builder.proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(CommandError::internal)?),
    }
    let client = builder.build().map_err(CommandError::internal)?;
    let response = match client.post(endpoint).json(payload).send().await {
        Ok(response) => response,
        // The proxy refused the tunnel (sign-in required) or could not be reached.
        Err(error) if through_proxy(&error) => return Err(failure(ErrorDetail::ProxyFailed, error)),
        // A refused connection or a name that does not resolve: no internet, as people see it.
        Err(error) if error.is_connect() => {
            let proxy = if limits.proxy == Proxy::System { unusable_proxy() } else { None };
            return Err(failure(connect_detail(proxy), error));
        }
        Err(error) => return Err(failure(ErrorDetail::ServiceFailed, error)),
    };
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    if status.as_u16() == 407 {
        return Err(CommandError::detailed(ErrorCode::Network, ErrorDetail::ProxyFailed, "The proxy asks for a sign-in"));
    }
    if status.as_u16() == 429 {
        return Err(CommandError::detailed(ErrorCode::Network, ErrorDetail::TooManyMessages, "Too many messages in the last hour"));
    }
    if status.as_u16() == 400 {
        let field = response.json::<serde_json::Value>().await.ok().and_then(|v| v["field"].as_str().map(str::to_string));
        match field.as_deref() {
            Some("email") => return Err(invalid(ErrorDetail::InvalidEmail, "The service refused the email address")),
            Some("message") => return Err(invalid(ErrorDetail::MessageTooLong, "The service refused the message")),
            _ => {}
        }
    }
    Err(CommandError::detailed(ErrorCode::Network, ErrorDetail::ServiceFailed, format!("The feedback service answered {status}")))
}

/// A failure of the proxy tunnel: hyper-util names them «tunnel error: …» (407, unreachable proxy).
fn through_proxy(error: &reqwest::Error) -> bool {
    let mut source: Option<&dyn std::error::Error> = Some(error);
    while let Some(e) = source {
        if e.to_string().contains("tunnel error") {
            return true;
        }
        source = e.source();
    }
    false
}

/// What a failed connection is called. With a proxy this client cannot use it may be that
/// proxy — or just no internet: a company laptop keeps the script at home, where Windows
/// connects directly. Both are named rather than blaming the proxy.
fn connect_detail(unusable_proxy: Option<ErrorDetail>) -> ErrorDetail {
    unusable_proxy.unwrap_or(ErrorDetail::NoConnection)
}

/// A proxy the system has and this client cannot use: a setup script (PAC) on Windows; on
/// Linux one set only in the desktop's settings, since reqwest reads the variables
/// (`https_proxy` and the others) and not GNOME's or KDE's settings (NP-097).
fn unusable_proxy() -> Option<ErrorDetail> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;
        windows_value(HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Internet Settings", "AutoConfigURL")
            .map(|_| ErrorDetail::NoConnectionOrProxy)
    }
    #[cfg(target_os = "linux")]
    {
        linux::desktop_proxy().then_some(ErrorDetail::NoConnectionOrSystemProxy)
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        None
    }
}

fn failure(detail: ErrorDetail, error: reqwest::Error) -> CommandError {
    // Without the URL: the log needs the reason, not the address.
    CommandError::detailed(ErrorCode::Network, detail, error.without_url().to_string())
}

/// The report shown in the dialog and attached as is: the app, the system,
/// the language and capture. No links, titles, tags or notes; paths under the
/// user's folder are shortened and anything like a link is cut out.
pub fn report(status: &CaptureStatus, app_version: &str, system: &[String], language: &str, home: Option<&str>) -> String {
    let mut lines = vec![format!("Koona Pin {app_version}")];
    lines.extend(system.iter().map(|line| scrub(line, home)));
    lines.push(format!("Language: {language}"));
    lines.push(match status.problem {
        Some(problem) => format!("Capture: {} ({})", name(&status.state), name(&problem)),
        None => format!("Capture: {}", name(&status.state)),
    });
    if let Some(detail) = &status.detail {
        lines.push(format!("Detail: {}", scrub(detail, home)));
    }
    lines.push(format!("Protocol: {}", status.protocol));
    for browser in &status.browsers {
        lines.push(format!(
            "{}: extension {}, protocol {}, last seen {}",
            browser_name(browser.browser),
            browser.extension_version.as_deref().unwrap_or("?"),
            browser.extension_protocol.map_or("?".to_string(), |p| p.to_string()),
            browser.last_seen,
        ));
    }
    lines.join("\n")
}

fn browser_name(browser: crate::browsers::Browser) -> &'static str {
    match browser {
        crate::browsers::Browser::Chrome => "Chrome",
        crate::browsers::Browser::Edge => "Edge",
        crate::browsers::Browser::Firefox => "Firefox",
    }
}

/// The serde name of a status enum, as the interface's report writes it.
fn name(value: &impl Serialize) -> String {
    serde_json::to_value(value).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

/// What the user's folder becomes in the report: the name people know on each system.
#[cfg(windows)]
pub const HOME_MARK: &str = "%USERPROFILE%";
#[cfg(not(windows))]
pub const HOME_MARK: &str = "~";

/// The user's folder becomes `HOME_MARK` (any case), links become `<link>`.
pub fn scrub(text: &str, home: Option<&str>) -> String {
    let mut out = text.to_string();
    if let Some(home) = home.filter(|h| h.len() > 3) {
        // Compared char by char in lower case: offsets stay those of the original text,
        // whatever lowercasing does to the length (İ becomes two chars).
        let needle: Vec<char> = home.chars().flat_map(char::to_lowercase).collect();
        let mut result = String::with_capacity(out.len());
        let mut at = 0;
        while at < out.len() {
            if let Some(len) = starts_with_folded(&out[at..], &needle) {
                result.push_str(HOME_MARK);
                at += len;
            } else {
                let c = out[at..].chars().next().unwrap_or_default();
                result.push(c);
                at += c.len_utf8();
            }
        }
        out = result;
    }
    out.split(' ')
        .map(|word| {
            let lower = word.to_ascii_lowercase();
            if lower.contains("http://") || lower.contains("https://") || lower.contains("www.") {
                "<link>"
            } else {
                word
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The byte length of the prefix of `text` that lowercases to `needle`, if it does.
fn starts_with_folded(text: &str, needle: &[char]) -> Option<usize> {
    let mut want = needle.iter();
    let mut next = want.next();
    for (i, c) in text.char_indices() {
        for lower in c.to_lowercase() {
            match next {
                Some(&w) if w == lower => next = want.next(),
                _ => return None,
            }
        }
        if next.is_none() {
            return Some(i + c.len_utf8());
        }
    }
    None
}

/// The lines about the system in the report: the OS, and on Linux also the
/// web engine and how the app was installed (NP-097).
pub fn system_lines() -> Vec<String> {
    #[cfg_attr(not(target_os = "linux"), allow(unused_mut))]
    let mut lines = vec![os_name()];
    #[cfg(target_os = "linux")]
    {
        lines.push(linux::webkit());
        if let Ok(program) = std::env::current_exe() {
            lines.push(format!("Installed: {}", linux::installed_with(&program)));
        }
        lines.push(format!("Updates: {}", crate::channel::Channel::current().describe()));
    }
    lines
}

/// `PRETTY_NAME` of an os-release file, or its `NAME` and `VERSION_ID`.
pub fn pretty_name(os_release: &str) -> Option<String> {
    let value = |key: &str| {
        os_release.lines().find_map(|line| {
            let value = line.trim().strip_prefix(key)?.strip_prefix('=')?;
            let value = value.trim();
            let unquoted = value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
                .unwrap_or(value);
            let text = unquoted.replace("\\\"", "\"").replace("\\\\", "\\");
            (!text.is_empty()).then_some(text)
        })
    };
    value("PRETTY_NAME").or_else(|| {
        let name = value("NAME")?;
        Some(match value("VERSION_ID") {
            Some(version) => format!("{name} {version}"),
            None => name,
        })
    })
}

/// «Windows 11 24H2 (build 26300), x86_64»; «Ubuntu 26.04 LTS, GNOME, Wayland,
/// x86_64» on Linux; elsewhere the OS name and architecture.
pub fn os_name() -> String {
    let arch = std::env::consts::ARCH;
    #[cfg(target_os = "linux")]
    {
        let parts: Vec<String> = [
            Some(linux::distribution().unwrap_or_else(|| "Linux".into())),
            linux::desktop(),
            linux::session(),
            Some(arch.to_string()),
        ]
        .into_iter()
        .flatten()
        .collect();
        return parts.join(", ");
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Registry::HKEY_LOCAL_MACHINE;
        let read = |value: &str| windows_value(HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", value);
        if let Some(build) = read("CurrentBuildNumber").or_else(|| read("CurrentBuild")) {
            // ProductName still says «Windows 10» on 11; the build tells them apart.
            let major = if build.parse::<u32>().is_ok_and(|b| b >= 22000) { "11" } else { "10" };
            return match read("DisplayVersion") {
                Some(release) => format!("Windows {major} {release} (build {build}), {arch}"),
                None => format!("Windows {major} (build {build}), {arch}"),
            };
        }
        format!("Windows, {arch}")
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        format!("{}, {arch}", std::env::consts::OS)
    }
}

/// What the report and a failed send need to know about a Linux desktop (NP-097).
#[cfg(target_os = "linux")]
mod linux {
    use std::path::Path;

    /// The distribution as `/etc/os-release` names it.
    pub fn distribution() -> Option<String> {
        ["/etc/os-release", "/usr/lib/os-release"]
            .iter()
            .find_map(|path| std::fs::read_to_string(path).ok())
            .and_then(|text| super::pretty_name(&text))
    }

    /// `GNOME`, `KDE`, `Hyprland`; `ubuntu:GNOME` is written `ubuntu/GNOME`.
    pub fn desktop() -> Option<String> {
        std::env::var("XDG_CURRENT_DESKTOP")
            .ok()
            .map(|desktop| desktop.replace(':', "/"))
            .filter(|desktop| !desktop.is_empty())
    }

    pub fn session() -> Option<String> {
        let session = std::env::var("XDG_SESSION_TYPE").ok()?;
        Some(match session.as_str() {
            "wayland" => "Wayland".into(),
            "x11" => "X11".into(),
            "" => return None,
            other => other.into(),
        })
    }

    extern "C" {
        // libwebkit2gtk-4.1, which the window already links (wry).
        fn webkit_get_major_version() -> std::os::raw::c_uint;
        fn webkit_get_minor_version() -> std::os::raw::c_uint;
        fn webkit_get_micro_version() -> std::os::raw::c_uint;
    }

    /// The WebKitGTK the interface runs in: drawing bugs depend on it.
    pub fn webkit() -> String {
        // SAFETY: plain getters of the library's version, no arguments.
        let (major, minor, micro) =
            unsafe { (webkit_get_major_version(), webkit_get_minor_version(), webkit_get_micro_version()) };
        format!("WebKitGTK {major}.{minor}.{micro}")
    }

    /// The package that owns the program: dpkg's file lists, pacman's local
    /// database (the AUR package), then `rpm -qf`.
    pub fn installed_with(program: &Path) -> String {
        let target = program.to_string_lossy();
        let owned = |folder: &str, list: &str, line: &str| {
            std::fs::read_dir(folder).ok()?.flatten().find_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                // dpkg keeps one `<package>.list` among the package's other files.
                if !name.contains("koona") || (list.is_empty() && !name.ends_with(".list")) {
                    return None;
                }
                let path = if list.is_empty() { entry.path() } else { entry.path().join(list) };
                let text = std::fs::read_to_string(path).ok()?;
                text.lines().any(|l| l == line).then_some(name)
            })
        };
        if let Some(name) = owned("/var/lib/dpkg/info", "", &target) {
            return format!("deb ({})", name.trim_end_matches(".list"));
        }
        if let Some(name) = owned("/var/lib/pacman/local", "files", target.trim_start_matches('/')) {
            return format!("AUR ({name})");
        }
        if let Ok(output) = std::process::Command::new("rpm")
            .args(["-qf", "--queryformat", "%{NAME}"])
            .arg(program)
            .output()
        {
            if output.status.success() {
                return format!("rpm ({})", String::from_utf8_lossy(&output.stdout).trim());
            }
        }
        "not from a package".into()
    }

    /// A proxy set in GNOME's or KDE's settings while the variables reqwest
    /// reads are empty: the request then goes without it.
    pub fn desktop_proxy() -> bool {
        let variables = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"];
        if variables.iter().any(|name| std::env::var(name).is_ok_and(|value| !value.is_empty())) {
            return false;
        }
        gnome_proxy() || kde_proxy()
    }

    /// `org.gnome.system.proxy mode`, when the schema is installed (reading a
    /// missing schema would abort the process).
    fn gnome_proxy() -> bool {
        use gtk::gio::prelude::SettingsExt;
        const SCHEMA: &str = "org.gnome.system.proxy";
        let Some(schemas) = gtk::gio::SettingsSchemaSource::default() else {
            return false;
        };
        if schemas.lookup(SCHEMA, true).is_none() {
            return false;
        }
        gtk::gio::Settings::new(SCHEMA).string("mode") != "none"
    }

    fn kde_proxy() -> bool {
        dirs::config_dir()
            .and_then(|config| std::fs::read_to_string(config.join("kioslaverc")).ok())
            .and_then(|text| super::kde_proxy_type(&text))
            .is_some_and(|kind| (1..=3).contains(&kind))
    }
}

/// `ProxyType` of KDE's `kioslaverc`: 1 manual, 2 a setup script, 3 found on
/// the network, 4 the variables; 0 or none — no proxy.
pub fn kde_proxy_type(kioslaverc: &str) -> Option<u32> {
    let mut in_section = false;
    for line in kioslaverc.lines().map(str::trim) {
        if line.starts_with('[') {
            in_section = line == "[Proxy Settings]";
        } else if in_section {
            if let Some(value) = line.strip_prefix("ProxyType=") {
                return value.trim().parse().ok();
            }
        }
    }
    None
}

#[cfg(windows)]
fn windows_value(hive: windows_sys::Win32::System::Registry::HKEY, key: &str, value: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, RRF_RT_REG_SZ};
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (key, value) = (wide(key), wide(value));
    // Room for a setup script address (AutoConfigURL) as well as a version string.
    let mut buffer = [0u16; 1024];
    let mut size = std::mem::size_of_val(&buffer) as u32;
    // SAFETY: the buffer and its size are passed together; the call writes at most `size` bytes.
    let status = unsafe {
        RegGetValueW(hive, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buffer.as_mut_ptr().cast(), &mut size)
    };
    (status == 0).then(|| {
        char::decode_utf16(buffer.iter().copied().take_while(|&c| c != 0))
            .filter_map(Result::ok)
            .collect::<String>()
            .trim()
            .to_string()
    })
    .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browsers::{Browser, BrowserStatus, CaptureProblem, CaptureState};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    fn feedback(message: &str, email: Option<&str>) -> Feedback {
        Feedback {
            kind: FeedbackKind::Bug,
            message: message.into(),
            email: email.map(str::to_string),
            report: None,
            language: "en".into(),
        }
    }

    #[test]
    fn the_payload_is_checked_and_trimmed() {
        let ok = payload(feedback("  Only the first card moves. ", Some(" anna@example.com ")), "0.1.0", "Windows 11").unwrap();
        assert_eq!(ok.message, "Only the first card moves.");
        assert_eq!(ok.email.as_deref(), Some("anna@example.com"));
        assert_eq!(ok.source, "app");
        assert_eq!(payload(feedback("x", Some("  ")), "0.1.0", "w").unwrap().email, None);
        let detail = |f: Feedback| payload(f, "0.1.0", "w").unwrap_err().detail;
        assert_eq!(detail(feedback("   ", None)), Some(ErrorDetail::EmptyMessage));
        assert_eq!(detail(feedback(&"я".repeat(5001), None)), Some(ErrorDetail::MessageTooLong));
        assert!(payload(feedback(&"я".repeat(5000), None), "0.1.0", "w").is_ok());
        assert_eq!(detail(feedback("x", Some("anna@example"))), Some(ErrorDetail::InvalidEmail));
        let json = serde_json::to_value(&ok).unwrap();
        assert_eq!(json["kind"], "bug");
        assert_eq!(json["report"], serde_json::Value::Null);
    }

    #[test]
    fn email_shape_follows_the_function() {
        for good in ["a@b.co", "anna.k+pin@mail.example.org", "имя@почта.рф"] {
            assert!(email_shape(good), "{good}");
        }
        // 250 characters of Cyrillic are 500 bytes and still fit the limit of 254 characters.
        assert!(email_shape(&format!("{}@почта.рф", "я".repeat(240))));
        assert!(!email_shape(&format!("{}@почта.рф", "я".repeat(250))));
        for bad in ["anna@example", "anna@.com", "@example.com", "anna example@x.com", "a@b@c.com", "a@b.c", "plain"] {
            assert!(!email_shape(bad), "{bad}");
        }
    }

    fn status() -> CaptureStatus {
        CaptureStatus {
            state: CaptureState::Failing,
            browsers: vec![BrowserStatus {
                browser: Browser::Chrome,
                last_seen: "2026-10-06T09:12:00Z".into(),
                extension_version: Some("0.5.2".into()),
                extension_protocol: Some(2),
                compatible: true,
                recent: true,
            }],
            last_capture: None,
            days_silent: None,
            problem: Some(CaptureProblem::Registration),
            detail: Some(r"Access denied: C:\Users\Anna\AppData\Roaming\Koona Pin\host.json, see https://example.com/help".into()),
            protocol: 2,
            system: crate::browsers::System::Windows,
        }
    }

    #[test]
    fn the_report_has_no_links_and_no_user_folder() {
        let system = ["Windows 11 24H2 (build 26300), x86_64".to_string()];
        let text = report(&status(), "0.1.0", &system, "ru", Some(r"C:\Users\Anna"));
        assert_eq!(
            text,
            [
                "Koona Pin 0.1.0".to_string(),
                "Windows 11 24H2 (build 26300), x86_64".into(),
                "Language: ru".into(),
                "Capture: failing (registration)".into(),
                format!(r"Detail: Access denied: {HOME_MARK}\AppData\Roaming\Koona Pin\host.json, see <link>"),
                "Protocol: 2".into(),
                "Chrome: extension 0.5.2, protocol 2, last seen 2026-10-06T09:12:00Z".into(),
            ]
            .join("\n")
        );
        assert_eq!(scrub(r"c:\users\anna\x", Some(r"C:\Users\Anna")), format!(r"{HOME_MARK}\x"));
        assert_eq!(scrub("open www.example.com now", None), "open <link> now");
        // Lowercasing that changes the length still masks the folder: İ is two chars in lower case.
        assert_eq!(scrub(r"Denied: C:\Users\İlker\AppData\x", Some(r"C:\Users\İlker")), format!(r"Denied: {HOME_MARK}\AppData\x"));
        assert_eq!(scrub(r"Пусть C:\USERS\АННА\x", Some(r"C:\Users\Анна")), format!(r"Пусть {HOME_MARK}\x"));
        assert_eq!(scrub(r"C:\Users\Ann\x", Some(r"C:\Users\Anna")), r"C:\Users\Ann\x");
        // Linux (NP-097): the home folder in a system line or a detail, the program path too.
        let system = ["Ubuntu 26.04 LTS, GNOME, Wayland, x86_64".to_string(), "Installed: not from a package".into()];
        let text = report(&status(), "0.1.0", &system, "en", Some("/home/anna"));
        assert!(text.starts_with("Koona Pin 0.1.0\nUbuntu 26.04 LTS, GNOME, Wayland, x86_64\nInstalled: not from a package\nLanguage: en\n"), "{text}");
        assert_eq!(scrub("Permission denied: /home/anna/.config/x", Some("/home/anna")), format!("Permission denied: {HOME_MARK}/.config/x"));
    }

    #[test]
    fn the_os_is_named() {
        let os = os_name();
        assert!(os.ends_with(std::env::consts::ARCH), "{os}");
        #[cfg(windows)]
        assert!(os.starts_with("Windows 1"), "{os}");
        let lines = system_lines();
        assert_eq!(lines[0], os);
        // Linux: the web engine and the package as well.
        #[cfg(target_os = "linux")]
        {
            assert!(lines[1].starts_with("WebKitGTK 2."), "{lines:?}");
            assert!(lines[2].starts_with("Installed: "), "{lines:?}");
        }
    }

    #[test]
    fn the_distribution_is_read_from_os_release() {
        let ubuntu = "PRETTY_NAME=\"Ubuntu 26.04 LTS\"\nNAME=\"Ubuntu\"\nVERSION_ID=\"26.04\"\n";
        assert_eq!(pretty_name(ubuntu).as_deref(), Some("Ubuntu 26.04 LTS"));
        assert_eq!(pretty_name("NAME=Fedora Linux\nVERSION_ID=44\n").as_deref(), Some("Fedora Linux 44"));
        assert_eq!(pretty_name("NAME='Arch Linux'\nPRETTY_NAME=''\n").as_deref(), Some("Arch Linux"));
        assert_eq!(pretty_name("PRETTY_NAME=\"Say \\\"hi\\\"\"\n").as_deref(), Some("Say \"hi\""));
        assert_eq!(pretty_name("ID=debian\n"), None);
    }

    #[test]
    fn a_kde_proxy_is_read_from_kioslaverc() {
        let rc = "[Cache]\nProxyType=9\n\n[Proxy Settings]\nNoProxyFor=\nProxyType=1\nhttpProxy=http://proxy 3128\n";
        assert_eq!(kde_proxy_type(rc), Some(1));
        assert_eq!(kde_proxy_type("[Proxy Settings]\nProxyType=0\n"), Some(0));
        assert_eq!(kde_proxy_type("[Cache]\nProxyType=2\n"), None);
    }

    /// Answers one request with `reply` and hands over what it received.
    fn server(reply: &'static str) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let url = format!("http://127.0.0.1:{}/functions/v1/feedback", listener.local_addr().unwrap().port());
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else { return };
            let mut received = Vec::new();
            let mut chunk = [0u8; 4096];
            // Headers, then the body by Content-Length.
            loop {
                let n = stream.read(&mut chunk).unwrap_or(0);
                if n == 0 {
                    break;
                }
                received.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&received).to_string();
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text[..end]
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                        .unwrap_or(0);
                    if received.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let _ = stream.write_all(reply.as_bytes());
            let _ = tx.send(String::from_utf8_lossy(&received).to_string());
        });
        (url, rx)
    }

    // No proxy: the local server is reached directly even where HTTP(S)_PROXY or the Windows proxy is set.
    const QUICK: Limits = Limits { connect_timeout: Duration::from_secs(2), timeout: Duration::from_secs(2), proxy: Proxy::None };

    fn sample() -> Payload {
        let mut f = feedback("Only the first card moves.", None);
        f.report = Some("Koona Pin 0.1.0".into());
        payload(f, "0.1.0", "Windows 11 24H2 (build 26300), x86_64").unwrap()
    }

    #[tokio::test]
    async fn the_request_is_one_json_post_with_version_os_and_language() {
        let (url, received) = server("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}");
        send(&url, &sample(), QUICK).await.unwrap();
        let request = received.recv().unwrap();
        assert!(request.starts_with("POST /functions/v1/feedback HTTP/1.1"), "{request}");
        assert!(request.to_ascii_lowercase().contains("content-type: application/json"));
        assert!(!request.to_ascii_lowercase().contains("authorization"), "no key is sent");
        let body: serde_json::Value = serde_json::from_str(&request[request.find("\r\n\r\n").unwrap() + 4..]).unwrap();
        assert_eq!(
            body,
            serde_json::json!({
                "kind": "bug",
                "message": "Only the first card moves.",
                "email": null,
                "report": "Koona Pin 0.1.0",
                "app_version": "0.1.0",
                "os": "Windows 11 24H2 (build 26300), x86_64",
                "language": "en",
                "source": "app",
            })
        );
    }

    #[tokio::test]
    async fn answers_of_the_service_become_details() {
        let cases = [
            ("HTTP/1.1 429 Too Many Requests\r\nContent-Length: 24\r\nConnection: close\r\n\r\n{\"error\":\"rate_limited\"}", ErrorDetail::TooManyMessages),
            ("HTTP/1.1 400 Bad Request\r\nContent-Length: 35\r\nConnection: close\r\n\r\n{\"error\":\"invalid\",\"field\":\"email\"}", ErrorDetail::InvalidEmail),
            ("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 18\r\nConnection: close\r\n\r\n{\"error\":\"server\"}", ErrorDetail::ServiceFailed),
            ("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", ErrorDetail::ServiceFailed),
        ];
        for (reply, expected) in cases {
            let (url, _received) = server(reply);
            let error = send(&url, &sample(), QUICK).await.unwrap_err();
            assert_eq!(error.detail, Some(expected), "{reply}");
        }
    }

    #[test]
    fn a_failed_connection_with_a_setup_script_names_both_causes() {
        assert_eq!(connect_detail(None), ErrorDetail::NoConnection);
        assert_eq!(connect_detail(Some(ErrorDetail::NoConnectionOrProxy)), ErrorDetail::NoConnectionOrProxy);
        assert_eq!(connect_detail(Some(ErrorDetail::NoConnectionOrSystemProxy)), ErrorDetail::NoConnectionOrSystemProxy);
    }

    #[tokio::test]
    async fn a_proxy_that_asks_for_a_sign_in_is_named_as_the_proxy() {
        let refused = "HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        // Answered directly with 407 (an HTTP endpoint behind a transparent proxy).
        let (url, _received) = server(refused);
        assert_eq!(send(&url, &sample(), QUICK).await.unwrap_err().detail, Some(ErrorDetail::ProxyFailed));
        // A CONNECT tunnel to the HTTPS service refused with 407 by the configured proxy.
        let (proxy, _received) = server(refused);
        let port = url::Url::parse(&proxy).unwrap().port().unwrap();
        let via = Limits { proxy: Proxy::Local(port), ..QUICK };
        let error = send("https://feedback.example/functions/v1/feedback", &sample(), via).await.unwrap_err();
        assert_eq!(error.detail, Some(ErrorDetail::ProxyFailed), "{error:?}");
        assert_eq!(error.code, ErrorCode::Network);
    }

    #[tokio::test]
    async fn no_listener_is_no_connection_and_silence_is_a_service_failure() {
        let gone = TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
        let error = send(&format!("http://127.0.0.1:{gone}/"), &sample(), QUICK).await.unwrap_err();
        // Windows reports a refused loopback connection late: either way it is not the service's answer.
        assert!(matches!(error.detail, Some(ErrorDetail::NoConnection | ErrorDetail::ServiceFailed)), "{error:?}");
        assert_eq!(error.code, ErrorCode::Network);

        let silent = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let url = format!("http://127.0.0.1:{}/", silent.local_addr().unwrap().port());
        let quick = Limits { timeout: Duration::from_millis(500), ..QUICK };
        let error = send(&url, &sample(), quick).await.unwrap_err();
        assert_eq!(error.detail, Some(ErrorDetail::ServiceFailed));
        assert!(!error.message.contains("127.0.0.1"), "the log has no address: {}", error.message);
        drop(silent);
    }
}
