//! Which browsers talk to the app and what the interface says about it
//! (NP-016, redesign «Статус браузера»).
//!
//! A browser counts as connected while its extension wrote within the last
//! three days: the extension says `hello` when the browser starts and every
//! 12 hours, and each capture counts too. Records live in `app_settings`.

use crate::db::{self, Source};
use chrono::{DateTime, Utc};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

/// No message from any extension for this long: «Нет связи N дней».
pub const LOST_AFTER_DAYS: i64 = 3;
/// The native messaging protocol of this app; an extension with another one
/// has to be updated (or the app, if the extension is newer).
pub const PROTOCOL: u32 = 2;
const SETTING: &str = "capture_connections";

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS,
)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Browser {
    Chrome,
    Edge,
    Firefox,
}

impl Browser {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "chrome" => Some(Browser::Chrome),
            "edge" => Some(Browser::Edge),
            "firefox" => Some(Browser::Firefox),
            _ => None,
        }
    }

    pub fn source(self) -> Source {
        match self {
            Browser::Chrome => Source::Chrome,
            Browser::Edge => Source::Edge,
            Browser::Firefox => Source::Firefox,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Contact {
    pub last_seen: String,
    pub extension_version: Option<String>,
    pub protocol: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LastCapture {
    pub at: String,
    pub browser: Browser,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Connections {
    #[serde(default)]
    browsers: BTreeMap<Browser, Contact>,
    #[serde(default)]
    last_capture: Option<LastCapture>,
}

impl Connections {
    /// A broken or missing record starts over: it is a convenience, not data.
    pub fn load(conn: &Connection) -> Self {
        db::setting(conn, SETTING)
            .ok()
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, conn: &Connection) -> rusqlite::Result<()> {
        let value = serde_json::to_string(self).expect("serializable");
        db::set_setting(conn, SETTING, &value)
    }

    pub fn contact(
        &mut self,
        browser: Browser,
        extension_version: Option<String>,
        protocol: Option<u32>,
        now: &str,
    ) {
        self.browsers.insert(
            browser,
            Contact {
                last_seen: now.into(),
                extension_version,
                protocol,
            },
        );
    }

    pub fn captured(&mut self, browser: Browser, now: &str) {
        self.last_capture = Some(LastCapture {
            at: now.into(),
            browser,
        });
    }
}

/// Why capture cannot work at all, whatever the browsers do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CaptureProblem {
    /// The capture pipe did not open (another program holds its name).
    Channel,
    /// The browsers could not be told where the host is (registry, manifests).
    Registration,
    /// koonapin-host.exe is not next to the app: a broken installation.
    HostMissing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum CaptureState {
    /// At least one browser wrote within three days.
    Connected,
    /// Browsers were connected, but none wrote for three days.
    Lost,
    /// A browser wrote recently with another protocol version.
    Incompatible,
    /// Capture cannot work: see `problem`.
    Failing,
    /// No browser has ever written.
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct BrowserStatus {
    pub browser: Browser,
    pub last_seen: String,
    pub extension_version: Option<String>,
    /// The protocol the extension spoke; newer than the app's means the app
    /// is the one to update.
    pub extension_protocol: Option<u32>,
    /// The extension speaks this app's protocol.
    pub compatible: bool,
    /// Wrote within the last three days.
    pub recent: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct CaptureStatus {
    pub state: CaptureState,
    /// Every browser that ever wrote, in the order Chrome, Edge, Firefox.
    pub browsers: Vec<BrowserStatus>,
    pub last_capture: Option<LastCapture>,
    /// Whole days since the last message from any extension; only when lost.
    pub days_silent: Option<i64>,
    pub problem: Option<CaptureProblem>,
    /// The system's words for the problem, for the report.
    pub detail: Option<String>,
    pub protocol: u32,
}

fn parse(time: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(time)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

pub fn status(
    connections: &Connections,
    problem: Option<(CaptureProblem, String)>,
    now: DateTime<Utc>,
) -> CaptureStatus {
    let browsers: Vec<BrowserStatus> = connections
        .browsers
        .iter()
        .map(|(&browser, contact)| BrowserStatus {
            browser,
            last_seen: contact.last_seen.clone(),
            extension_version: contact.extension_version.clone(),
            extension_protocol: contact.protocol,
            compatible: contact.protocol == Some(PROTOCOL),
            recent: parse(&contact.last_seen)
                .is_some_and(|seen| (now - seen).num_days() < LOST_AFTER_DAYS),
        })
        .collect();
    let newest = connections
        .browsers
        .values()
        .filter_map(|contact| parse(&contact.last_seen))
        .max();
    let state = if problem.is_some() {
        CaptureState::Failing
    } else if browsers.iter().any(|b| b.recent && !b.compatible) {
        CaptureState::Incompatible
    } else if browsers.iter().any(|b| b.recent) {
        CaptureState::Connected
    } else if browsers.is_empty() {
        CaptureState::None
    } else {
        CaptureState::Lost
    };
    CaptureStatus {
        days_silent: (state == CaptureState::Lost)
            .then(|| newest.map(|seen| (now - seen).num_days()))
            .flatten(),
        state,
        browsers,
        last_capture: connections.last_capture.clone(),
        detail: problem.as_ref().map(|(_, detail)| detail.clone()),
        problem: problem.map(|(problem, _)| problem),
        protocol: PROTOCOL,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn at(days_ago: i64) -> String {
        (now() - Duration::days(days_ago))
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string()
    }
    fn now() -> DateTime<Utc> {
        "2026-10-03T12:00:00Z".parse().unwrap()
    }

    #[test]
    fn states_follow_the_newest_contact() {
        let mut c = Connections::default();
        assert_eq!(status(&c, None, now()).state, CaptureState::None);

        c.contact(Browser::Edge, Some("0.5.0".into()), Some(PROTOCOL), &at(5));
        let lost = status(&c, None, now());
        assert_eq!(lost.state, CaptureState::Lost);
        assert_eq!(lost.days_silent, Some(5));

        c.contact(Browser::Chrome, Some("0.5.0".into()), Some(PROTOCOL), &at(2));
        let connected = status(&c, None, now());
        assert_eq!(connected.state, CaptureState::Connected);
        assert_eq!(connected.days_silent, None);
        assert_eq!(
            connected
                .browsers
                .iter()
                .map(|b| (b.browser, b.recent))
                .collect::<Vec<_>>(),
            vec![(Browser::Chrome, true), (Browser::Edge, false)]
        );
    }

    #[test]
    fn an_old_protocol_and_a_problem_take_precedence() {
        let mut c = Connections::default();
        c.contact(Browser::Chrome, Some("0.5.0".into()), Some(PROTOCOL), &at(0));
        c.contact(Browser::Firefox, Some("0.4.0".into()), Some(1), &at(0));
        assert_eq!(status(&c, None, now()).state, CaptureState::Incompatible);
        let failing = status(
            &c,
            Some((CaptureProblem::Channel, "Access is denied.".into())),
            now(),
        );
        assert_eq!(failing.state, CaptureState::Failing);
        assert_eq!(failing.problem, Some(CaptureProblem::Channel));
        assert_eq!(failing.detail.as_deref(), Some("Access is denied."));
        // A stale incompatible browser does not hide a working one.
        let mut c = Connections::default();
        c.contact(Browser::Chrome, None, Some(PROTOCOL), &at(0));
        c.contact(Browser::Firefox, None, Some(1), &at(4));
        assert_eq!(status(&c, None, now()).state, CaptureState::Connected);
    }

    #[test]
    fn records_survive_a_restart_and_a_broken_value_starts_over() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::migrations::migrate(&mut conn, None).unwrap();
        assert_eq!(Connections::load(&conn), Connections::default());
        let mut c = Connections::default();
        c.contact(Browser::Firefox, Some("0.5.0".into()), Some(PROTOCOL), &at(1));
        c.captured(Browser::Firefox, &at(1));
        c.save(&conn).unwrap();
        assert_eq!(Connections::load(&conn), c);
        db::set_setting(&conn, SETTING, "{broken").unwrap();
        assert_eq!(Connections::load(&conn), Connections::default());
    }
}
