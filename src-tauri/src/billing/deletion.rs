//! Deleting the account (Google Play's rule, and the owner's): what the server knows of it
//! (`delete_info`), deleting it now or at the end of the paid period (`delete_account`), and
//! keeping it after all (`delete_cancel`), in koona-services' `billing` function. Each needs a
//! sign-in by email code within ten minutes, which the server checks: the session here is tried
//! first (the dialog asks `delete_info` without a code), and when the server answers `fresh` a code
//! is sent to the account's email ([`super::send_code_to_signed_in`], as sync's «Start over») and
//! signs it in afresh ([`super::sign_in_again`]). Sessions the server minted itself (a paid claim,
//! the review's sign-in) are never fresh. Payments stop at once in both cases; a failure to stop
//! them deletes nothing.
//!
//! Deleted now: this device signs out and turns sync off; the library stays. Deleted later: the
//! date is kept in `account.json` (`delete_at`), and each plan answer brings the server's.
//!
//! Deleting now waits up to a minute for the server. An answer that does not come (a timeout, a
//! dropped connection, a server error) leaves the result unknown, never «nothing was deleted»:
//! [`check_account_deletion`] asks again. Only the server's `deleted` answer counts as deleted and
//! turns sync off; a session that no longer works after a deletion was sent is said neutrally (signed
//! out here, the account most likely gone), since a session revoked another way looks the same.

use super::{access_token, call_raw, fresh_token, signed_out, Billing, Stored};
use crate::error::{CommandError, ErrorCode, ErrorDetail};
use chrono::{DateTime, TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use ts_rs::TS;

/// Deleting now cancels subscriptions at Paddle and Google, then deletes the account: longer than
/// the 15 seconds of any other request.
const DELETE_WAIT: Duration = Duration::from_secs(60);

/// A send not answered this long ago is no longer said: the server cleaned up long since.
const SENT_KEPT: TimeDelta = TimeDelta::days(30);

/// A `delete_account` request that went out and whose answer did not come, kept in `account.json`
/// (`Stored.deletion_sent`) over a restart and over a session that stopped working: only then may a
/// 401 or a refused refresh be read as «most likely deleted» (`check_account_deletion`). Any answer
/// of the server clears it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct SentDeletion {
    email: String,
    at: DateTime<Utc>,
}

/// The pending send of the account here, or of one just signed out (its session gone, no other
/// account signed in since).
fn pending_of(stored: &Stored, now: DateTime<Utc>) -> Option<&SentDeletion> {
    let sent = stored.deletion_sent.as_ref().filter(|sent| now - sent.at < SENT_KEPT)?;
    match &stored.session {
        Some(session) if session.email != sent.email => None,
        _ => Some(sent),
    }
}

/// For the status: the email whose deletion's answer did not come.
pub(super) fn pending(stored: &Stored, now: DateTime<Utc>) -> Option<String> {
    pending_of(stored, now).map(|sent| sent.email.clone())
}

fn was_sent(app: &AppHandle, email: &str) -> bool {
    pending_of(&app.state::<Billing>().get(), Utc::now()).is_some_and(|sent| sent.email == email)
}

/// Notes a send for `email`, or clears it (`None`) on an answer.
fn sent_for(app: &AppHandle, email: Option<&str>) {
    let sent = email.map(|email| SentDeletion { email: email.to_string(), at: Utc::now() });
    if let Err(error) = app.state::<Billing>().update(app, |s| s.deletion_sent = sent) {
        eprintln!("The deletion's send could not be noted: {}", error.message);
    }
}

/// A 401, or a refused refresh, after a deletion for this account went out unanswered: the account
/// may be gone, so not «signed out» but unknown, and «Check again» decides.
fn maybe_gone(app: &AppHandle, email: &str, error: CommandError) -> CommandError {
    if error.detail == Some(ErrorDetail::SignedOut) && was_sent(app, email) {
        CommandError::detailed(ErrorCode::Network, ErrorDetail::DeletionUnknown, "The session no longer works after a deletion was sent")
    } else {
        error
    }
}

/// When the account goes: now, or when the paid time left ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum DeleteWhen {
    Now,
    PeriodEnd,
}

