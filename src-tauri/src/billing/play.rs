//! Supporter through Google Play Billing (NP-154): the Play build's purchase, after the owner's
//! flow B. The purchase comes first, made with a fresh secret whose SHA-256 is the purchase's
//! `obfuscatedAccountId`; the server (`billing`'s `play_verify`) checks the purchase with Google and
//! binds it to the account signed in here. Signed out, the person gives an email (`play_email`, an
//! account is made for it if none has it) and signs in with the code sent there; the purchase is
//! then verified again with that session, which binds it. Until it is bound Play does not have it
//! acknowledged, so a purchase nobody claims is refunded by Play after three days.
//!
//! The secret is kept in `account.json` until the purchase is bound, found invalid (refunded,
//! expired, someone else's) or four days old, and over Sign out: it is the purchase's only claim.
//! Purchases are looked for on start and each time the app comes back to the screen, and when Play
//! reports one outside the sheet (a slow payment that completed).
//!
//! Only the Play build (`cfg(play)`: the feature `store-play` on Android) has the plugin and the
//! commands; the types and the handling of the answers are everyone's, so they are checked and
//! tested on a desktop.

// Outside the Play build only the sign-in's part (`verify_waiting`) runs; the rest is its tests'.
#![cfg_attr(not(play), allow(dead_code))]

use super::{
    access_token, call, need_service, new_secret, plan_key, refused, Answer, Billing, PlanInterval, Stored,
};
use crate::error::{CommandError, ErrorCode, ErrorDetail};
use chrono::{DateTime, TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use ts_rs::TS;

#[cfg(any(test, play))]
use tauri_plugin_koona_play as native;

/// Play's ids (Play Console): the subscription and its base plans, and Supporter · 5 years, which
/// the server consumes once recorded, so it can be bought again.
pub const SUBSCRIPTION: &str = "supporter";
pub const MONTHLY: &str = "monthly";
pub const YEARLY: &str = "yearly";
pub const FIVE_YEARS: &str = "supporter_5_years";

/// Play refunds a purchase not acknowledged within three days of its payment; a day more covers a
/// slow clock. A slow payment still pending has no such limit.
const LIFETIME: TimeDelta = TimeDelta::days(4);
/// Play's sheet is the person's to finish; the app stops waiting for its answer after this, keeps the
/// purchase and finds it by its account id on the way back.
const BUY_WAIT: std::time::Duration = std::time::Duration::from_secs(10 * 60);
/// Play's prices and purchases come at once or not at all.
const ASK_WAIT: std::time::Duration = std::time::Duration::from_secs(30);
/// Purchases kept at once. Cancelled ones are not kept, so more is unusual.
const MAX_KEPT: usize = 6;
/// A purchase asked about this recently is not asked about again on the way back to the screen.
const FRESH: TimeDelta = TimeDelta::seconds(15);

/// Where a Play purchase stands, or what it came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum PlayState {
    /// Bound to the account signed in here: the plan is here.
    Paid,
    /// Paid and verified, no account yet: the sheet asks for an email (`play_claim_email`).
    Email,
    /// A code was sent to the email given for the purchase (`play_claim_email`), which is in
    /// [`PlayProgress`]: the code signs in (`verify_sign_in_code`) and binds the purchase.
    SignIn,
    /// The purchase, or what this Google account owns, belongs to a Koona Pin account and nobody
    /// is signed in here: signing in to that account (any email; no code was sent) shows the plan.
    Owned,
    /// The account's own subscription through Google Play is on hold or paused: the payment is
    /// fixed in Google Play, not bought again.
    Suspended,
    /// Google Play waits for a slow payment; nothing is bound or charged yet.
    Pending,
    /// The account has Supporter already: Google Play refunds this purchase.
    AlreadySupporter,
    /// The purchase belongs to another Koona Pin account than the one signed in here.
    OtherAccount,
    /// The person closed Play's sheet.
    Canceled,
    /// Expired, refunded, cancelled before it was paid, or not this app's.
    Invalid,
    /// No Google Play here, a blocked one, or the product is not on sale.
    Unavailable,
    /// Play failed, or answered with a purchase that is not this one.
    Error,
}

impl PlayState {
    /// Still waiting for the person or for Play: kept with its purchase and shown by the sheet.
    fn waiting(self) -> bool {
        matches!(self, PlayState::Email | PlayState::SignIn | PlayState::Owned | PlayState::Pending)
    }
}

/// A Play purchase the sheet shows: one waiting here, else how the last one in this run finished.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct PlayProgress {
    pub state: PlayState,
    /// The email given for it, where the code goes; none before one is given.
    pub email: Option<String>,
}

/// One price from Google Play, in the person's currency.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct PlayPrice {
    /// Formatted by Play: «€2.00».
    pub price: String,
    pub currency: String,
    /// The price in millionths of `currency`.
    pub micros: i64,
    /// ISO 8601 (`P1M`, `P1Y`) for a subscription; none for five years paid once.
    pub period: Option<String>,
}

/// What the Play build's sheet offers. Each plan is none while Play does not sell it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct PlayOffer {
    /// False when this phone cannot buy through Google Play: no Play Store, a blocked one.
    pub available: bool,
    pub month: Option<PlayPrice>,
    pub year: Option<PlayPrice>,
    pub five_years: Option<PlayPrice>,
    /// This Google account's Supporter subscription is on hold or paused: the sheet offers to fix
    /// the payment in Google Play instead of the plans.
    pub suspended: bool,
}

/// A purchase started here through Google Play (`account.json`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct PlayCheckout {
    /// Its SHA-256 is the purchase's `obfuscatedAccountId`; the server stores only that.
    pub secret: String,
    pub product: String,
    pub base_plan: Option<String>,
    /// Play's token, once Play reported the purchase.
    pub token: Option<String>,
    /// The email given for it: the code goes there.
    pub email: Option<String>,
    pub started: DateTime<Utc>,
    /// What the server said last; none before it was asked.
    #[serde(default)]
    pub state: Option<PlayState>,
    #[serde(default)]
    pub asked_at: Option<DateTime<Utc>>,
    /// The account signed in when the purchase started: only its session is ever sent for it.
    #[serde(default)]
    pub account: Option<String>,
    /// When the app first knew it paid (Play reported it purchased, or the server answered more
    /// than `pending`): Play's three days run from there.
    #[serde(default)]
    pub paid_at: Option<DateTime<Utc>>,
}

/// How a purchase may be asked about, by the session here.
#[derive(Debug, PartialEq)]
pub(super) enum Ask {
    /// With the session: the account the purchase is for, which it binds to.
    WithSession,
    /// Without one: the server says where it stands, and binds nothing.
    WithoutSession,
    /// Not now: another account is signed in than the one the purchase is for.
    Skip,
}

