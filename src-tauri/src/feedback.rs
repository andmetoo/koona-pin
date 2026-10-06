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
/// (`NETAMIPIN_FEEDBACK_URL`); without it sending fails as a service failure.
pub const ENDPOINT: Option<&str> = option_env!("NETAMIPIN_FEEDBACK_URL");
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

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub connect_timeout: Duration,
    pub timeout: Duration,
}

pub const LIMITS: Limits = Limits {
    connect_timeout: Duration::from_secs(5),
    timeout: Duration::from_secs(15),
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
    if email.len() > 254 || email.chars().any(char::is_whitespace) {
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
    let client = reqwest::Client::builder()
        .connect_timeout(limits.connect_timeout)
        .timeout(limits.timeout)
        .no_proxy()
        .user_agent(format!("NetamiPin/{}", payload.app_version))
        .build()
        .map_err(CommandError::internal)?;
    let response = match client.post(endpoint).json(payload).send().await {
        Ok(response) => response,
        // A refused connection or a name that does not resolve: no internet, as people see it.
        Err(error) if error.is_connect() => return Err(failure(ErrorDetail::NoConnection, error)),
        Err(error) => return Err(failure(ErrorDetail::ServiceFailed, error)),
    };
    let status = response.status();
    if status.is_success() {
        return Ok(());
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

fn failure(detail: ErrorDetail, error: reqwest::Error) -> CommandError {
    // Without the URL: the log needs the reason, not the address.
    CommandError::detailed(ErrorCode::Network, detail, error.without_url().to_string())
}

/// The report shown in the dialog and attached as is: the app, the system,
/// the language and capture. No links, titles, tags or notes; paths under the
/// user's folder are shortened and anything like a link is cut out.
pub fn report(status: &CaptureStatus, app_version: &str, os: &str, language: &str, home: Option<&str>) -> String {
    let mut lines = vec![
        format!("Netami Pin {app_version}"),
        os.to_string(),
        format!("Language: {language}"),
        match status.problem {
            Some(problem) => format!("Capture: {} ({})", name(&status.state), name(&problem)),
            None => format!("Capture: {}", name(&status.state)),
        },
    ];
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

/// The user's folder becomes `%USERPROFILE%` (any case), links become `<link>`.
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
                result.push_str("%USERPROFILE%");
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

/// «Windows 11 24H2 (build 26300), x86_64»; elsewhere the OS name and architecture.
pub fn os_name() -> String {
    let arch = std::env::consts::ARCH;
    #[cfg(windows)]
    {
        let read = |value: &str| windows_value(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", value);
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
    #[cfg(not(windows))]
    {
        format!("{}, {arch}", std::env::consts::OS)
    }
}

#[cfg(windows)]
fn windows_value(key: &str, value: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (key, value) = (wide(key), wide(value));
    let mut buffer = [0u16; 64];
    let mut size = std::mem::size_of_val(&buffer) as u32;
    // SAFETY: the buffer and its size are passed together; the call writes at most `size` bytes.
    let status = unsafe {
        RegGetValueW(HKEY_LOCAL_MACHINE, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buffer.as_mut_ptr().cast(), &mut size)
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
            detail: Some(r"Access denied: C:\Users\Anna\AppData\Roaming\Netami Pin\host.json, see https://example.com/help".into()),
            protocol: 2,
        }
    }

    #[test]
    fn the_report_has_no_links_and_no_user_folder() {
        let text = report(&status(), "0.1.0", "Windows 11 24H2 (build 26300), x86_64", "ru", Some(r"C:\Users\Anna"));
        assert_eq!(
            text,
            [
                "Netami Pin 0.1.0",
                "Windows 11 24H2 (build 26300), x86_64",
                "Language: ru",
                "Capture: failing (registration)",
                r"Detail: Access denied: %USERPROFILE%\AppData\Roaming\Netami Pin\host.json, see <link>",
                "Protocol: 2",
                "Chrome: extension 0.5.2, protocol 2, last seen 2026-10-06T09:12:00Z",
            ]
            .join("\n")
        );
        assert_eq!(scrub(r"c:\users\anna\x", Some(r"C:\Users\Anna")), r"%USERPROFILE%\x");
        assert_eq!(scrub("open www.example.com now", None), "open <link> now");
        // Lowercasing that changes the length still masks the folder: İ is two chars in lower case.
        assert_eq!(scrub(r"Denied: C:\Users\İlker\AppData\x", Some(r"C:\Users\İlker")), r"Denied: %USERPROFILE%\AppData\x");
        assert_eq!(scrub(r"Пусть C:\USERS\АННА\x", Some(r"C:\Users\Анна")), r"Пусть %USERPROFILE%\x");
        assert_eq!(scrub(r"C:\Users\Ann\x", Some(r"C:\Users\Anna")), r"C:\Users\Ann\x");
    }

    #[test]
    fn the_os_is_named() {
        let os = os_name();
        assert!(os.ends_with(std::env::consts::ARCH), "{os}");
        #[cfg(windows)]
        assert!(os.starts_with("Windows 1"), "{os}");
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

    const QUICK: Limits = Limits { connect_timeout: Duration::from_secs(2), timeout: Duration::from_secs(2) };

    fn sample() -> Payload {
        let mut f = feedback("Only the first card moves.", None);
        f.report = Some("Netami Pin 0.1.0".into());
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
                "report": "Netami Pin 0.1.0",
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

    #[tokio::test]
    async fn no_listener_is_no_connection_and_silence_is_a_service_failure() {
        let gone = TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
        let error = send(&format!("http://127.0.0.1:{gone}/"), &sample(), QUICK).await.unwrap_err();
        // Windows reports a refused loopback connection late: either way it is not the service's answer.
        assert!(matches!(error.detail, Some(ErrorDetail::NoConnection | ErrorDetail::ServiceFailed)), "{error:?}");
        assert_eq!(error.code, ErrorCode::Network);

        let silent = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let url = format!("http://127.0.0.1:{}/", silent.local_addr().unwrap().port());
        let quick = Limits { connect_timeout: Duration::from_secs(2), timeout: Duration::from_millis(500) };
        let error = send(&url, &sample(), quick).await.unwrap_err();
        assert_eq!(error.detail, Some(ErrorDetail::ServiceFailed));
        assert!(!error.message.contains("127.0.0.1"), "the log has no address: {}", error.message);
        drop(silent);
    }
}