/// What the server says of the account before it is deleted.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct DeleteInfo {
    pub email: String,
    /// Paid time is left, so the account may stay until it ends.
    pub can_wait: bool,
    /// The end of that paid time.
    #[ts(type = "string | null")]
    pub wait_until: Option<DateTime<Utc>>,
    /// A deletion already scheduled for this date.
    #[ts(type = "string | null")]
    pub scheduled: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum DeleteState {
    /// Gone: this device is signed out and sync is off here.
    Deleted,
    /// Deleted on `delete_at`.
    Scheduled,
    /// A scheduled deletion was cancelled; payments stay stopped.
    Kept,
    /// Asked after an answer that did not come: the account is still there, nothing scheduled.
    Active,
    /// Asked after an answer that did not come: the session here no longer works, so this device is
    /// signed out. The deletion most likely went through, but a session revoked another way looks
    /// the same: not `Deleted`, and sync is left as it is.
    SignedOut,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct DeleteOutcome {
    pub status: DeleteState,
    #[ts(type = "string | null")]
    pub delete_at: Option<DateTime<Utc>>,
}

/// The server's refusal of a deletion action, said as the dialogs need it: a sign-in too old asks
/// for a new code, a failure to stop payments says nothing was deleted and offers Try again.
fn refusal(status: u16, value: &Value) -> CommandError {
    let error = value["error"].as_str().unwrap_or_default();
    match (status, error) {
        (401, _) | (_, "session") => CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::SignedOut, "Not signed in"),
        (_, "fresh") => CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::FreshSignIn, "The sign-in is too old to delete the account"),
        (_, "review") => CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::ReviewAccount, "The review account is not deleted"),
        (_, "when") => CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::NoPaidTime, "No paid time is left to wait for"),
        (_, "payments") if value["pending"] == true => {
            CommandError::detailed(ErrorCode::Network, ErrorDetail::PaymentPending, "A payment is still being processed; nothing was deleted")
        }
        (_, "payments") => CommandError::detailed(ErrorCode::Network, ErrorDetail::PaymentsNotStopped, "Payments could not be stopped; nothing was deleted"),
        _ => CommandError::detailed(ErrorCode::Network, ErrorDetail::ServiceFailed, format!("billing answered {status}")),
    }
}

/// A failure of `delete_account` once the request may have reached the server: what it did is not
/// known. Only the server's own refusals, and a connection that never opened, say what happened.
fn after_sending(error: CommandError) -> CommandError {
    match error.detail {
        Some(
            ErrorDetail::SignedOut
            | ErrorDetail::FreshSignIn
            | ErrorDetail::ReviewAccount
            | ErrorDetail::NoPaidTime
            | ErrorDetail::PaymentPending
            | ErrorDetail::PaymentsNotStopped
            | ErrorDetail::NoConnection,
        ) => error,
        _ => CommandError::detailed(ErrorCode::Network, ErrorDetail::DeletionUnknown, format!("The deletion's answer did not come: {}", error.message)),
    }
}

fn date(value: &Value) -> Option<DateTime<Utc>> {
    value.as_str().and_then(|text| text.parse().ok())
}

/// `delete_info`'s answer; None for a body that is not one.
fn info_of(value: &Value) -> Option<DeleteInfo> {
    Some(DeleteInfo {
        email: value["email"].as_str()?.to_string(),
        can_wait: value["can_wait"].as_bool()?,
        wait_until: date(&value["wait_until"]),
        scheduled: date(&value["scheduled"]),
    })
}

/// `delete_account`'s and `delete_cancel`'s answer.
fn outcome_of(value: &Value) -> Option<DeleteOutcome> {
    let status = match value["status"].as_str()? {
        "deleted" => DeleteState::Deleted,
        "scheduled" => DeleteState::Scheduled,
        "kept" => DeleteState::Kept,
        _ => return None,
    };
    let delete_at = date(&value["delete_at"]);
    if status == DeleteState::Scheduled && delete_at.is_none() {
        return None;
    }
    Some(DeleteOutcome { status, delete_at })
}