/// Whose a purchase is: the email given for it, which the code proves, else the account signed in
/// when it started. Another account's session is never sent for it; a purchase started signed out
/// and not claimed by an email is asked about without a session, so it is bound only through the
/// email step.
pub(super) fn ask_for(checkout: &PlayCheckout, signed_in: Option<&str>) -> Ask {
    let owner = checkout.email.as_deref().or(checkout.account.as_deref());
    match (owner, signed_in) {
        (_, None) | (None, Some(_)) => Ask::WithoutSession,
        (Some(owner), Some(email)) if owner.trim().eq_ignore_ascii_case(email.trim()) => Ask::WithSession,
        (Some(_), Some(_)) => Ask::Skip,
    }
}

/// Play's product and base plan for a plan.
pub(super) fn product_of(interval: PlanInterval) -> (&'static str, Option<&'static str>) {
    match interval {
        PlanInterval::Month => (SUBSCRIPTION, Some(MONTHLY)),
        PlanInterval::Year => (SUBSCRIPTION, Some(YEARLY)),
        PlanInterval::FiveYears => (FIVE_YEARS, None),
    }
}

/// The purchase's `obfuscatedAccountId`: SHA-256 of the secret's text, 64 lower-case hex digits.
pub(super) fn account_id(secret: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(secret.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// What `play_verify` said.
pub(super) struct Verdict {
    state: PlayState,
    /// The plan of `paid`, `already_supporter` and `suspended`.
    answer: Option<Answer>,
}

/// The server's answer to `play_verify`; an error for one that says nothing about the purchase
/// (a server error, a refusal other than the claim's, a body that is not the function's).
pub(super) fn verdict(status: reqwest::StatusCode, value: &Value) -> Result<Verdict, CommandError> {
    // The server does not sell through Google Play (not set up): the purchase stays, unclaimed.
    if status == reqwest::StatusCode::NOT_FOUND && value["error"] == "play" {
        return Ok(Verdict { state: PlayState::Unavailable, answer: None });
    }
    // The claim does not match the purchase, or the server has no such purchase: not this app's.
    if (status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::NOT_FOUND) && value["error"] == "claim" {
        return Ok(Verdict { state: PlayState::Invalid, answer: None });
    }
    if !status.is_success() {
        return Err(refused("billing play_verify", status));
    }
    let state = match value["status"].as_str() {
        Some("paid") => PlayState::Paid,
        Some("already_supporter") => PlayState::AlreadySupporter,
        Some("email") => PlayState::Email,
        // Bound to an account, asked without a session: sign in to it.
        Some("sign_in") => PlayState::Owned,
        Some("suspended") => PlayState::Suspended,
        Some("pending") => PlayState::Pending,
        Some("other_account") => PlayState::OtherAccount,
        Some("invalid") => PlayState::Invalid,
        _ => return Err(refused("billing play_verify", status)),
    };
    let answer = matches!(state, PlayState::Paid | PlayState::AlreadySupporter | PlayState::Suspended).then(|| Answer::of(value));
    Ok(Verdict { state, answer })
}

impl Stored {
    pub(super) fn add_play(&mut self, checkout: PlayCheckout) {
        self.play_outcome = None;
        self.play.push(checkout);
        while self.play.len() > MAX_KEPT {
            // The oldest that Play never reported goes first: one with a token may be paid.
            let at = self.play.iter().position(|c| c.token.is_none()).unwrap_or(0);
            self.play.remove(at);
        }
    }

    /// Drops purchases Play has refunded by now: paid and not claimed in three days, or never
    /// reported by Play at all. A slow payment still pending stays until the server says it is
    /// invalid or Play no longer lists it ([`Stored::forget_unlisted`]).
    pub(super) fn forget_old_play(&mut self, now: DateTime<Utc>) {
        self.play.retain(|c| match (c.paid_at, &c.token) {
            (Some(paid), _) => now - paid <= LIFETIME,
            (None, None) => now - c.started <= LIFETIME,
            (None, Some(_)) => true,
        });
    }

    /// Everything Google Play lists now (its tokens): a pending purchase no longer among them was
    /// cancelled before it was paid.
    pub(super) fn forget_unlisted(&mut self, listed: &[&str]) {
        self.play.retain(|c| c.paid_at.is_some() || c.token.as_deref().is_none_or(|token| listed.contains(&token)));
    }

    /// A purchase that left `play`, and how it finished.
    fn finish_play(&mut self, secret: &str, state: PlayState) {
        self.play.retain(|c| c.secret != secret);
        self.play_outcome = Some(state);
    }

    /// Play's purchases (token, account id, paid) made here: each one whose account id is a kept
    /// secret's gets its token, and the time it was first seen paid. The secrets of those found.
    pub(super) fn find_play<'a>(&mut self, purchases: impl IntoIterator<Item = (&'a str, Option<&'a str>, bool)>, now: DateTime<Utc>) -> Vec<String> {
        let mut found = Vec::new();
        for (token, id, paid) in purchases {
            let Some(id) = id else { continue };
            if let Some(checkout) = self.play.iter_mut().find(|c| account_id(&c.secret) == id) {
                checkout.token = Some(token.to_string());
                if paid {
                    checkout.paid_at.get_or_insert(now);
                }
                found.push(checkout.secret.clone());
            }
        }
        found
    }

    /// What the server said about the purchase with this secret, asked at `at` with the session
    /// of `asked_for` (none: without one). Bound (`paid`, `already_supporter`): its plan for that
    /// account, if it is still the one here, and the purchase is done. Someone else's or invalid:
    /// done. Otherwise it waits; after an email was given, `email` is still waiting for its code.
    /// Only while the purchase is still here; the state it is in now.
    pub(super) fn take_play_answer(&mut self, secret: &str, verdict: Verdict, asked_for: Option<&str>, key: &[u8], at: DateTime<Utc>) -> Option<PlayState> {
        let checkout = self.play.iter_mut().find(|c| c.secret == secret)?;
        checkout.asked_at = Some(at);
        let state = match verdict.state {
            PlayState::Email if checkout.email.is_some() => PlayState::SignIn,
            state => state,
        };
        // Anything but a slow payment or no answer means the payment went through.
        if !matches!(state, PlayState::Pending | PlayState::Unavailable | PlayState::Invalid) {
            checkout.paid_at.get_or_insert(at);
        }
        if state.waiting() {
            checkout.state = Some(state);
            return Some(state);
        }
        // The server cannot verify Play purchases now: this one stays as it was, asked again later.
        if state == PlayState::Unavailable {
            return Some(state);
        }
        if let (Some(answer), Some(email)) = (verdict.answer, asked_for) {
            if self.same_account(email) {
                self.take_answer(answer, key, at);
            }
        }
        self.finish_play(secret, state);
        Some(state)
    }

    /// What the sheet shows: the newest purchase waiting here, else the last one finished.
    pub(super) fn play_progress(&self) -> Option<PlayProgress> {
        let waiting = self.play.iter().rev().find_map(|c| Some((c.state.filter(|s| s.waiting())?, c)));
        match waiting {
            Some((state, checkout)) => Some(PlayProgress { state, email: checkout.email.clone() }),
            None => self.play_outcome.map(|state| PlayProgress { state, email: None }),
        }
    }

    /// The purchase the email is for: the newest one verified and waiting for an email or its code.
    fn claimable(&self) -> Option<&PlayCheckout> {
        self.play.iter().rev().find(|c| c.token.is_some() && matches!(c.state, Some(PlayState::Email | PlayState::SignIn)))
    }
}

/// Whether this Google account's Supporter subscription is on hold or paused, by what it owns.
#[cfg(any(test, play))]
pub(super) fn suspended_of(purchases: &[native::Purchase]) -> bool {
    purchases.iter().any(|p| p.suspended && p.products.iter().any(|id| id == SUBSCRIPTION))
}

/// The prices the sheet shows, from Play's products, and whether the subscription Google Play has
/// is suspended.
#[cfg(any(test, play))]
pub(super) fn offer_of(products: &[native::Product], suspended: bool) -> PlayOffer {
    // A base plan is offered only with the period its card says: a monthly plan set to three months
    // in Play Console would put a wrong disclosure on the sheet.
    let price = |product: &str, base_plan: Option<&str>, period: Option<&str>| {
        products.iter().find(|p| p.product == product && p.base_plan.as_deref() == base_plan && p.period.as_deref() == period).map(|p| PlayPrice {
            price: p.price.clone(),
            currency: p.currency.clone(),
            micros: p.micros,
            period: p.period.clone(),
        })
    };
    PlayOffer {
        available: true,
        month: price(SUBSCRIPTION, Some(MONTHLY), Some("P1M")),
        year: price(SUBSCRIPTION, Some(YEARLY), Some("P1Y")),
        five_years: price(FIVE_YEARS, None, None),
        suspended,
    }
}

/// What to do after Play's sheet closed.
#[cfg(any(test, play))]
#[derive(Debug, PartialEq)]
pub(super) enum AfterBuy {
    /// Paid (true) or waiting for a slow payment: the server verifies this token.
    Verify(String, bool),
    /// Nothing was bought; the purchase is forgotten.
    Forget(PlayState),
    /// Owned already by this Google account: a purchase kept here is verified again, if one is.
    Owned,
    /// Play answered, but not about this purchase: kept, and looked for on the way back.
    Keep(PlayState),
}

#[cfg(any(test, play))]
pub(super) fn after_buy(bought: &native::Bought, id: &str) -> AfterBuy {
    use native::Outcome;
    match bought.outcome {
        Outcome::Purchased | Outcome::Pending => match bought.purchases.iter().find(|p| p.account_id.as_deref() == Some(id)) {
            Some(purchase) => AfterBuy::Verify(purchase.token.clone(), purchase.state == native::PurchaseState::Purchased),
            None => AfterBuy::Keep(PlayState::Error),
        },
        Outcome::Canceled => AfterBuy::Forget(PlayState::Canceled),
        Outcome::Unavailable => AfterBuy::Forget(PlayState::Unavailable),
        Outcome::AlreadyOwned => AfterBuy::Owned,
        Outcome::Error => AfterBuy::Keep(PlayState::Error),
    }
}

/// Owned already, and not by a purchase made here: the Google account bought Supporter for a
/// Koona Pin account. A suspended subscription is fixed in Google Play; the plan of the account
/// signed in here, checked just now, is that account's; otherwise signing in to the account that
/// owns it shows the plan. Only the server says it is another account's (`other_account`).
pub(super) fn owned_elsewhere(has_plan: bool, suspended: bool) -> PlayState {
    if suspended {
        PlayState::Suspended
    } else if has_plan {
        PlayState::Paid
    } else {
        PlayState::Owned
    }
}

/// A Play call that ends after `limit` at the latest. The call goes on by itself: its late answer
/// is taken and dropped, never left to a caller that is gone.
#[cfg(any(test, play))]
async fn within<T: Send + 'static>(
    limit: std::time::Duration,
    call: impl std::future::Future<Output = Result<T, native::Error>> + Send + 'static,
) -> Result<T, native::Error> {
    let (answer, answered) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let _ = answer.send(call.await);
    });
    match tokio::time::timeout(limit, answered).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(native::Error::Failed("Google Play's call ended without an answer".into())),
        Err(_) => Err(native::Error::Failed("Google Play did not answer in time".into())),
    }
}

