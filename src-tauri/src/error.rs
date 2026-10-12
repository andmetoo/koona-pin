//! Errors of IPC commands: a machine code and a message, as in HTTP v1
//! (NP-007). The interface decides by `code`; `message` is for people.

use rusqlite::ffi;
use serde::Serialize;
use std::fmt::Display;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ErrorCode {
    /// Wrong input: an empty title, an unsupported link.
    InvalidRequest,
    /// The record, or the record it points to, no longer exists.
    NotFound,
    /// A unique name, address or request id is taken.
    Conflict,
    /// Another program held the library longer than the busy timeout.
    DatabaseBusy,
    /// No space left for the library.
    DiskFull,
    /// The library is read-only because damage was found.
    ReadOnly,
    /// Any other database failure.
    DatabaseError,
    /// A failure outside the database: a thread, a folder, the opener.
    Internal,
    /// A request to a service on the internet failed: feedback (NP-088).
    Network,
}

/// What exactly went wrong, when people are told more than the code says.
/// The interface has words for each in `src/locales` (`errors.detail`);
/// the English `message` stays for the log (NP-085).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ErrorDetail {
    EmptyTag,
    EmptyCollectionName,
    EmptyTitle,
    BookmarkGone,
    NotInTrash,
    InvalidUrl,
    UnsupportedUrl,
    NothingExported,
    CopyGone,
    LibraryOpening,
    /// Feedback (NP-088): nothing to send, too long, a bad reply address.
    EmptyMessage,
    MessageTooLong,
    InvalidEmail,
    /// No internet connection, or the feedback service could not be reached.
    NoConnection,
    /// The service answered with an error or did not answer in time.
    ServiceFailed,
    /// Over the hourly limit of the service.
    TooManyMessages,
    /// The network's proxy refused the request: it asks for a sign-in or cannot be reached.
    ProxyFailed,
    /// No connection on a network whose proxy is set by a setup script the app cannot
    /// run: either cause is possible.
    NoConnectionOrProxy,
    /// No connection on Linux while a proxy is set only in GNOME's or KDE's settings,
    /// which the app does not read (NP-097): either cause is possible.
    NoConnectionOrSystemProxy,
    /// koonapin-mcp is not next to the app (NP-091): a broken installation.
    ServerMissing,
    /// Supporter (NP-066): no Supporter account has this email.
    NotSupporter,
    /// The code from the email is wrong or has expired.
    WrongCode,
    /// The account was signed out elsewhere: sign in again.
    SignedOut,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct CommandError {
    pub code: ErrorCode,
    /// English, for the log; people read `detail` or `code` in their language.
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub detail: Option<ErrorDetail>,
}

impl CommandError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        CommandError {
            code,
            message: message.into(),
            detail: None,
        }
    }

    /// A failure the interface explains in its own words.
    pub fn detailed(code: ErrorCode, detail: ErrorDetail, message: impl Into<String>) -> Self {
        CommandError {
            detail: Some(detail),
            ..CommandError::new(code, message)
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        CommandError::new(ErrorCode::InvalidRequest, message)
    }

    pub fn internal(error: impl Display) -> Self {
        CommandError::new(ErrorCode::Internal, error.to_string())
    }
}

/// The code of a database error, shared with capture errors.
pub fn code_of(error: &rusqlite::Error) -> ErrorCode {
    if matches!(error, rusqlite::Error::QueryReturnedNoRows) {
        return ErrorCode::NotFound;
    }
    let rusqlite::Error::SqliteFailure(failure, _) = error else {
        return ErrorCode::DatabaseError;
    };
    match failure.extended_code {
        ffi::SQLITE_CONSTRAINT_FOREIGNKEY => ErrorCode::NotFound,
        ffi::SQLITE_CONSTRAINT_UNIQUE | ffi::SQLITE_CONSTRAINT_PRIMARYKEY => ErrorCode::Conflict,
        _ => match failure.code {
            rusqlite::ErrorCode::DiskFull => ErrorCode::DiskFull,
            rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked => {
                ErrorCode::DatabaseBusy
            }
            rusqlite::ErrorCode::ReadOnly => ErrorCode::ReadOnly,
            rusqlite::ErrorCode::ConstraintViolation => ErrorCode::InvalidRequest,
            _ => ErrorCode::DatabaseError,
        },
    }
}

impl From<rusqlite::Error> for CommandError {
    fn from(error: rusqlite::Error) -> Self {
        CommandError::new(code_of(&error), error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn failure(sql: &str) -> ErrorCode {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
             CREATE TABLE child (parent INTEGER REFERENCES parent(id));
             INSERT INTO parent VALUES (1, 'one');",
        )
        .unwrap();
        CommandError::from(conn.execute_batch(sql).unwrap_err()).code
    }

    #[test]
    fn database_failures_get_machine_codes() {
        assert_eq!(
            failure("INSERT INTO parent VALUES (2, 'one')"),
            ErrorCode::Conflict
        );
        assert_eq!(
            failure("INSERT INTO child VALUES (99)"),
            ErrorCode::NotFound
        );
        assert_eq!(
            failure("INSERT INTO parent (id) VALUES (3)"),
            ErrorCode::InvalidRequest
        );
        assert_eq!(
            failure("PRAGMA query_only = ON; INSERT INTO parent VALUES (4, 'four')"),
            ErrorCode::ReadOnly
        );
        let conn = Connection::open_in_memory().unwrap();
        let missing = conn.query_row("SELECT 1 WHERE 0", [], |r| r.get::<_, i64>(0));
        assert_eq!(
            CommandError::from(missing.unwrap_err()).code,
            ErrorCode::NotFound
        );
        let json = serde_json::to_string(&CommandError::invalid("Empty")).unwrap();
        assert_eq!(json, r#"{"code":"invalid_request","message":"Empty"}"#);
        let detailed = CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::EmptyTag, "Enter a tag");
        assert_eq!(
            serde_json::to_string(&detailed).unwrap(),
            r#"{"code":"invalid_request","message":"Enter a tag","detail":"empty_tag"}"#
        );
    }

    #[test]
    fn full_disk_is_reported_as_such() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (x BLOB);").unwrap();
        let pages: i64 = conn
            .pragma_query_value(None, "page_count", |r| r.get(0))
            .unwrap();
        conn.pragma_update(None, "max_page_count", pages).unwrap();
        let error = conn
            .execute("INSERT INTO t VALUES (zeroblob(100000))", [])
            .unwrap_err();
        assert_eq!(CommandError::from(error).code, ErrorCode::DiskFull);
    }
}