/// The access token for a deletion action: signed in afresh by `code`, or the one here, which the
/// server takes only within ten minutes of a sign-in by code. Signed out after a deletion went out
/// unanswered (the session stopped working, or ended here): `deletion_unknown`.
async fn token(app: &AppHandle, code: Option<&str>) -> Result<(String, String), CommandError> {
    let Some(email) = super::signed_in_email(app) else {
        let pending = pending(&app.state::<Billing>().get(), Utc::now());
        return Err(match pending {
            Some(email) => maybe_gone(app, &email, signed_out()),
            None => signed_out(),
        });
    };
    let token = match code {
        Some(code) => super::sign_in_again(app, code).await?,
        None => access_token(app).await?.ok_or_else(|| maybe_gone(app, &email, signed_out()))?,
    };
    Ok((email, token))
}

async fn ask(app: &AppHandle, body: Value, token: &str, timeout: Option<Duration>) -> Result<Value, CommandError> {
    let (status, value) = call_raw(app, body, Some(token), timeout).await?;
    if status.is_success() {
        Ok(value)
    } else {
        Err(refusal(status.as_u16(), &value))
    }
}

fn unexpected(what: &str) -> CommandError {
    CommandError::detailed(ErrorCode::Network, ErrorDetail::ServiceFailed, format!("{what}: an answer the app does not know"))
}

/// The scheduled date as the server has it, kept for the dialogs to say.
fn keep_date(app: &AppHandle, email: &str, delete_at: Option<DateTime<Utc>>) -> Result<(), CommandError> {
    app.state::<Billing>().update(app, |s| {
        if s.same_account(email) {
            s.delete_at = delete_at;
        }
    })?;
    Ok(())
}

/// The account is gone: signed out here and sync off; the library stays. The server deleted it
/// either way, so a failure to write that down here is only logged.
async fn deleted(app: &AppHandle, email: &str) -> DeleteOutcome {
    let billing = app.state::<Billing>();
    // After a claim already asking, as Sign out.
    let _one_at_a_time = billing.claiming.lock().await;
    let mut ours = false;
    if let Err(error) = billing.update(app, |s| {
        if s.same_account(email) {
            ours = true;
            s.signed_out();
        }
    }) {
        eprintln!("The deleted account could not be forgotten here: {}", error.message);
    }
    // Sync's relay data went with the account: the client here stops (signed out, it could not
    // run anyway). Another account signed in meanwhile keeps its sync.
    if ours {
        if let Err(error) = crate::commercial::sync::disable_sync(app.clone()) {
            eprintln!("Sync could not be turned off after the account was deleted: {}", error.message);
        }
    }
    DeleteOutcome { status: DeleteState::Deleted, delete_at: None }
}

/// «Send code» of the deletion: a code to the account's email, which is returned.
#[tauri::command]
pub async fn send_account_code(app: AppHandle) -> Result<String, CommandError> {
    super::send_code_to_signed_in(&app).await
}

/// What the server knows of the account: paid time left, a deletion already scheduled. With
/// `code`, signs in afresh first; without, `fresh_sign_in` says a code is needed.
#[tauri::command]
pub async fn get_account_deletion(app: AppHandle, code: Option<String>) -> Result<DeleteInfo, CommandError> {
    let (email, token) = token(&app, code.as_deref()).await?;
    let value = ask(&app, json!({ "action": "delete_info" }), &token, None).await.map_err(|error| maybe_gone(&app, &email, error))?;
    let info = info_of(&value).ok_or_else(|| unexpected("delete_info"))?;
    // The account answered: a deletion sent earlier did not delete it.
    sent_for(&app, None);
    keep_date(&app, &email, info.scheduled)?;
    Ok(info)
}