// ── Network ──────────────────────────────────────────────────────────────────

/// Asks the server about the purchase with this secret, with the session here if there is one.
async fn verify(app: &AppHandle, secret: &str) -> Result<Option<PlayState>, CommandError> {
    let billing = app.state::<Billing>();
    let Some(checkout) = billing.get().play.into_iter().find(|c| c.secret == secret) else {
        return Ok(None);
    };
    let Some(token) = checkout.token.clone() else {
        return Ok(checkout.state);
    };
    let signed_in = billing.get().session.map(|s| s.email);
    let bearer = match ask_for(&checkout, signed_in.as_deref()) {
        Ask::Skip => return Ok(checkout.state),
        Ask::WithoutSession => None,
        Ask::WithSession => access_token(app).await?,
    };
    let asked_for = bearer.as_ref().and(signed_in);
    let body = json!({ "action": "play_verify", "token": token, "product": checkout.product, "claim": checkout.secret });
    let asked_at = Utc::now();
    let (status, value) = call(app, body, bearer.as_deref()).await?;
    let verdict = verdict(status, &value)?;
    let mut state = None;
    billing.update(app, |s| state = s.take_play_answer(secret, verdict, asked_for.as_deref(), &plan_key(), asked_at))?;
    Ok(state)
}

/// After a sign-in by code: every purchase waiting here is verified with the new session, which
/// binds it to the account. Best effort: one that fails is asked about again on the way back.
pub(super) async fn verify_waiting(app: &AppHandle) {
    let billing = app.state::<Billing>();
    if billing.get().play.iter().all(|c| c.token.is_none()) {
        return;
    }
    let _one = billing.playing.lock().await;
    let secrets: Vec<String> = billing.get().play.iter().filter(|c| c.token.is_some()).map(|c| c.secret.clone()).collect();
    for secret in secrets {
        if let Err(error) = verify(app, &secret).await {
            eprintln!("Koona Pin: a Play purchase could not be verified after the sign-in: {}", error.message);
        }
    }
}

fn invalid_email() -> CommandError {
    CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::InvalidEmail, "The email address does not look right")
}

/// What `play_email` said.
#[derive(Debug, PartialEq)]
pub(super) enum EmailAnswer {
    /// The email is kept for the purchase; the app sends the code.
    Code,
    /// The purchase is not there, or not this app's (404 `claim`).
    Gone,
    /// The server does not sell through Google Play now (404 `play`).
    Unavailable,
}

/// The server's answer to `play_email`: 400 `email` a bad address, 429 `email_changes` more than
/// five emails for one purchase, 404 `claim` or `play`.
pub(super) fn email_answer(status: reqwest::StatusCode, value: &Value) -> Result<EmailAnswer, CommandError> {
    match status.as_u16() {
        404 if value["error"] == "play" => Ok(EmailAnswer::Unavailable),
        404 => Ok(EmailAnswer::Gone),
        429 => Err(CommandError::detailed(ErrorCode::Network, ErrorDetail::TooManyMessages, "Too many emails for this purchase")),
        400 | 422 => Err(invalid_email()),
        _ if status.is_success() && value["status"] == "code" => Ok(EmailAnswer::Code),
        _ => Err(refused("billing play_email", status)),
    }
}

/// «Continue» on the email step: the purchase waiting for an email gets this one, an account is
/// made for it if none has it, and the code is sent there. `sign_in` then: the sheet asks for the
/// code and `verify_sign_in_code` binds the purchase. `invalid` when the purchase is gone.
/// Registered in the Play build only (ipc.rs), like the other Play commands.
#[tauri::command]
pub async fn play_claim_email(app: AppHandle, email: String) -> Result<PlayState, CommandError> {
    need_service()?;
    let email = email.trim().to_string();
    if !crate::feedback::email_shape(&email) {
        return Err(invalid_email());
    }
    let billing = app.state::<Billing>();
    let _one = billing.playing.lock().await;
    let Some(checkout) = billing.get().claimable().cloned() else {
        return Ok(PlayState::Invalid);
    };
    let body = json!({ "action": "play_email", "token": checkout.token, "claim": checkout.secret, "email": email });
    let (status, value) = call(&app, body, None).await?;
    match email_answer(status, &value)? {
        EmailAnswer::Gone => {
            billing.update(&app, |s| s.finish_play(&checkout.secret, PlayState::Invalid))?;
            return Ok(PlayState::Invalid);
        }
        EmailAnswer::Unavailable => return Ok(PlayState::Unavailable),
        EmailAnswer::Code => {}
    }
    billing.update(&app, |s| {
        if let Some(kept) = s.play.iter_mut().find(|c| c.secret == checkout.secret) {
            kept.email = Some(email.clone());
            kept.state = Some(PlayState::SignIn);
        }
    })?;
    super::email_code(&app, &email).await?;
    Ok(PlayState::SignIn)
}

/// A fresh purchase kept here before Play's sheet opens, with the account signed in (`account`): a
/// payment whose answer never reaches the app (the process ended) is still found by its account id
/// on the next start.
fn started(interval: PlanInterval, account: Option<String>, now: DateTime<Utc>) -> PlayCheckout {
    let (product, base_plan) = product_of(interval);
    PlayCheckout {
        secret: new_secret(),
        product: product.to_string(),
        base_plan: base_plan.map(str::to_string),
        token: None,
        email: None,
        started: now,
        state: None,
        asked_at: None,
        account,
        paid_at: None,
    }
}

// ── The Play build ───────────────────────────────────────────────────────────

#[cfg(play)]
pub use commands::*;

#[cfg(play)]
mod commands {
    use super::*;
    use tauri::Wry;

    /// The plugin, as an owned handle a call can carry past its caller.
    fn plugin(app: &AppHandle) -> Result<native::KoonaPlay<Wry>, CommandError> {
        app.try_state::<native::KoonaPlay<Wry>>()
            .map(|play| play.inner().clone())
            .ok_or_else(|| CommandError::internal("The Play plugin is not registered"))
    }

    fn failed(error: native::Error) -> CommandError {
        CommandError::detailed(ErrorCode::Network, ErrorDetail::ServiceFailed, error.to_string())
    }

    /// What this Google account owns, within [`ASK_WAIT`].
    async fn owned(play: &native::KoonaPlay<Wry>) -> Result<Vec<native::Purchase>, native::Error> {
        let play = play.clone();
        within(ASK_WAIT, async move { play.purchases().await }).await
    }

    /// The prices for the sheet, from Google Play, and whether this Google account's subscription
    /// is suspended (what Play says it owns; unknown reads as not), so the sheet opens on «Fix
    /// payment in Google Play».
    #[tauri::command]
    pub async fn get_play_offer(app: AppHandle) -> Result<PlayOffer, CommandError> {
        let play = plugin(&app)?;
        let asked = play.clone();
        let products = within(ASK_WAIT, async move { asked.products(&[SUBSCRIPTION], &[FIVE_YEARS]).await }).await;
        match products {
            Ok(products) => Ok(offer_of(&products, owned(&play).await.is_ok_and(|owned| suspended_of(&owned)))),
            Err(native::Error::Unavailable(_)) => Ok(PlayOffer::default()),
            Err(error) => Err(failed(error)),
        }
    }

    /// «Subscribe» or «Buy»: Play's sheet for this plan, then the server's verdict on the purchase.
    /// `paid` signed in; `email` signed out (the sheet asks for one); `owned` when Google Play owns
    /// Supporter for an account and nobody is signed in here; `suspended` when that subscription is
    /// on hold or paused.
    #[tauri::command]
    pub async fn start_play_purchase(app: AppHandle, interval: PlanInterval) -> Result<PlayState, CommandError> {
        need_service()?;
        let play = plugin(&app)?;
        let billing = app.state::<Billing>();
        let _one = billing.playing.lock().await;
        let checkout = started(interval, billing.get().session.map(|s| s.email), Utc::now());
        let secret = checkout.secret.clone();
        let id = account_id(&secret);
        billing.update(&app, |s| s.add_play(checkout.clone()))?;
        let (product, base_plan, account) = (checkout.product.clone(), checkout.base_plan.clone(), id.clone());
        let bought = within(BUY_WAIT, async move { play.buy(&product, base_plan.as_deref(), &account).await }).await;
        let bought = match bought {
            Ok(bought) => bought,
            // Nothing can be bought here: forgotten.
            Err(native::Error::Unavailable(_)) => {
                billing.update(&app, |s| s.finish_play(&secret, PlayState::Unavailable))?;
                return Ok(PlayState::Unavailable);
            }
            // No answer, or one that did not read: kept, and found by its account id on the way back.
            Err(error) => return Err(failed(error)),
        };
        match after_buy(&bought, &id) {
            AfterBuy::Verify(token, paid) => {
                billing.update(&app, |s| {
                    s.find_play([(token.as_str(), Some(id.as_str()), paid)], Utc::now());
                })?;
                Ok(verify(&app, &secret).await?.unwrap_or(PlayState::Error))
            }
            AfterBuy::Forget(state) => {
                billing.update(&app, |s| s.finish_play(&secret, state))?;
                Ok(state)
            }
            AfterBuy::Keep(state) => Ok(state),
            AfterBuy::Owned => {
                // Nothing was bought now. A purchase made here before is verified again.
                let mut found = Vec::new();
                billing.update(&app, |s| {
                    s.play.retain(|c| c.secret != secret);
                    found = s.find_play(bought.purchases.iter().map(|p| (p.token.as_str(), p.account_id.as_deref(), p.state == native::PurchaseState::Purchased)), Utc::now());
                })?;
                if let Some(earlier) = found.last() {
                    return Ok(verify(&app, earlier).await?.unwrap_or(PlayState::Error));
                }
                // Signed in: the account's own plan, asked now, may be what this Google account owns.
                if billing.get().session.is_some() {
                    let _ = super::super::check(&app, false).await;
                }
                let has_plan = super::super::effective(&billing.get(), Utc::now()).is_some();
                let state = owned_elsewhere(has_plan, suspended_of(&bought.purchases));
                billing.update(&app, |s| s.play_outcome = Some(state))?;
                Ok(state)
            }
        }
    }