/// Deletes the account now, or schedules it for the end of the paid period, with the sign-in here
/// (the dialog has it fresh by then). Deleted now: this device signs out and sync is turned off here.
/// A failure after the request went out is `deletion_unknown`: [`check_account_deletion`] tells.
#[tauri::command]
pub async fn delete_account(app: AppHandle, when: DeleteWhen) -> Result<DeleteOutcome, CommandError> {
    let (email, token) = token(&app, None).await?;
    let name = match when {
        DeleteWhen::Now => "now",
        DeleteWhen::PeriodEnd => "period_end",
    };
    // A 401 now, after an earlier send went unanswered, may be that send having deleted it.
    let earlier = was_sent(&app, &email);
    sent_for(&app, Some(&email));
    let value = match ask(&app, json!({ "action": "delete_account", "when": name }), &token, Some(DELETE_WAIT)).await {
        Ok(value) => value,
        Err(error) => {
            let error = if earlier && error.detail == Some(ErrorDetail::SignedOut) {
                CommandError::detailed(ErrorCode::Network, ErrorDetail::DeletionUnknown, "The session no longer works after a deletion was sent")
            } else {
                after_sending(error)
            };
            // Only an answer that did not come leaves the request possibly done.
            if error.detail != Some(ErrorDetail::DeletionUnknown) {
                sent_for(&app, None);
            }
            return Err(error);
        }
    };
    let outcome = outcome_of(&value).filter(|o| o.status != DeleteState::Kept).ok_or_else(|| after_sending(unexpected("delete_account")))?;
    if outcome.status == DeleteState::Deleted {
        return Ok(deleted(&app, &email).await);
    }
    sent_for(&app, None);
    keep_date(&app, &email, outcome.delete_at)?;
    Ok(outcome)
}

/// After an answer that did not come: asks the server what became of the account. Never «deleted»
/// on its own word: a 401 gets one forced refresh and a second ask, and only a refresh then refused,
/// after a deletion was sent from here, says this device is signed out (`SignedOut`, neutrally, sync
/// left as it is). Another account signed in meanwhile is left alone.
#[tauri::command]
pub async fn check_account_deletion(app: AppHandle) -> Result<DeleteOutcome, CommandError> {
    let pending = pending(&app.state::<Billing>().get(), Utc::now());
    let Some(email) = super::signed_in_email(&app).or(pending) else {
        return Err(signed_out());
    };
    let mut forced = false;
    loop {
        let token = if super::signed_in_email(&app).is_some() { fresh_token(&app, forced).await? } else { None };
        let Some(token) = token else {
            // No session works any more (the refresh token refused, or it ended here before): said
            // neutrally, and only after a deletion was sent for this account; this device is signed
            // out as on Sign out. Another account signed in meanwhile is left alone.
            if was_sent(&app, &email) {
                app.state::<Billing>().update(&app, |s| {
                    if s.session.is_none() || s.same_account(&email) {
                        s.signed_out();
                    }
                })?;
                return Ok(DeleteOutcome { status: DeleteState::SignedOut, delete_at: None });
            }
            return Err(signed_out());
        };
        if super::signed_in_email(&app).as_deref() != Some(email.as_str()) {
            return Err(signed_out());
        }
        let (status, value) = call_raw(&app, json!({ "action": "delete_info" }), Some(&token), None).await?;
        if status.as_u16() == 401 {
            if forced {
                // A token just refreshed is refused: still not known.
                return Err(CommandError::detailed(ErrorCode::Network, ErrorDetail::DeletionUnknown, "The session was refused after a refresh"));
            }
            forced = true;
            continue;
        }
        if status.is_success() {
            let info = info_of(&value).ok_or_else(|| unexpected("delete_info"))?;
            sent_for(&app, None);
            keep_date(&app, &email, info.scheduled)?;
            let status = if info.scheduled.is_some() { DeleteState::Scheduled } else { DeleteState::Active };
            return Ok(DeleteOutcome { status, delete_at: info.scheduled });
        }
        return match refusal(status.as_u16(), &value).detail {
            // Too old for the action, but the account answered: it is still there.
            Some(ErrorDetail::FreshSignIn | ErrorDetail::ReviewAccount) => {
                sent_for(&app, None);
                Ok(DeleteOutcome { status: DeleteState::Active, delete_at: None })
            }
            _ => Err(refusal(status.as_u16(), &value)),
        };
    }
}