    /// «Try again» after the server could not be asked: the purchases kept here are asked about
    /// again now, without Play's sheet. The state of the newest one, or how it finished.
    #[tauri::command]
    pub async fn retry_play_purchase(app: AppHandle) -> Result<PlayState, CommandError> {
        need_service()?;
        resume(&app, None, true).await?;
        Ok(app.state::<Billing>().get().play_progress().map_or(PlayState::Error, |p| p.state))
    }

    /// Looks for this app's purchases on start and each time the app comes back to the screen, and
    /// whenever Play reports one outside the sheet.
    pub(in crate::billing) fn watch(app: &AppHandle) {
        let Ok(play) = plugin(app) else {
            return;
        };
        let reported = app.clone();
        let registered = play.on_purchases(move |bought| {
            let app = reported.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = resume(&app, Some(bought.purchases), false).await {
                    eprintln!("Koona Pin: a purchase Play reported could not be verified: {}", error.message);
                }
            });
        });
        if let Err(error) = registered {
            eprintln!("Koona Pin: Play's purchases event is not heard: {error}");
        }
        let app = app.clone();
        let mut foreground = crate::lifecycle::foreground(&app);
        tauri::async_runtime::spawn(async move {
            loop {
                foreground.wait().await;
                if let Err(error) = resume(&app, None, false).await {
                    eprintln!("Koona Pin: Play purchases could not be verified: {}", error.message);
                }
                foreground.suspended().await;
            }
        });
    }

    /// Every purchase kept here: Play's tokens matched to their secrets (`reported` by the event,
    /// else everything Play lists, which also drops a slow payment Play no longer has), then each
    /// one with a token verified, unless asked about seconds ago and not `now`.
    async fn resume(app: &AppHandle, reported: Option<Vec<native::Purchase>>, now: bool) -> Result<(), CommandError> {
        let billing = app.state::<Billing>();
        billing.update(app, |s| s.forget_old_play(Utc::now()))?;
        if billing.get().play.is_empty() {
            return Ok(());
        }
        let _one = billing.playing.lock().await;
        let listed = reported.is_none();
        let purchases = match reported {
            Some(purchases) => purchases,
            None => owned(&plugin(app)?).await.map_err(failed)?,
        };
        billing.update(app, |s| {
            s.find_play(purchases.iter().map(|p| (p.token.as_str(), p.account_id.as_deref(), p.state == native::PurchaseState::Purchased)), Utc::now());
            if listed {
                s.forget_unlisted(&purchases.iter().map(|p| p.token.as_str()).collect::<Vec<_>>());
            }
        })?;
        let at = Utc::now();
        let due: Vec<String> = billing
            .get()
            .play
            .iter()
            .filter(|c| c.token.is_some() && (now || c.asked_at.is_none_or(|asked| asked > at || at - asked >= FRESH)))
            .map(|c| c.secret.clone())
            .collect();
        for secret in due {
            verify(app, &secret).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::{status, Lease, Session};
    use super::*;

    fn at(text: &str) -> DateTime<Utc> {
        text.parse().unwrap()
    }

    fn checkout(secret: &str, started: &str) -> PlayCheckout {
        PlayCheckout {
            secret: secret.into(),
            product: SUBSCRIPTION.into(),
            base_plan: Some(MONTHLY.into()),
            token: None,
            email: None,
            started: at(started),
            state: None,
            asked_at: None,
            account: None,
            paid_at: None,
        }
    }

    fn verdict_of(status: u16, value: Value) -> Result<Verdict, CommandError> {
        verdict(reqwest::StatusCode::from_u16(status).unwrap(), &value)
    }

    fn state(status: &str) -> Verdict {
        verdict_of(200, json!({ "status": status })).unwrap()
    }

    fn anna() -> Session {
        Session { access_token: "a".into(), refresh_token: "r".into(), expires_at: 0, email: "anna@example.com".into() }
    }

    /// A lease as koona-services signs it, with a test key, and that key.
    fn lease(store: &str) -> (Lease, Vec<u8>) {
        use base64::Engine;
        use ring::signature::KeyPair;
        let payload = format!(
            r#"{{"v":1,"email":"anna@example.com","plan":{{"plan":"supporter","status":"active","interval":"month","valid_until":"2026-11-20T00:00:00.000Z","renews_at":"2026-11-20T00:00:00.000Z","store":{store}}},"issued_at":"2026-10-20T12:00:00.000Z","offline_until":"2026-11-19T12:00:00.000Z"}}"#
        );
        let pair = ring::signature::Ed25519KeyPair::from_seed_unchecked(&[9; 32]).unwrap();
        let signature = base64::engine::general_purpose::STANDARD.encode(pair.sign(payload.as_bytes()).as_ref());
        (Lease { payload, signature }, pair.public_key().as_ref().to_vec())
    }

    #[test]
    fn the_lease_says_where_the_plan_is_paid() {
        use super::super::{plan_of, Store};
        for (store, expected) in [("\"play\"", Some(Store::Play)), ("\"paddle\"", Some(Store::Paddle)), ("null", None), ("\"app_store\"", None)] {
            let (signed, key) = lease(store);
            let plan = plan_of(&signed, "anna@example.com", &key).expect("a store this build does not know keeps the plan");
            assert_eq!(plan.store, expected, "{store}");
        }
        let shown = serde_json::to_value(plan_of(&lease("null").0, "anna@example.com", &lease("null").1).unwrap()).unwrap();
        assert!(shown.get("store").is_none(), "none is left out for the page: `store?: Store`");
    }

    #[test]
    fn the_account_id_is_the_hex_sha256_of_the_secret() {
        assert_eq!(account_id("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let id = account_id(&new_secret());
        assert_eq!(id.len(), 64, "Play takes at most 64 characters");
        assert!(id.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn each_plan_is_a_product_of_play() {
        assert_eq!(product_of(PlanInterval::Month), ("supporter", Some("monthly")));
        assert_eq!(product_of(PlanInterval::Year), ("supporter", Some("yearly")));
        assert_eq!(product_of(PlanInterval::FiveYears), ("supporter_5_years", None));
        let fresh = started(PlanInterval::FiveYears, Some("anna@example.com".into()), at("2026-10-20T12:00:00Z"));
        assert_eq!((fresh.product.as_str(), fresh.base_plan, fresh.token, fresh.state), ("supporter_5_years", None, None, None));
        assert_eq!(fresh.secret.len(), 64);
    }

    #[test]
    fn the_servers_answers_are_play_states() {
        for (name, expected) in [
            ("paid", PlayState::Paid),
            ("already_supporter", PlayState::AlreadySupporter),
            ("email", PlayState::Email),
            // Bound to an account, asked without a session: never the code step, no code was sent.
            ("sign_in", PlayState::Owned),
            ("suspended", PlayState::Suspended),
            ("pending", PlayState::Pending),
            ("other_account", PlayState::OtherAccount),
            ("invalid", PlayState::Invalid),
        ] {
            assert_eq!(state(name).state, expected, "{name}");
        }
        assert!(state("paid").answer.is_some() && state("already_supporter").answer.is_some(), "both carry the plan");
        assert!(state("suspended").answer.is_some(), "so does a suspended one, often none");
        // The server does not sell through Google Play: unavailable, not invalid.
        assert_eq!(verdict_of(404, json!({ "error": "play" })).unwrap().state, PlayState::Unavailable);
        assert!(state("email").answer.is_none());
        // The claim refused: the purchase is not this app's.
        assert_eq!(verdict_of(403, json!({ "error": "claim" })).unwrap().state, PlayState::Invalid);
        assert_eq!(verdict_of(404, json!({ "error": "claim" })).unwrap().state, PlayState::Invalid);
        // Anything else says nothing about the purchase: it stays and is asked about again.
        assert!(verdict_of(403, json!({ "error": "forbidden" })).is_err());
        assert!(verdict_of(429, json!({})).is_err());
        assert!(verdict_of(200, json!({ "status": "something_new" })).is_err());
        assert!(verdict_of(200, json!("<html>")).is_err());
    }

    #[test]
    fn a_purchase_waits_until_bound_invalid_or_old() {
        let key = plan_key();
        let mut stored = Stored::default();
        stored.add_play(checkout("s1", "2026-10-20T12:00:00Z"));
        let now = at("2026-10-20T12:05:00Z");
        for waiting in ["pending", "email", "sign_in"] {
            assert!(stored.take_play_answer("s1", state(waiting), None, &key, now).is_some());
            assert_eq!(stored.play.len(), 1, "{waiting}: kept");
        }
        assert_eq!(stored.play_progress(), Some(PlayProgress { state: PlayState::Owned, email: None }));
        // The server cannot verify Play purchases now: kept as it was, asked again later.
        let unset = verdict_of(404, json!({ "error": "play" })).unwrap();
        assert_eq!(stored.take_play_answer("s1", unset, None, &key, now), Some(PlayState::Unavailable));
        assert_eq!(stored.play.len(), 1);
        assert_eq!(stored.play_progress().map(|p| p.state), Some(PlayState::Owned));
        for done in ["invalid", "other_account", "suspended"] {
            let mut finished = stored.clone();
            assert_eq!(finished.take_play_answer("s1", state(done), None, &key, now), Some(state(done).state));
            assert!(finished.play.is_empty(), "{done}: forgotten");
            assert_eq!(finished.play_progress().map(|p| p.state), Some(state(done).state), "and shown as the outcome");
        }
        // Four days after the server first said it was paid (an email asked for), Play has refunded it.
        stored.forget_old_play(at("2026-10-24T12:05:00Z"));
        assert_eq!(stored.play.len(), 1);
        stored.forget_old_play(at("2026-10-24T12:05:01Z"));
        assert!(stored.play.is_empty());
        // An answer for a purchase no longer here changes nothing.
        assert_eq!(stored.take_play_answer("s1", state("paid"), None, &key, now), None);
        assert_eq!(stored.play_outcome, None);
    }

    #[test]
    fn a_bound_purchase_brings_its_plan_for_the_account_it_was_asked_for() {
        let (signed, key) = lease("\"play\"");
        let paid = || Verdict { state: PlayState::Paid, answer: Some(Answer { has_plan: true, lease: Some(signed.clone()) }) };
        let now = at("2026-10-20T12:05:00Z");
        let mut stored = Stored { session: Some(anna()), ..Stored::default() };
        stored.add_play(checkout("s1", "2026-10-20T12:00:00Z"));
        assert_eq!(stored.take_play_answer("s1", paid(), Some("anna@example.com"), &key, now), Some(PlayState::Paid));
        assert!(stored.play.is_empty(), "bound: the secret is not needed any more");
        let plan = stored.plan.clone().expect("the plan is here");
        assert_eq!(plan.store, Some(super::super::Store::Play));
        assert_eq!(stored.checked_at, Some(now));
        assert_eq!(status(&stored, now).play, Some(PlayProgress { state: PlayState::Paid, email: None }));
        // Signed out, or another account signed in, while the server answered: no plan for them.
        for session in [None, Some(Session { email: "bob@example.com".into(), ..anna() })] {
            let mut other = Stored { session, ..Stored::default() };
            other.add_play(checkout("s1", "2026-10-20T12:00:00Z"));
            other.take_play_answer("s1", paid(), Some("anna@example.com"), &key, now);
            assert!(other.plan.is_none() && other.lease.is_none());
        }
        // Already a Supporter: the plan they have, and Play refunds this purchase.
        let mut again = Stored { session: Some(anna()), ..Stored::default() };
        again.add_play(checkout("s2", "2026-10-20T12:00:00Z"));
        let refunded = Verdict { state: PlayState::AlreadySupporter, answer: Some(Answer { has_plan: true, lease: Some(signed.clone()) }) };
        assert_eq!(again.take_play_answer("s2", refunded, Some("anna@example.com"), &key, now), Some(PlayState::AlreadySupporter));
        assert!(again.play.is_empty() && again.plan.is_some());
    }

    #[test]
    fn after_an_email_is_given_the_purchase_waits_for_its_code() {
        let mut stored = Stored::default();
        stored.add_play(PlayCheckout { token: Some("t1".into()), ..checkout("s1", "2026-10-20T12:00:00Z") });
        let now = at("2026-10-20T12:05:00Z");
        stored.take_play_answer("s1", state("email"), None, &plan_key(), now);
        assert_eq!(stored.claimable().map(|c| c.secret.as_str()), Some("s1"));
        assert_eq!(stored.play_progress(), Some(PlayProgress { state: PlayState::Email, email: None }));
        stored.play[0].email = Some("anna@example.com".into());
        stored.play[0].state = Some(PlayState::SignIn);
        // The app comes back from the mail app: the server still says `email` (nothing is bound
        // before the code), which must not send the sheet back to the email step.
        assert_eq!(stored.take_play_answer("s1", state("email"), None, &plan_key(), now), Some(PlayState::SignIn));
        assert_eq!(stored.play_progress(), Some(PlayProgress { state: PlayState::SignIn, email: Some("anna@example.com".into()) }));
        assert_eq!(stored.claimable().map(|c| c.secret.as_str()), Some("s1"), "another email can still be given");
        // A purchase Play never reported has nothing to claim.
        let mut unreported = Stored::default();
        unreported.add_play(PlayCheckout { state: Some(PlayState::Email), ..checkout("s2", "2026-10-20T12:00:00Z") });
        assert!(unreported.claimable().is_none());
    }

    #[test]
    fn plays_purchases_are_matched_to_the_secrets_kept_here() {
        let mut stored = Stored::default();
        stored.add_play(checkout("s1", "2026-10-20T12:00:00Z"));
        stored.add_play(checkout("s2", "2026-10-20T12:01:00Z"));
        let s2 = account_id("s2");
        let found = stored.find_play([("t-other", Some(account_id("x").as_str()), true), ("t-none", None, true), ("t2", Some(s2.as_str()), false)], at("2026-10-20T12:05:00Z"));
        assert_eq!(found, ["s2"]);
        assert_eq!(stored.play[1].token.as_deref(), Some("t2"));
        assert_eq!(stored.play[0].token, None);
    }

    #[test]
    fn a_new_purchase_keeps_the_paid_ones_first() {
        let mut stored = Stored { play_outcome: Some(PlayState::Canceled), ..Stored::default() };
        stored.add_play(PlayCheckout { token: Some("paid".into()), ..checkout("paid", "2026-10-20T11:00:00Z") });
        for i in 0..MAX_KEPT + 2 {
            stored.add_play(checkout(&format!("s{i}"), "2026-10-20T12:00:00Z"));
        }
        assert_eq!(stored.play.len(), MAX_KEPT);
        assert_eq!(stored.play[0].secret, "paid", "one Play may have charged stays");
        assert_eq!(stored.play.last().unwrap().secret, format!("s{}", MAX_KEPT + 1));
        assert_eq!(stored.play_outcome, None, "a new purchase clears the last outcome");
    }

    #[test]
    fn purchases_survive_in_the_file_and_sign_out() {
        let mut stored = Stored { session: Some(anna()), ..Stored::default() };
        stored.add_play(PlayCheckout { token: Some("t1".into()), email: Some("anna@example.com".into()), state: Some(PlayState::SignIn), ..checkout("s1", "2026-10-20T12:00:00Z") });
        stored.play_outcome = Some(PlayState::Paid);
        let text = serde_json::to_string(&stored).unwrap();
        let read: Stored = serde_json::from_str(&text).unwrap();
        assert_eq!(read.play, stored.play);
        assert_eq!(read.play_outcome, None, "the outcome is this run's only");
        // As sign_out_supporter resets the file.
        let mut signed_out = stored.clone();
        signed_out = Stored { sandbox: signed_out.sandbox, play: std::mem::take(&mut signed_out.play), ..Stored::default() };
        assert!(signed_out.session.is_none());
        assert_eq!(signed_out.play, stored.play);
        // A file from before NP-154 reads with none.
        let old: Stored = serde_json::from_value(json!({ "session": null })).unwrap();
        assert!(old.play.is_empty());
    }

    #[test]
    fn plays_products_are_the_sheets_prices() {
        let product = |id: &str, base_plan: Option<&str>, price: &str, micros: i64, period: Option<&str>| native::Product {
            product: id.into(),
            base_plan: base_plan.map(Into::into),
            price: price.into(),
            currency: "EUR".into(),
            micros,
            period: period.map(Into::into),
        };
        let offer = offer_of(
            &[
            product("supporter", Some("yearly"), "€20.00", 20_000_000, Some("P1Y")),
            product("supporter", Some("monthly"), "€2.00", 2_000_000, Some("P1M")),
            product("supporter", Some("weekly"), "€1.00", 1_000_000, Some("P1W")),
            product("supporter_5_years", None, "€50.00", 50_000_000, None),
            ],
            false,
        );
        assert!(offer.available && !offer.suspended);
        assert_eq!(offer.month.as_ref().map(|p| (p.price.as_str(), p.period.as_deref())), Some(("€2.00", Some("P1M"))));
        assert_eq!(offer.year.as_ref().map(|p| p.micros), Some(20_000_000));
        assert_eq!(offer.five_years.as_ref().map(|p| p.period.clone()), Some(None));
        // A plan Play does not sell is none; no Play at all, nothing.
        assert_eq!(offer_of(&[product("supporter", Some("monthly"), "€2.00", 2_000_000, Some("P1M"))], false).year, None);
        assert!(!PlayOffer::default().available && !PlayOffer::default().suspended);
        assert!(offer_of(&[], true).suspended);
        // A base plan whose period is not what its card says is not offered.
        let quarterly = offer_of(&[product("supporter", Some("monthly"), "€5.00", 5_000_000, Some("P3M")), product("supporter", Some("yearly"), "€20.00", 20_000_000, Some("P6M"))], false);
        assert_eq!((quarterly.month, quarterly.year), (None, None));
    }

    #[test]
    fn plays_sheet_closing_decides_what_comes_next() {
        use native::{Bought, Outcome, Purchase, PurchaseState};
        let id = account_id("s1");
        let purchase = |token: &str, account: Option<&str>, state: PurchaseState| Purchase {
            token: token.into(),
            products: vec!["supporter".into()],
            state,
            acknowledged: false,
            suspended: false,
            account_id: account.map(Into::into),
        };
        let bought = |outcome, purchases| Bought { outcome, purchases };
        assert_eq!(
            after_buy(&bought(Outcome::Purchased, vec![purchase("other", None, PurchaseState::Purchased), purchase("t1", Some(&id), PurchaseState::Purchased)]), &id),
            AfterBuy::Verify("t1".into(), true)
        );
        assert_eq!(after_buy(&bought(Outcome::Pending, vec![purchase("t1", Some(&id), PurchaseState::Pending)]), &id), AfterBuy::Verify("t1".into(), false));
        assert_eq!(after_buy(&bought(Outcome::Purchased, vec![purchase("t9", Some("someone"), PurchaseState::Purchased)]), &id), AfterBuy::Keep(PlayState::Error));
        assert_eq!(after_buy(&bought(Outcome::Canceled, vec![]), &id), AfterBuy::Forget(PlayState::Canceled));
        assert_eq!(after_buy(&bought(Outcome::Unavailable, vec![]), &id), AfterBuy::Forget(PlayState::Unavailable));
        assert_eq!(after_buy(&bought(Outcome::AlreadyOwned, vec![]), &id), AfterBuy::Owned);
        assert_eq!(after_buy(&bought(Outcome::Error, vec![]), &id), AfterBuy::Keep(PlayState::Error));
        assert_eq!(owned_elsewhere(true, false), PlayState::Paid, "the plan of the account signed in, checked just now");
        assert_eq!(owned_elsewhere(false, false), PlayState::Owned);
        assert_eq!(owned_elsewhere(false, true), PlayState::Suspended);
        assert_eq!(owned_elsewhere(true, true), PlayState::Suspended);
        // Suspended: the subscription, on hold or paused; never five years paid once.
        let held = |products: &[&str], suspended| Purchase { products: products.iter().map(|p| p.to_string()).collect(), suspended, ..purchase("t", None, PurchaseState::Purchased) };
        assert!(suspended_of(&[held(&["supporter"], false), held(&["supporter"], true)]));
        assert!(!suspended_of(&[held(&["supporter"], false)]));
        assert!(!suspended_of(&[held(&["supporter_5_years"], true)]));
        assert!(!suspended_of(&[]));
    }

    #[test]
    fn the_email_steps_answers() {
        let answer = |status: u16, value: Value| email_answer(reqwest::StatusCode::from_u16(status).unwrap(), &value);
        assert_eq!(answer(200, json!({ "status": "code" })).unwrap(), EmailAnswer::Code);
        assert_eq!(answer(404, json!({ "error": "claim" })).unwrap(), EmailAnswer::Gone);
        assert_eq!(answer(404, json!({ "error": "play" })).unwrap(), EmailAnswer::Unavailable);
        assert_eq!(answer(400, json!({ "error": "email" })).unwrap_err().detail, Some(ErrorDetail::InvalidEmail));
        assert_eq!(answer(429, json!({ "error": "email_changes" })).unwrap_err().detail, Some(ErrorDetail::TooManyMessages));
        assert!(answer(200, json!({ "status": "something_new" })).is_err());
        assert!(answer(502, json!(null)).is_err());
    }

    #[test]
    fn plays_three_days_run_from_the_payment_and_a_slow_payment_waits_for_its_answer() {
        let key = plan_key();
        let mut stored = Stored::default();
        // Day 0: Play's sheet opened, the payment slow; Play reported it pending.
        stored.add_play(checkout("slow", "2026-10-20T12:00:00Z"));
        stored.find_play([("t-slow", Some(account_id("slow").as_str()), false)], at("2026-10-20T12:01:00Z"));
        stored.take_play_answer("slow", state("pending"), None, &key, at("2026-10-20T12:02:00Z"));
        assert_eq!(stored.play[0].paid_at, None);
        // Day 30: still pending, still kept.
        stored.forget_old_play(at("2026-11-19T12:00:00Z"));
        assert_eq!(stored.play.len(), 1, "a slow payment has no age limit");
        // Day 3: the payment went through; the server asks for an email. Kept until day 7.
        let mut paid = stored.clone();
        paid.take_play_answer("slow", state("email"), None, &key, at("2026-10-23T12:00:00Z"));
        assert_eq!(paid.play[0].paid_at, Some(at("2026-10-23T12:00:00Z")));
        paid.forget_old_play(at("2026-10-27T12:00:00Z"));
        assert_eq!(paid.play.len(), 1, "day 7");
        paid.forget_old_play(at("2026-10-27T12:00:01Z"));
        assert!(paid.play.is_empty(), "then Play has refunded it");
        // Play reporting it purchased starts the three days too.
        let mut reported = stored.clone();
        reported.find_play([("t-slow", Some(account_id("slow").as_str()), true)], at("2026-10-22T09:00:00Z"));
        assert_eq!(reported.play[0].paid_at, Some(at("2026-10-22T09:00:00Z")));
        reported.find_play([("t-slow", Some(account_id("slow").as_str()), true)], at("2026-10-23T09:00:00Z"));
        assert_eq!(reported.play[0].paid_at, Some(at("2026-10-22T09:00:00Z")), "the first time counts");
        // Play no longer lists the pending purchase: cancelled before it was paid.
        let mut cancelled = stored.clone();
        cancelled.forget_unlisted(&["t-slow"]);
        assert_eq!(cancelled.play.len(), 1);
        cancelled.forget_unlisted(&["t-other"]);
        assert!(cancelled.play.is_empty());
        // A paid one, and one Play never reported, are not dropped by the list.
        let mut others = Stored::default();
        others.add_play(PlayCheckout { token: Some("t1".into()), paid_at: Some(at("2026-10-20T12:00:00Z")), ..checkout("paid", "2026-10-20T12:00:00Z") });
        others.add_play(checkout("unreported", "2026-10-20T12:00:00Z"));
        others.forget_unlisted(&[]);
        assert_eq!(others.play.len(), 2);
        // Never reported by Play: four days from the sheet.
        others.forget_old_play(at("2026-10-24T12:00:01Z"));
        assert!(others.play.is_empty());
        // The server's invalid (a slow payment cancelled) ends it at once.
        stored.take_play_answer("slow", state("invalid"), None, &key, at("2026-10-25T12:00:00Z"));
        assert!(stored.play.is_empty());
    }

    #[test]
    fn a_purchase_is_asked_about_only_with_the_session_of_its_account() {
        let started_by = |account: Option<&str>, email: Option<&str>| PlayCheckout {
            account: account.map(Into::into),
            email: email.map(Into::into),
            ..checkout("s1", "2026-10-20T12:00:00Z")
        };
        // Bought signed in as Anna: her session binds it; Bob's is never sent, nor asked with.
        let anna = started_by(Some("anna@example.com"), None);
        assert_eq!(ask_for(&anna, Some("Anna@Example.com")), Ask::WithSession);
        assert_eq!(ask_for(&anna, Some("bob@example.com")), Ask::Skip);
        assert_eq!(ask_for(&anna, None), Ask::WithoutSession, "signed out: only where it stands");
        // Bought signed out and claimed by an email: whoever proved the code for that email.
        let claimed = started_by(None, Some("bob@example.com"));
        assert_eq!(ask_for(&claimed, Some("bob@example.com")), Ask::WithSession);
        assert_eq!(ask_for(&claimed, Some("anna@example.com")), Ask::Skip);
        // An email given after an account switch is the one proved by its code.
        assert_eq!(ask_for(&started_by(Some("anna@example.com"), Some("bob@example.com")), Some("bob@example.com")), Ask::WithSession);
        // Bought signed out, not claimed: no session binds it; the email step does.
        let unclaimed = started_by(None, None);
        assert_eq!(ask_for(&unclaimed, Some("anna@example.com")), Ask::WithoutSession);
        assert_eq!(ask_for(&unclaimed, None), Ask::WithoutSession);
        // The account is kept in the file.
        let kept: PlayCheckout = serde_json::from_value(serde_json::to_value(&anna).unwrap()).unwrap();
        assert_eq!(kept.account.as_deref(), Some("anna@example.com"));
        // A file from before has none.
        let old: PlayCheckout = serde_json::from_value(json!({ "secret": "s", "product": "supporter", "base_plan": null, "token": null, "email": null, "started": "2026-10-20T12:00:00Z" })).unwrap();
        assert_eq!((old.account, old.paid_at), (None, None));
    }

    #[test]
    fn a_play_call_that_never_answers_ends_and_frees_the_caller() {
        tauri::async_runtime::block_on(async {
            let quick = within(std::time::Duration::from_secs(5), async { Ok::<_, native::Error>(7) }).await;
            assert_eq!(quick, Ok(7));
            let hung = within(std::time::Duration::from_millis(50), std::future::pending::<Result<u8, native::Error>>()).await;
            assert!(matches!(hung, Err(native::Error::Failed(ref message)) if message.contains("in time")), "{hung:?}");
            let refused = within(std::time::Duration::from_secs(5), async { Err::<u8, _>(native::Error::Unavailable("no Play".into())) }).await;
            assert_eq!(refused, Err(native::Error::Unavailable("no Play".into())));
        });
    }
}