/// «Keep my account»: the scheduled deletion is cancelled; payments stay stopped.
#[tauri::command]
pub async fn keep_account(app: AppHandle, code: Option<String>) -> Result<DeleteOutcome, CommandError> {
    let (email, token) = token(&app, code.as_deref()).await?;
    let value = ask(&app, json!({ "action": "delete_cancel" }), &token, None).await?;
    let outcome = outcome_of(&value).filter(|o| o.status == DeleteState::Kept).ok_or_else(|| unexpected("delete_cancel"))?;
    keep_date(&app, &email, None)?;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::billing::{Answer, Session};

    #[test]
    fn the_servers_refusals_are_said_as_the_dialogs_need_them() {
        let detail = |status: u16, body: Value| refusal(status, &body).detail;
        assert_eq!(detail(401, json!({ "error": "session" })), Some(ErrorDetail::SignedOut));
        assert_eq!(detail(401, Value::Null), Some(ErrorDetail::SignedOut), "a gateway's 401 too");
        assert_eq!(detail(403, json!({ "error": "fresh" })), Some(ErrorDetail::FreshSignIn));
        assert_eq!(detail(403, json!({ "error": "review" })), Some(ErrorDetail::ReviewAccount));
        assert_eq!(detail(400, json!({ "error": "when" })), Some(ErrorDetail::NoPaidTime));
        let payments = refusal(502, &json!({ "error": "payments" }));
        assert_eq!((payments.code, payments.detail), (ErrorCode::Network, Some(ErrorDetail::PaymentsNotStopped)));
        assert_eq!(detail(502, json!({ "error": "payments", "pending": true })), Some(ErrorDetail::PaymentPending), "a Google Play payment still processing");
        assert_eq!(detail(500, Value::Null), Some(ErrorDetail::ServiceFailed), "anything else: the server failed");
        assert_eq!(detail(404, json!({ "error": "unknown action" })), Some(ErrorDetail::ServiceFailed));
    }

    #[test]
    fn a_deletion_whose_answer_did_not_come_is_unknown_never_not_deleted() {
        let after = |status: u16, body: Value| after_sending(refusal(status, &body)).detail;
        assert_eq!(after(502, json!({ "error": "payments" })), Some(ErrorDetail::PaymentsNotStopped), "the server said nothing was deleted");
        assert_eq!(after(502, json!({ "error": "payments", "pending": true })), Some(ErrorDetail::PaymentPending));
        assert_eq!(after(403, json!({ "error": "fresh" })), Some(ErrorDetail::FreshSignIn));
        assert_eq!(after(502, json!({ "error": "server" })), Some(ErrorDetail::DeletionUnknown), "payments may have stopped already");
        assert_eq!(after(500, Value::Null), Some(ErrorDetail::DeletionUnknown));
        let timeout = CommandError::detailed(ErrorCode::Network, ErrorDetail::ServiceFailed, "operation timed out");
        assert_eq!(after_sending(timeout).detail, Some(ErrorDetail::DeletionUnknown), "a timeout: the server may have finished");
        let never_sent = CommandError::detailed(ErrorCode::Network, ErrorDetail::NoConnection, "connect error");
        assert_eq!(after_sending(never_sent).detail, Some(ErrorDetail::NoConnection), "no connection opened: nothing was sent");
    }

    #[test]
    fn a_pending_send_is_the_account_s_here_or_just_signed_out_and_survives_the_file() {
        let now: DateTime<Utc> = "2026-10-21T12:00:00Z".parse().unwrap();
        let session = |email: &str| Session { access_token: "a".into(), refresh_token: "r".into(), expires_at: 0, email: email.into() };
        let sent = SentDeletion { email: "anna@example.com".into(), at: now - TimeDelta::minutes(5) };
        let mut stored = Stored { session: Some(session("anna@example.com")), deletion_sent: Some(sent.clone()), ..Stored::default() };
        assert_eq!(pending(&stored, now).as_deref(), Some("anna@example.com"));
        // Read back after a restart.
        let read: Stored = serde_json::from_str(&serde_json::to_string(&stored).unwrap()).unwrap();
        assert_eq!(read.deletion_sent, Some(sent.clone()));
        // The session stopped working (the refresh refused): still said, for «Check again».
        stored.session = None;
        assert_eq!(pending(&stored, now).as_deref(), Some("anna@example.com"));
        // Another account signed in since: not its business.
        stored.session = Some(session("ben@example.com"));
        assert_eq!(pending(&stored, now), None);
        // Long ago: no longer said.
        stored.session = Some(session("anna@example.com"));
        assert_eq!(pending(&stored, now + TimeDelta::days(31)), None);
        // Sign out forgets it with the account; the environment and unbound Play purchases stay.
        stored.sandbox = true;
        stored.signed_out();
        assert_eq!((stored.deletion_sent.clone(), stored.session.is_none(), stored.sandbox), (None, true, true));
    }

    #[test]
    fn the_answers_are_read_as_the_contract_has_them() {
        let info = info_of(&json!({ "email": "anna@example.com", "plan": null, "can_wait": true, "wait_until": "2027-10-11T12:00:00.000Z", "scheduled": null })).unwrap();
        assert!(info.can_wait);
        assert_eq!(info.wait_until, Some("2027-10-11T12:00:00Z".parse().unwrap()));
        assert_eq!(info.scheduled, None);
        assert_eq!(info_of(&json!({ "error": "fresh" })), None, "not an answer");

        assert_eq!(outcome_of(&json!({ "status": "deleted" })), Some(DeleteOutcome { status: DeleteState::Deleted, delete_at: None }));
        let scheduled = outcome_of(&json!({ "status": "scheduled", "delete_at": "2027-10-11T12:00:00Z" })).unwrap();
        assert_eq!(scheduled.delete_at, Some("2027-10-11T12:00:00Z".parse().unwrap()));
        assert_eq!(outcome_of(&json!({ "status": "scheduled" })), None, "scheduled without its date is no answer");
        assert_eq!(outcome_of(&json!({ "status": "kept" })).map(|o| o.status), Some(DeleteState::Kept));
        assert_eq!(outcome_of(&json!({ "status": "gone" })), None);
    }

    #[test]
    fn a_deleted_account_leaves_this_device_as_on_sign_out() {
        let mut stored = Stored {
            sandbox: true,
            session: Some(Session { access_token: "a".into(), refresh_token: "r".into(), expires_at: 0, email: "anna@example.com".into() }),
            delete_at: Some("2027-10-11T12:00:00Z".parse().unwrap()),
            checked_at: Some(Utc::now()),
            ..Stored::default()
        };
        stored.signed_out();
        assert!(stored.session.is_none() && stored.delete_at.is_none() && stored.checked_at.is_none());
        assert!(stored.sandbox, "the environment stays");
    }

    #[test]
    fn a_scheduled_date_belongs_to_its_account() {
        let session = |email: &str| Session { access_token: "a".into(), refresh_token: "r".into(), expires_at: 0, email: email.into() };
        let at: DateTime<Utc> = "2027-10-11T12:00:00Z".parse().unwrap();
        let mut stored = Stored { session: Some(session("anna@example.com")), delete_at: Some(at), ..Stored::default() };
        assert_eq!(crate::billing::status(&stored, Utc::now()).delete_at, Some(at));
        stored.sign_in(session("anna@example.com"), &[]);
        assert_eq!(stored.delete_at, Some(at), "signed in afresh by the deletion's code: kept");
        stored.sign_in(session("ben@example.com"), &[]);
        assert_eq!(stored.delete_at, None, "another account's date goes");
        stored.delete_at = Some(at);
        stored.session = None;
        assert_eq!(crate::billing::status(&stored, Utc::now()).delete_at, None, "signed out: nothing to say");
    }

    #[test]
    fn the_plan_answer_brings_the_servers_date() {
        let at: DateTime<Utc> = "2027-10-11T12:00:00Z".parse().unwrap();
        let session = Session { access_token: "a".into(), refresh_token: "r".into(), expires_at: 0, email: "anna@example.com".into() };
        let mut stored = Stored { session: Some(session), ..Stored::default() };
        // Scheduled on the web or another device: it shows here.
        let answer = Answer::of(&json!({ "plan": null, "lease": null, "delete_at": "2027-10-11T12:00:00Z" }));
        stored.take_answer(answer, &[], Utc::now());
        assert_eq!(stored.delete_at, Some(at));
        // Kept elsewhere, or a new purchase cancelled it: the answer has none, and it goes.
        stored.take_answer(Answer::of(&json!({ "plan": null, "lease": null, "delete_at": null })), &[], Utc::now());
        assert_eq!(stored.delete_at, None);
        // A body that is not the function's answer says nothing about it.
        stored.delete_at = Some(at);
        stored.take_answer(Answer::of(&json!("bad gateway")), &[], Utc::now());
        assert_eq!(stored.delete_at, Some(at));
    }
}
