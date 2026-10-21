//! Supporter through Google Play Billing (NP-154): the Play build's purchase, after the owner's
//! flow B. The purchase comes first, made with a fresh secret whose SHA-256 is the purchase's
//! `obfuscatedAccountId`; the server (`billing`'s `play_verify`) checks the purchase with Google and
//! binds it to the account signed in here. Signed out, the person gives an email (`play_email`, an
//! account is made for it if none has it) and signs in with the code sent there; the purchase is
//! then verified again with that session, which binds it. Until it is bound Play does not have it
//! acknowledged, so a purchase nobody claims is refunded by Play three days after its payment.
//!
//! The secret is kept in `account.json` until the purchase is bound, found invalid (refunded,
//! expired, someone else's), refunded by Play for want of a claim, and over Sign out: it is the
//! purchase's only claim. Purchases are looked for on start and each time the app comes back to the
//! screen, and when Play reports one outside the sheet (a slow payment that completed).
//!
//! The steps talk to the app through two seams, [`Account`] (the stored state, the account service,
//! the session) and [`Store`] (Google Play), so they are tested with fakes on a desktop. Only the
//! Play build (`cfg(play)`: the feature `store-play` on Android) has the plugin and the commands.

// Outside the Play build only the sign-in's part (`verify_waiting`) runs; the rest is its tests'.
#![cfg_attr(not(play), allow(dead_code))]

use super::{new_secret, plan_key, refused, Answer, Billing, PlanInterval, Store as PlanStore, Stored};
use crate::error::{CommandError, ErrorCode, ErrorDetail};
use chrono::{DateTime, TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::future::Future;
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
    /// After Play's sheet, the purchase could not be confirmed now (the server out of reach or not
    /// verifying Play purchases, or Play's answer not this purchase's): it is kept and asked about
    /// again; «Try again» asks the server (`retry_play_purchase`), never Play's sheet.
    Kept,
    /// The account has Supporter already: Google Play refunds this purchase.
    AlreadySupporter,
    /// The purchase belongs to another Koona Pin account than the one signed in here.
    OtherAccount,
    /// The person closed Play's sheet.
    Canceled,
    /// Expired, refunded, cancelled before it was paid, or not this app's.
    Invalid,
    /// Before any payment: no Google Play here, a blocked one, or the product is not on sale.
    Unavailable,
    /// Play failed before a purchase was made.
    Error,
}

impl PlayState {
    /// Still waiting for the person or for Play: kept with its purchase and shown by the sheet.
    fn waiting(self) -> bool {
        matches!(self, PlayState::Email | PlayState::SignIn | PlayState::Owned | PlayState::Pending | PlayState::Kept)
    }
}

/// A Play purchase the sheet shows: the one it follows, waiting here or finished in this run.
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
    /// The email given for it, once the code was sent there.
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

impl PlayCheckout {
    /// May make room for a new purchase: never one that is paid, nor one that waits (for its email,
    /// its code, a slow payment, or a confirmation after a payment that may exist).
    fn evictable(&self) -> bool {
        self.paid_at.is_none() && !self.state.is_some_and(PlayState::waiting)
    }
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
    crate::hash::sha256_hex(secret.as_bytes())
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
    // The server does not verify Play purchases now (not set up): the purchase stays, unclaimed.
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
    /// Keeps a new purchase and follows it. Room is made from the oldest Play never reported, then
    /// the oldest unpaid one that waits for nothing; never from one that is paid or waits. False,
    /// and nothing changed, when not enough may make room: the one room check.
    pub(super) fn add_play(&mut self, checkout: PlayCheckout) -> bool {
        let excess = (self.play.len() + 1).saturating_sub(MAX_KEPT);
        let mut order: Vec<usize> = (0..self.play.len()).filter(|&i| self.play[i].evictable()).collect();
        if order.len() < excess {
            return false;
        }
        // Unreported first, each group oldest first; removed from the back, so the indexes hold.
        order.sort_by_key(|&i| (self.play[i].token.is_some(), i));
        let mut gone: Vec<usize> = order.into_iter().take(excess).collect();
        gone.sort_unstable_by(|a, b| b.cmp(a));
        for at in gone {
            self.play.remove(at);
        }
        self.play_outcome = None;
        self.play_followed = Some(checkout.secret.clone());
        self.play.push(checkout);
        true
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

    /// A purchase that left `play`, and how it finished: the outcome the sheet shows when it is the
    /// purchase followed (or none is), so an older one finishing never replaces it.
    fn finish_play(&mut self, secret: &str, state: PlayState) {
        self.play.retain(|c| c.secret != secret);
        if self.play_followed.as_deref().is_none_or(|followed| followed == secret) {
            self.play_outcome = Some((secret.to_string(), state));
        }
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
        // The server cannot verify Play purchases now: kept, shown as such, and asked again later. A
        // slow payment stays pending: nothing was paid yet.
        if state == PlayState::Unavailable {
            if checkout.state != Some(PlayState::Pending) {
                checkout.state = Some(PlayState::Kept);
            }
            return Some(PlayState::Kept);
        }
        if let (Some(answer), Some(email)) = (verdict.answer, asked_for) {
            if self.same_account(email) {
                self.take_answer(answer, key, at);
            }
        }
        self.finish_play(secret, state);
        Some(state)
    }

    /// What the sheet shows: the purchase it follows in this run, waiting or finished; with none
    /// followed (the app just started), the newest one waiting here.
    pub(super) fn play_progress(&self) -> Option<PlayProgress> {
        let shown = |c: &PlayCheckout| c.state.filter(|s| s.waiting()).map(|state| PlayProgress { state, email: c.email.clone() });
        if let Some(followed) = &self.play_followed {
            if let Some(checkout) = self.play.iter().find(|c| &c.secret == followed) {
                return shown(checkout);
            }
            return self.play_outcome.as_ref().filter(|(secret, _)| secret == followed).map(|(_, state)| PlayProgress { state: *state, email: None });
        }
        match self.play.iter().rev().find_map(shown) {
            Some(waiting) => Some(waiting),
            None => self.play_outcome.as_ref().map(|(_, state)| PlayProgress { state: *state, email: None }),
        }
    }

    /// The purchase the email is for: the one followed if it waits for an email or its code, else
    /// the newest one that does.
    fn claimable(&self) -> Option<&PlayCheckout> {
        let claimable = |c: &&PlayCheckout| c.token.is_some() && matches!(c.state, Some(PlayState::Email | PlayState::SignIn));
        self.play
            .iter()
            .find(|c| self.play_followed.as_deref() == Some(c.secret.as_str()))
            .filter(claimable)
            .or_else(|| self.play.iter().rev().find(claimable))
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
    /// Play said purchased, but not with this purchase: a payment may exist, so it is kept and
    /// looked for on the way back.
    Keep,
}

#[cfg(any(test, play))]
pub(super) fn after_buy(bought: &native::Bought, id: &str) -> AfterBuy {
    use native::Outcome;
    match bought.outcome {
        Outcome::Purchased | Outcome::Pending | Outcome::Error => match bought.purchases.iter().find(|p| p.account_id.as_deref() == Some(id)) {
            Some(purchase) => AfterBuy::Verify(purchase.token.clone(), purchase.state == native::PurchaseState::Purchased),
            // Play failed with no purchase of this one (its sheet refused or never opened): none exists.
            None if bought.outcome == Outcome::Error => AfterBuy::Forget(PlayState::Error),
            None => AfterBuy::Keep,
        },
        Outcome::Canceled => AfterBuy::Forget(PlayState::Canceled),
        Outcome::Unavailable => AfterBuy::Forget(PlayState::Unavailable),
        Outcome::AlreadyOwned => AfterBuy::Owned,
    }
}

/// Owned already, and not by a purchase made here: the Google account bought Supporter for a
/// Koona Pin account. A suspended subscription is fixed in Google Play. The account signed in here
/// is taken to be its owner only when its plan, checked just now, is paid through Google Play;
/// otherwise signing in to the account that owns it shows the plan. Only the server says it is
/// another account's (`other_account`).
pub(super) fn owned_elsewhere(plan_store: Option<PlanStore>, suspended: bool) -> PlayState {
    if suspended {
        PlayState::Suspended
    } else if plan_store == Some(PlanStore::Play) {
        PlayState::Paid
    } else {
        PlayState::Owned
    }
}

fn too_many() -> CommandError {
    CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::PurchasesWaiting, "Paid Google Play purchases are still waiting here")
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

// ── The seams ────────────────────────────────────────────────────────────────

/// What a Play purchase needs of the app: its stored state, the account service and the session.
pub(super) trait Account: Send + Sync {
    fn billing(&self) -> &Billing;
    /// Changes the stored state, writes it and tells the interface.
    fn update(&self, change: impl FnOnce(&mut Stored)) -> Result<(), CommandError>;
    /// A fresh access token of the session here; none signed out.
    fn token(&self) -> impl Future<Output = Result<Option<String>, CommandError>> + Send;
    /// One action of the `billing` function, with this bearer.
    fn ask(&self, body: Value, bearer: Option<String>) -> impl Future<Output = Result<(reqwest::StatusCode, Value), CommandError>> + Send;
    /// The sign-in code to this email.
    fn send_code(&self, email: String) -> impl Future<Output = Result<(), CommandError>> + Send;
    /// The plan of the account signed in, asked now.
    fn check_plan(&self) -> impl Future<Output = ()> + Send;
}

/// What a Play purchase needs of Google Play, each within its time limit.
#[cfg(any(test, play))]
pub(super) trait Store: Send + Sync {
    fn buy(&self, product: String, base_plan: Option<String>, account_id: String) -> impl Future<Output = Result<native::Bought, native::Error>> + Send;
    fn owned(&self) -> impl Future<Output = Result<Vec<native::Purchase>, native::Error>> + Send;
}

/// The app itself.
pub(super) struct Live<'a>(pub &'a AppHandle);

impl Account for Live<'_> {
    fn billing(&self) -> &Billing {
        self.0.state::<Billing>().inner()
    }

    fn update(&self, change: impl FnOnce(&mut Stored)) -> Result<(), CommandError> {
        self.billing().update(self.0, change).map(|_| ())
    }

    async fn token(&self) -> Result<Option<String>, CommandError> {
        super::access_token(self.0).await
    }

    async fn ask(&self, body: Value, bearer: Option<String>) -> Result<(reqwest::StatusCode, Value), CommandError> {
        super::call(self.0, body, bearer.as_deref()).await
    }

    async fn send_code(&self, email: String) -> Result<(), CommandError> {
        super::email_code(self.0, &email).await
    }

    async fn check_plan(&self) {
        let _ = super::check(self.0, false).await;
    }
}

/// A Play call that ends after `limit` at the latest. The call goes on by itself: its late answer
/// is taken and dropped, never left to a caller that is gone (Tauri's plugin call would panic).
#[cfg(any(test, play))]
async fn within<T: Send + 'static>(
    limit: std::time::Duration,
    call: impl Future<Output = Result<T, native::Error>> + Send + 'static,
) -> Result<T, native::Error> {
    let (answer, answered) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let _ = answer.send(call.await);
    });
    match tokio::time::timeout(limit, answered).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) | Err(_) => Err(native::Error::NoAnswer),
    }
}

// ── The steps ────────────────────────────────────────────────────────────────

/// Asks the server about the purchase with this secret, with the session of its account only.
async fn verify<A: Account>(account: &A, secret: &str) -> Result<Option<PlayState>, CommandError> {
    let stored = account.billing().get();
    let Some(checkout) = stored.play.into_iter().find(|c| c.secret == secret) else {
        return Ok(None);
    };
    let Some(token) = checkout.token.clone() else {
        return Ok(checkout.state);
    };
    let signed_in = stored.session.map(|s| s.email);
    let bearer = match ask_for(&checkout, signed_in.as_deref()) {
        Ask::Skip => return Ok(checkout.state),
        Ask::WithoutSession => None,
        Ask::WithSession => account.token().await?,
    };
    let asked_for = bearer.as_ref().and(signed_in);
    let body = json!({ "action": "play_verify", "token": token, "product": checkout.product, "claim": checkout.secret });
    let asked_at = Utc::now();
    let (status, value) = account.ask(body, bearer).await?;
    let verdict = verdict(status, &value)?;
    let mut state = None;
    account.update(|s| state = s.take_play_answer(secret, verdict, asked_for.as_deref(), &plan_key(), asked_at))?;
    Ok(state)
}

/// After a sign-in by code: every purchase waiting here is verified with the new session, which
/// binds those of its account. Best effort: one that fails is asked about again on the way back.
pub(super) async fn verify_waiting(app: &AppHandle) {
    verify_waiting_with(&Live(app)).await
}

async fn verify_waiting_with<A: Account>(account: &A) {
    let billing = account.billing();
    if billing.get().play.iter().all(|c| c.token.is_none()) {
        return;
    }
    let _one = billing.playing.lock().await;
    let secrets: Vec<String> = billing.get().play.iter().filter(|c| c.token.is_some()).map(|c| c.secret.clone()).collect();
    for secret in secrets {
        if let Err(error) = verify(account, &secret).await {
            eprintln!("Koona Pin: a Play purchase could not be verified after the sign-in: {}", error.message);
        }
    }
}

/// «Continue» on the email step: the purchase waiting for an email gets this one, an account is
/// made for it if none has it, and the code is sent there. `sign_in` then: the sheet asks for the
/// code and `verify_sign_in_code` binds the purchase. `invalid` when the purchase is gone; `kept`
/// when the server cannot verify Play purchases now. Registered in the Play build only (ipc.rs).
#[tauri::command]
pub async fn play_claim_email(app: AppHandle, email: String) -> Result<PlayState, CommandError> {
    super::need_service()?;
    claim_email(&Live(&app), email).await
}

async fn claim_email<A: Account>(account: &A, email: String) -> Result<PlayState, CommandError> {
    let email = email.trim().to_string();
    if !crate::feedback::email_shape(&email) {
        return Err(invalid_email());
    }
    let billing = account.billing();
    let _one = billing.playing.lock().await;
    let Some(checkout) = billing.get().claimable().cloned() else {
        return Ok(PlayState::Invalid);
    };
    let body = json!({ "action": "play_email", "token": checkout.token, "claim": checkout.secret, "email": email });
    let (status, value) = account.ask(body, None).await?;
    match email_answer(status, &value)? {
        EmailAnswer::Gone => {
            account.update(|s| s.finish_play(&checkout.secret, PlayState::Invalid))?;
            return Ok(PlayState::Invalid);
        }
        EmailAnswer::Unavailable => return Ok(PlayState::Kept),
        EmailAnswer::Code => {}
    }
    // Only a code that went out makes the code step: one that failed leaves the email step.
    account.send_code(email.clone()).await?;
    account.update(|s| {
        if let Some(kept) = s.play.iter_mut().find(|c| c.secret == checkout.secret) {
            kept.email = Some(email);
            kept.state = Some(PlayState::SignIn);
            s.play_followed = Some(checkout.secret.clone());
        }
    })?;
    Ok(PlayState::SignIn)
}

/// A purchase a payment may exist for, not confirmed now: kept, with its state saying so, so the
/// sheet shows it after a restart too; it is asked about again until the server answers.
fn keep<A: Account>(account: &A, secret: &str) -> Result<PlayState, CommandError> {
    account.update(|s| {
        if let Some(kept) = s.play.iter_mut().find(|c| c.secret == secret) {
            kept.state = Some(PlayState::Kept);
        }
    })?;
    Ok(PlayState::Kept)
}

/// After a payment the purchase is never lost to a failure: it is kept and asked about again.
fn kept_after_payment<A: Account>(account: &A, secret: &str, asked: Result<Option<PlayState>, CommandError>) -> Result<PlayState, CommandError> {
    match asked {
        Ok(Some(state)) => Ok(state),
        Ok(None) => Ok(PlayState::Error),
        Err(error) => {
            eprintln!("Koona Pin: a Play purchase is kept, the server could not be asked: {}", error.message);
            keep(account, secret)
        }
    }
}

/// «Subscribe» or «Buy»: Play's sheet for this plan, then the server's verdict on the purchase.
#[cfg(any(test, play))]
async fn purchase<A: Account, S: Store>(account: &A, store: &S, interval: PlanInterval) -> Result<PlayState, CommandError> {
    let billing = account.billing();
    let _one = billing.playing.lock().await;
    let checkout = started(interval, billing.get().session.map(|s| s.email), Utc::now());
    let secret = checkout.secret.clone();
    let id = account_id(&secret);
    let mut added = false;
    account.update(|s| added = s.add_play(checkout.clone()))?;
    if !added {
        return Err(too_many());
    }
    let bought = match store.buy(checkout.product.clone(), checkout.base_plan.clone(), id.clone()).await {
        Ok(bought) => bought,
        // Nothing can be bought here: forgotten.
        Err(native::Error::Unavailable(_)) => {
            account.update(|s| s.finish_play(&secret, PlayState::Unavailable))?;
            return Ok(PlayState::Unavailable);
        }
        // No answer from Play's sheet: a payment may exist, kept and found by its account id later.
        Err(native::Error::NoAnswer) => {
            eprintln!("Koona Pin: Play's sheet gave no answer, the purchase is kept");
            return keep(account, &secret);
        }
        // Play or the plugin failed before any purchase: none exists.
        Err(error) => {
            eprintln!("Koona Pin: Play's sheet did not open: {error}");
            account.update(|s| s.finish_play(&secret, PlayState::Error))?;
            return Ok(PlayState::Error);
        }
    };
    match after_buy(&bought, &id) {
        AfterBuy::Verify(token, paid) => {
            account.update(|s| {
                s.find_play([(token.as_str(), Some(id.as_str()), paid)], Utc::now());
            })?;
            kept_after_payment(account, &secret, verify(account, &secret).await)
        }
        AfterBuy::Forget(state) => {
            account.update(|s| s.finish_play(&secret, state))?;
            Ok(state)
        }
        AfterBuy::Keep => keep(account, &secret),
        AfterBuy::Owned => {
            // Nothing was bought now. A purchase made here before is verified again, and followed.
            let mut found = Vec::new();
            account.update(|s| {
                s.play.retain(|c| c.secret != secret);
                found = s.find_play(bought.purchases.iter().map(|p| (p.token.as_str(), p.account_id.as_deref(), p.state == native::PurchaseState::Purchased)), Utc::now());
                if let Some(earlier) = found.last() {
                    s.play_followed = Some(earlier.clone());
                }
            })?;
            if let Some(earlier) = found.last() {
                return kept_after_payment(account, earlier, verify(account, earlier).await);
            }
            // Signed in: the account's own plan, asked now, may be what this Google account owns.
            if billing.get().session.is_some() {
                account.check_plan().await;
            }
            let plan_store = super::effective(&billing.get(), Utc::now()).and_then(|plan| plan.store);
            let state = owned_elsewhere(plan_store, suspended_of(&bought.purchases));
            account.update(|s| s.finish_play(&secret, state))?;
            Ok(state)
        }
    }
}

/// Every purchase kept here: Play's tokens matched to their secrets (`reported` by the event, else
/// everything Play lists, which also drops a slow payment Play no longer has), then each one with a
/// token verified, unless asked about seconds ago and not `now`. Play out of reach does not stop
/// the purchases already known from being asked about, nor one failure the others; the first
/// failure is returned at the end.
#[cfg(any(test, play))]
async fn resume<A: Account, S: Store>(account: &A, store: &S, reported: Option<Vec<native::Purchase>>, now: bool) -> Result<(), CommandError> {
    let billing = account.billing();
    account.update(|s| s.forget_old_play(Utc::now()))?;
    if billing.get().play.is_empty() {
        return Ok(());
    }
    let _one = billing.playing.lock().await;
    let mut failure: Option<CommandError> = None;
    let listed = reported.is_none();
    let purchases = match reported {
        Some(purchases) => Some(purchases),
        None => match store.owned().await {
            Ok(purchases) => Some(purchases),
            Err(error) => {
                eprintln!("Koona Pin: Google Play's purchases could not be read: {error}");
                failure = Some(play_failed(error));
                None
            }
        },
    };
    if let Some(purchases) = purchases {
        account.update(|s| {
            s.find_play(purchases.iter().map(|p| (p.token.as_str(), p.account_id.as_deref(), p.state == native::PurchaseState::Purchased)), Utc::now());
            if listed {
                s.forget_unlisted(&purchases.iter().map(|p| p.token.as_str()).collect::<Vec<_>>());
            }
        })?;
    }
    let at = Utc::now();
    let due: Vec<String> = billing
        .get()
        .play
        .iter()
        .filter(|c| c.token.is_some() && (now || c.asked_at.is_none_or(|asked| asked > at || at - asked >= FRESH)))
        .map(|c| c.secret.clone())
        .collect();
    for secret in due {
        if let Err(error) = verify(account, &secret).await {
            eprintln!("Koona Pin: a Play purchase could not be verified: {}", error.message);
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(()), Err)
}

/// «Try again» after a purchase was kept: the purchases here asked about again now, without
/// Play's sheet. The state of the purchase followed; `kept` while one the server may be asked about
/// with this session is still unconfirmed (another account's is not this one's to wait for).
#[cfg(any(test, play))]
async fn retry<A: Account, S: Store>(account: &A, store: &S) -> Result<PlayState, CommandError> {
    let asked = resume(account, store, None, true).await;
    let stored = account.billing().get();
    let signed_in = stored.session.as_ref().map(|s| s.email.clone());
    let unconfirmed = stored.play.iter().any(|c| c.token.is_some() && ask_for(c, signed_in.as_deref()) != Ask::Skip);
    match (stored.play_progress(), asked) {
        (Some(progress), _) => Ok(progress.state),
        (None, Err(error)) => Err(error),
        (None, Ok(())) if unconfirmed => Ok(PlayState::Kept),
        (None, Ok(())) => Ok(PlayState::Error),
    }
}

#[cfg(any(test, play))]
fn play_failed(error: native::Error) -> CommandError {
    CommandError::detailed(ErrorCode::Network, ErrorDetail::ServiceFailed, error.to_string())
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

    /// Google Play through the plugin, each call within its time limit.
    struct Play(native::KoonaPlay<Wry>);

    impl Store for Play {
        async fn buy(&self, product: String, base_plan: Option<String>, account_id: String) -> Result<native::Bought, native::Error> {
            let play = self.0.clone();
            within(BUY_WAIT, async move { play.buy(&product, base_plan.as_deref(), &account_id).await }).await
        }

        async fn owned(&self) -> Result<Vec<native::Purchase>, native::Error> {
            let play = self.0.clone();
            within(ASK_WAIT, async move { play.purchases().await }).await
        }
    }

    /// The prices for the sheet, from Google Play, and whether this Google account's subscription
    /// is suspended (what Play says it owns; unknown reads as not), so the sheet opens on «Fix
    /// payment in Google Play». The two are asked at once.
    #[tauri::command]
    pub async fn get_play_offer(app: AppHandle) -> Result<PlayOffer, CommandError> {
        let play = plugin(&app)?;
        let asked = play.clone();
        let prices = within(ASK_WAIT, async move { asked.products(&[SUBSCRIPTION], &[FIVE_YEARS]).await });
        let store = Play(play);
        let (products, owned) = tokio::join!(prices, store.owned());
        match products {
            Ok(products) => Ok(offer_of(&products, owned.is_ok_and(|owned| suspended_of(&owned)))),
            Err(native::Error::Unavailable(_)) => Ok(PlayOffer::default()),
            Err(error) => Err(play_failed(error)),
        }
    }

    /// «Subscribe» or «Buy»: Play's sheet for this plan, then the server's verdict on the purchase.
    /// `paid` signed in; `email` signed out (the sheet asks for one); `owned` when Google Play owns
    /// Supporter for an account and nobody is signed in here; `suspended` when that subscription is
    /// on hold or paused; `kept` when it could not be confirmed now.
    #[tauri::command]
    pub async fn start_play_purchase(app: AppHandle, interval: PlanInterval) -> Result<PlayState, CommandError> {
        super::super::need_service()?;
        purchase(&Live(&app), &Play(plugin(&app)?), interval).await
    }

    /// «Try again» after a purchase was kept: asked of the server again, not Play's sheet.
    #[tauri::command]
    pub async fn retry_play_purchase(app: AppHandle) -> Result<PlayState, CommandError> {
        super::super::need_service()?;
        retry(&Live(&app), &Play(plugin(&app)?)).await
    }

    /// Looks for this app's purchases on start and each time the app comes back to the screen, and
    /// whenever Play reports one outside the sheet.
    pub(in crate::billing) fn watch(app: &AppHandle) {
        let Ok(play) = plugin(app) else {
            return;
        };
        let reported = app.clone();
        let store = play.clone();
        let registered = play.on_purchases(move |bought| {
            let app = reported.clone();
            let store = Play(store.clone());
            tauri::async_runtime::spawn(async move {
                if let Err(error) = resume(&Live(&app), &store, Some(bought.purchases), false).await {
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
            let store = Play(play);
            loop {
                foreground.wait().await;
                if let Err(error) = resume(&Live(&app), &store, None, false).await {
                    eprintln!("Koona Pin: Play purchases could not be verified: {}", error.message);
                }
                foreground.suspended().await;
            }
        });
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
        assert_eq!(stored.take_play_answer("s1", unset, None, &key, now), Some(PlayState::Kept));
        assert_eq!(stored.play.len(), 1);
        assert_eq!(stored.play_progress().map(|p| p.state), Some(PlayState::Kept), "the sheet says so, after a restart too");
        // A slow payment the server cannot verify now stays pending: nothing was paid yet.
        let mut slow = Stored::default();
        slow.add_play(PlayCheckout { token: Some("t".into()), state: Some(PlayState::Pending), ..checkout("slow", "2026-10-20T12:00:00Z") });
        slow.take_play_answer("slow", verdict_of(404, json!({ "error": "play" })).unwrap(), None, &key, now);
        assert_eq!(slow.play[0].state, Some(PlayState::Pending));
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
        let paid = || Verdict { state: PlayState::Paid, answer: Some(Answer { has_plan: true, lease: Some(signed.clone()), delete_at: None }) };
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
        let refunded = Verdict { state: PlayState::AlreadySupporter, answer: Some(Answer { has_plan: true, lease: Some(signed.clone()), delete_at: None }) };
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
        let mut stored = Stored { play_outcome: Some(("old".into(), PlayState::Canceled)), ..Stored::default() };
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
        stored.play_outcome = Some(("s1".into(), PlayState::Paid));
        let text = serde_json::to_string(&stored).unwrap();
        let read: Stored = serde_json::from_str(&text).unwrap();
        assert_eq!(read.play, stored.play);
        assert_eq!(read.play_outcome, None, "the outcome is this run's only");
        // As sign_out_supporter resets the file.
        let mut signed_out = stored.clone();
        signed_out.signed_out();
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
        assert_eq!(after_buy(&bought(Outcome::Purchased, vec![purchase("t9", Some("someone"), PurchaseState::Purchased)]), &id), AfterBuy::Keep);
        assert_eq!(after_buy(&bought(Outcome::Canceled, vec![]), &id), AfterBuy::Forget(PlayState::Canceled));
        assert_eq!(after_buy(&bought(Outcome::Unavailable, vec![]), &id), AfterBuy::Forget(PlayState::Unavailable));
        assert_eq!(after_buy(&bought(Outcome::AlreadyOwned, vec![]), &id), AfterBuy::Owned);
        // Play failed with no purchase of this one (its sheet refused or never opened): none exists.
        assert_eq!(after_buy(&bought(Outcome::Error, vec![]), &id), AfterBuy::Forget(PlayState::Error));
        assert_eq!(after_buy(&bought(Outcome::Error, vec![purchase("t9", Some("someone"), PurchaseState::Purchased)]), &id), AfterBuy::Forget(PlayState::Error));
        // Failed, but with this purchase reported: the server is asked.
        assert_eq!(after_buy(&bought(Outcome::Error, vec![purchase("t1", Some(&id), PurchaseState::Purchased)]), &id), AfterBuy::Verify("t1".into(), true));
        assert_eq!(owned_elsewhere(Some(PlanStore::Play), false), PlayState::Paid, "the plan of the account signed in, paid through Google Play");
        assert_eq!(owned_elsewhere(Some(PlanStore::Paddle), false), PlayState::Owned, "a Paddle plan says nothing of this Google purchase");
        assert_eq!(owned_elsewhere(None, false), PlayState::Owned);
        
        assert_eq!(owned_elsewhere(None, true), PlayState::Suspended);
        assert_eq!(owned_elsewhere(Some(PlanStore::Play), true), PlayState::Suspended);
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
            assert_eq!(hung, Err(native::Error::NoAnswer), "no answer in time is not a failure Play said");
            let refused = within(std::time::Duration::from_secs(5), async { Err::<u8, _>(native::Error::Unavailable("no Play".into())) }).await;
            assert_eq!(refused, Err(native::Error::Unavailable("no Play".into())));
        });
    }

    #[test]
    fn a_new_purchase_never_drops_one_that_is_paid_or_waits() {
        let paid = |i: usize| PlayCheckout { token: Some(format!("t{i}")), paid_at: Some(at("2026-10-20T12:00:00Z")), ..checkout(&format!("paid{i}"), "2026-10-20T12:00:00Z") };
        let mut full = Stored::default();
        for i in 0..MAX_KEPT {
            assert!(full.add_play(paid(i)));
        }
        assert!(!full.add_play(checkout("new", "2026-10-20T13:00:00Z")), "refused, nothing dropped");
        assert_eq!(full.play.len(), MAX_KEPT);
        assert!(full.play.iter().all(|c| c.secret.starts_with("paid")));
        // A pending one Play reported waits too; an unreported one makes room first.
        let mut mixed = Stored::default();
        for i in 0..MAX_KEPT - 2 {
            mixed.add_play(paid(i));
        }
        mixed.add_play(PlayCheckout { token: Some("slow".into()), state: Some(PlayState::Pending), ..checkout("slow", "2026-10-20T11:00:00Z") });
        mixed.add_play(checkout("unreported", "2026-10-20T11:30:00Z"));
        assert!(mixed.add_play(checkout("new", "2026-10-20T13:00:00Z")));
        let kept: Vec<&str> = mixed.play.iter().map(|c| c.secret.as_str()).collect();
        assert!(kept.contains(&"slow") && kept.contains(&"new") && !kept.contains(&"unreported"), "{kept:?}");
        assert!(mixed.add_play(checkout("another", "2026-10-20T13:05:00Z")), "the newest unreported one makes room");
        assert!(!mixed.play.iter().any(|c| c.secret == "new"));
    }

    #[test]
    fn the_sheet_shows_the_purchase_it_follows_not_an_older_one_waiting() {
        let mut stored = Stored::default();
        stored.add_play(PlayCheckout { token: Some("old".into()), state: Some(PlayState::Pending), ..checkout("old", "2026-10-20T10:00:00Z") });
        stored.add_play(PlayCheckout { token: Some("new".into()), state: Some(PlayState::SignIn), email: Some("anna@example.com".into()), ..checkout("new", "2026-10-20T12:00:00Z") });
        assert_eq!(stored.play_followed.as_deref(), Some("new"));
        assert_eq!(stored.play_progress().map(|p| p.state), Some(PlayState::SignIn));
        // The followed one is bound; the older one still waits: the sheet shows the outcome.
        stored.finish_play("new", PlayState::Paid);
        assert_eq!(stored.play_progress(), Some(PlayProgress { state: PlayState::Paid, email: None }));
        // The older one finishing later does not replace it.
        stored.finish_play("old", PlayState::Invalid);
        assert_eq!(stored.play_progress().map(|p| p.state), Some(PlayState::Paid));
        // A fresh start follows nothing: the newest waiting one.
        let started = Stored { play: vec![PlayCheckout { token: Some("old".into()), state: Some(PlayState::Pending), ..checkout("old", "2026-10-20T10:00:00Z") }], ..Stored::default() };
        assert_eq!(started.play_progress().map(|p| p.state), Some(PlayState::Pending));
    }

    #[test]
    fn the_play_build_needs_only_the_accounts_project() {
        use super::super::service_of;
        let (url, key) = (Some("https://accounts.example.com/"), Some("publishable"));
        assert_eq!(service_of(url, key, None, true, false).map(|s| (s.url, s.sandbox)), Some(("https://accounts.example.com", false)), "Play without Paddle's setting");
        assert!(service_of(url, key, None, false, false).is_none(), "a computer still needs Paddle's environment");
        assert!(service_of(url, key, Some("production"), false, false).is_some());
        assert!(service_of(url, key, Some("sandbox"), true, false).is_none(), "no sandbox in a build people install");
        assert!(service_of(url, key, Some("sandbox"), true, true).is_some_and(|s| s.sandbox));
        assert!(service_of(url, key, Some("staging"), true, true).is_none());
        assert!(service_of(None, key, None, true, true).is_none());
    }

    // ── The steps, with fakes of the app and of Google Play ─────────────────

    type Answering = Box<dyn Fn(&Value, Option<&str>) -> Result<(u16, Value), CommandError> + Send + Sync>;
    type Buying = Box<dyn Fn(&str) -> Result<native::Bought, native::Error> + Send + Sync>;

    struct Fake {
        billing: Billing,
        folder: std::path::PathBuf,
        asked: std::sync::Mutex<Vec<(Value, Option<String>)>>,
        answer: std::sync::Mutex<Answering>,
        codes: std::sync::Mutex<Vec<String>>,
        code_fails: std::sync::atomic::AtomicBool,
        buy: std::sync::Mutex<Buying>,
        owned: std::sync::Mutex<Result<Vec<native::Purchase>, native::Error>>,
    }

    impl Fake {
        fn new(answer: impl Fn(&Value, Option<&str>) -> Result<(u16, Value), CommandError> + Send + Sync + 'static) -> Fake {
            let folder = std::env::temp_dir().join(format!("koonapin-play-{}", new_secret()));
            Fake {
                billing: Billing::load(folder.join("account.json")),
                folder,
                asked: Default::default(),
                answer: std::sync::Mutex::new(Box::new(answer)),
                codes: Default::default(),
                code_fails: Default::default(),
                buy: std::sync::Mutex::new(Box::new(|_| Err(native::Error::Failed("no sheet".into())))),
                owned: std::sync::Mutex::new(Ok(Vec::new())),
            }
        }

        fn answers(&self, answer: impl Fn(&Value, Option<&str>) -> Result<(u16, Value), CommandError> + Send + Sync + 'static) {
            *self.answer.lock().unwrap() = Box::new(answer);
        }

        fn buys(&self, buy: impl Fn(&str) -> Result<native::Bought, native::Error> + Send + Sync + 'static) {
            *self.buy.lock().unwrap() = Box::new(buy);
        }

        fn set(&self, change: impl FnOnce(&mut Stored)) {
            self.billing.apply(change).unwrap();
        }

        /// What the server was asked for this action, with its bearer.
        fn asked(&self, action: &str) -> Vec<(Value, Option<String>)> {
            self.asked.lock().unwrap().iter().filter(|(body, _)| body["action"] == action).cloned().collect()
        }
    }

    impl Drop for Fake {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.folder);
        }
    }

    impl Account for Fake {
        fn billing(&self) -> &Billing {
            &self.billing
        }

        fn update(&self, change: impl FnOnce(&mut Stored)) -> Result<(), CommandError> {
            self.billing.apply(change).map(|_| ())
        }

        async fn token(&self) -> Result<Option<String>, CommandError> {
            Ok(self.billing.get().session.map(|s| s.access_token))
        }

        async fn ask(&self, body: Value, bearer: Option<String>) -> Result<(reqwest::StatusCode, Value), CommandError> {
            self.asked.lock().unwrap().push((body.clone(), bearer.clone()));
            let (status, value) = (self.answer.lock().unwrap())(&body, bearer.as_deref())?;
            Ok((reqwest::StatusCode::from_u16(status).unwrap(), value))
        }

        async fn send_code(&self, email: String) -> Result<(), CommandError> {
            if self.code_fails.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(CommandError::detailed(ErrorCode::Network, ErrorDetail::TooManyMessages, "Too many codes asked for"));
            }
            self.codes.lock().unwrap().push(email);
            Ok(())
        }

        async fn check_plan(&self) {}
    }

    impl Store for Fake {
        async fn buy(&self, _product: String, _base_plan: Option<String>, account_id: String) -> Result<native::Bought, native::Error> {
            (self.buy.lock().unwrap())(&account_id)
        }

        async fn owned(&self) -> Result<Vec<native::Purchase>, native::Error> {
            self.owned.lock().unwrap().clone()
        }
    }

    fn play_purchase(token: &str, account_id: &str) -> native::Purchase {
        native::Purchase {
            token: token.into(),
            products: vec![SUBSCRIPTION.into()],
            state: native::PurchaseState::Purchased,
            acknowledged: false,
            suspended: false,
            account_id: Some(account_id.into()),
        }
    }

    fn bought(outcome: native::Outcome, token: &str, account_id: &str) -> native::Bought {
        native::Bought { outcome, purchases: vec![play_purchase(token, account_id)] }
    }

    fn bob() -> Session {
        Session { access_token: "b".into(), refresh_token: "rb".into(), expires_at: 0, email: "bob@example.com".into() }
    }

    fn run<T>(future: impl Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    fn offline() -> CommandError {
        CommandError::detailed(ErrorCode::Network, ErrorDetail::NoConnection, "offline")
    }

    #[test]
    fn a_purchase_is_bound_with_its_accounts_session_and_never_another_ones() {
        let fake = Fake::new(|_, _| Ok((200, json!({ "status": "pending" }))));
        fake.set(|s| s.session = Some(anna()));
        fake.buys(|id| Ok(native::Bought { outcome: native::Outcome::Pending, purchases: vec![native::Purchase { state: native::PurchaseState::Pending, ..play_purchase("t1", id) }] }));
        assert_eq!(run(purchase(&fake, &fake, PlanInterval::Month)).ok(), Some(PlayState::Pending));
        assert_eq!(fake.asked("play_verify")[0].1.as_deref(), Some("a"), "Anna's own session");
        let id = account_id(&fake.billing.get().play[0].secret);
        *fake.owned.lock().unwrap() = Ok(vec![native::Purchase { state: native::PurchaseState::Pending, ..play_purchase("t1", &id) }]);
        // Anna signs out and Bob signs in while the payment is slow: his session is never sent.
        fake.set(|s| s.session = Some(bob()));
        run(verify_waiting_with(&fake));
        run(resume(&fake, &fake, None, true)).unwrap();
        assert!(fake.asked("play_verify").iter().all(|(_, bearer)| bearer.as_deref() != Some("b")), "{:?}", fake.asked("play_verify"));
        assert_eq!(fake.asked("play_verify").len(), 1, "not asked at all with another account here");
        // Signed out: asked where it stands, without a session.
        fake.set(|s| s.session = None);
        run(resume(&fake, &fake, None, true)).unwrap();
        assert_eq!(fake.asked("play_verify").last().unwrap().1, None);
    }

    #[test]
    fn a_purchase_that_could_not_be_confirmed_is_kept_and_asked_again_by_try_again() {
        let fake = Fake::new(|_, _| Err(offline()));
        fake.buys(|id| Ok(bought(native::Outcome::Purchased, "t1", id)));
        assert_eq!(run(purchase(&fake, &fake, PlanInterval::Year)).ok(), Some(PlayState::Kept), "paid, the server out of reach");
        assert_eq!(fake.billing.get().play.len(), 1, "kept");
        let id = account_id(&fake.billing.get().play[0].secret);
        *fake.owned.lock().unwrap() = Ok(vec![play_purchase("t1", &id)]);
        // The server does not verify Play purchases yet: still kept.
        fake.answers(|_, _| Ok((404, json!({ "error": "play" }))));
        assert_eq!(run(retry(&fake, &fake)).ok(), Some(PlayState::Kept));
        assert_eq!(fake.billing.get().play.len(), 1);
        // Then it answers: the email step, with no second Play sheet.
        fake.answers(|_, _| Ok((200, json!({ "status": "email" }))));
        assert_eq!(run(retry(&fake, &fake)).ok(), Some(PlayState::Email));
        assert_eq!(fake.asked("play_verify").len(), 3);
        // Play's answer not about this purchase, or no answer at all: kept too.
        let other = Fake::new(|_, _| Ok((200, json!({ "status": "email" }))));
        other.buys(|_| Ok(bought(native::Outcome::Purchased, "t9", "someone else")));
        assert_eq!(run(purchase(&other, &other, PlanInterval::Month)).ok(), Some(PlayState::Kept));
        other.buys(|_| Err(native::Error::NoAnswer));
        assert_eq!(run(purchase(&other, &other, PlanInterval::Month)).ok(), Some(PlayState::Kept));
        assert_eq!(other.billing.get().play.len(), 2, "both kept");
        assert!(other.billing.get().play.iter().all(|c| c.state == Some(PlayState::Kept)), "stored as kept, for the sheet after a restart");
        // Play's sheet refused or never opened (the plugin failed, Play's error with no purchase):
        // no payment exists, so it is an error and nothing is kept.
        let refused = Fake::new(|_, _| unreachable!("nothing to ask"));
        refused.buys(|_| Err(native::Error::Failed("the purchase did not start".into())));
        assert_eq!(run(purchase(&refused, &refused, PlanInterval::Month)).ok(), Some(PlayState::Error));
        refused.buys(|_| Ok(native::Bought { outcome: native::Outcome::Error, purchases: vec![] }));
        assert_eq!(run(purchase(&refused, &refused, PlanInterval::Month)).ok(), Some(PlayState::Error));
        assert!(refused.billing.get().play.is_empty());
        // Before any payment, Play that cannot sell here is unavailable and nothing is kept.
        let none = Fake::new(|_, _| unreachable!("nothing to ask"));
        none.buys(|_| Err(native::Error::Unavailable("no Play".into())));
        assert_eq!(run(purchase(&none, &none, PlanInterval::Month)).ok(), Some(PlayState::Unavailable));
        assert!(none.billing.get().play.is_empty());
    }

    #[test]
    fn owned_already_recovers_the_purchase_made_here_before() {
        let fake = Fake::new(|body, _| Ok((200, json!({ "status": if body["token"] == "t0" { "email" } else { "invalid" } }))));
        fake.set(|s| s.play.push(checkout("s0", "2026-10-20T10:00:00Z")));
        fake.buys(|_| Ok(bought(native::Outcome::AlreadyOwned, "t0", &account_id("s0"))));
        assert_eq!(run(purchase(&fake, &fake, PlanInterval::Month)).ok(), Some(PlayState::Email));
        let stored = fake.billing.get();
        assert_eq!(stored.play.iter().map(|c| c.secret.as_str()).collect::<Vec<_>>(), ["s0"], "the new one is gone, the old one kept");
        assert_eq!(stored.play[0].token.as_deref(), Some("t0"));
        assert_eq!(stored.play_progress().map(|p| p.state), Some(PlayState::Email), "the sheet follows it");
        // Owned, with no purchase of this app's and no Play plan here: sign in to its account.
        let elsewhere = Fake::new(|_, _| unreachable!("nothing of this app's to ask"));
        elsewhere.set(|s| s.session = Some(anna()));
        elsewhere.buys(|_| Ok(bought(native::Outcome::AlreadyOwned, "tx", "another app's")));
        assert_eq!(run(purchase(&elsewhere, &elsewhere, PlanInterval::Year)).ok(), Some(PlayState::Owned));
        assert_eq!(elsewhere.billing.get().play_progress().map(|p| p.state), Some(PlayState::Owned));
    }

    #[test]
    fn the_sign_in_binds_the_claimed_purchase_and_the_sheet_shows_it() {
        let fake = Fake::new(|body, bearer| {
            let status = match (body["action"].as_str(), body["token"].as_str(), bearer) {
                (Some("play_email"), _, _) => "code",
                (_, Some("claimed"), Some("a")) => "paid",
                _ => "pending",
            };
            Ok((200, json!({ "status": status })))
        });
        fake.set(|s| {
            s.play.push(PlayCheckout { token: Some("slow".into()), state: Some(PlayState::Pending), ..checkout("slow", "2026-10-20T10:00:00Z") });
            s.play.push(PlayCheckout { token: Some("claimed".into()), state: Some(PlayState::Email), ..checkout("claimed", "2026-10-20T12:00:00Z") });
        });
        assert_eq!(run(claim_email(&fake, " anna@example.com ".into())).ok(), Some(PlayState::SignIn));
        assert_eq!(*fake.codes.lock().unwrap(), ["anna@example.com"]);
        // The code signs Anna in: the claimed purchase is bound with her session, the slow one asked
        // without it (it was never claimed), and the sheet shows the one it followed.
        fake.set(|s| s.session = Some(anna()));
        run(verify_waiting_with(&fake));
        let asked = fake.asked("play_verify");
        assert!(asked.iter().any(|(body, bearer)| body["token"] == "claimed" && bearer.as_deref() == Some("a")), "{asked:?}");
        assert!(asked.iter().any(|(body, bearer)| body["token"] == "slow" && bearer.is_none()), "{asked:?}");
        let stored = fake.billing.get();
        assert_eq!(stored.play_progress().map(|p| p.state), Some(PlayState::Paid));
        assert_eq!(stored.play.iter().map(|c| c.secret.as_str()).collect::<Vec<_>>(), ["slow"]);
    }

    #[test]
    fn the_code_step_comes_only_after_the_code_went_out() {
        let fake = Fake::new(|_, _| Ok((200, json!({ "status": "code" }))));
        fake.set(|s| s.play.push(PlayCheckout { token: Some("t1".into()), state: Some(PlayState::Email), ..checkout("s1", "2026-10-20T12:00:00Z") }));
        fake.code_fails.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(run(claim_email(&fake, "anna@example.com".into())).is_err());
        let stored = fake.billing.get();
        assert_eq!((stored.play[0].email.clone(), stored.play[0].state), (None, Some(PlayState::Email)), "still the email step");
        fake.code_fails.store(false, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(run(claim_email(&fake, "anna@example.com".into())).ok(), Some(PlayState::SignIn));
        assert_eq!(fake.billing.get().play[0].email.as_deref(), Some("anna@example.com"));
        // The server not verifying Play purchases now: kept, not the code step.
        fake.answers(|_, _| Ok((404, json!({ "error": "play" }))));
        assert_eq!(run(claim_email(&fake, "anna@example.com".into())).ok(), Some(PlayState::Kept));
    }

    #[test]
    fn resume_goes_on_after_one_failure_and_without_plays_list() {
        let fake = Fake::new(|body, _| match body["token"].as_str() {
            Some("t1") => Err(CommandError::detailed(ErrorCode::Network, ErrorDetail::ServiceFailed, "billing answered 502")),
            _ => Ok((200, json!({ "status": "invalid" }))),
        });
        fake.set(|s| {
            s.play.push(PlayCheckout { token: Some("t1".into()), ..checkout("s1", "2026-10-20T10:00:00Z") });
            s.play.push(PlayCheckout { token: Some("t2".into()), ..checkout("s2", "2026-10-20T11:00:00Z") });
        });
        *fake.owned.lock().unwrap() = Err(native::Error::Failed("Google Play did not answer in time".into()));
        assert!(run(resume(&fake, &fake, None, true)).is_err(), "the first failure is said at the end");
        assert_eq!(fake.asked("play_verify").len(), 2, "both asked although Play was out of reach and one failed");
        let kept: Vec<String> = fake.billing.get().play.iter().map(|c| c.secret.clone()).collect();
        assert_eq!(kept, ["s1"], "the one the server answered is done; the failed one kept");
    }

    #[test]
    fn a_new_purchase_is_refused_while_paid_ones_fill_the_list() {
        let fake = Fake::new(|_, _| unreachable!("nothing asked"));
        fake.set(|s| {
            for i in 0..MAX_KEPT {
                s.play.push(PlayCheckout { token: Some(format!("t{i}")), paid_at: Some(Utc::now()), ..checkout(&format!("p{i}"), "2026-10-20T10:00:00Z") });
            }
        });
        let refused = run(purchase(&fake, &fake, PlanInterval::Month)).unwrap_err();
        assert_eq!(refused.detail, Some(ErrorDetail::PurchasesWaiting));
        assert_eq!(fake.billing.get().play.len(), MAX_KEPT);
    }

    #[test]
    fn try_again_waits_only_for_purchases_this_session_may_ask_about() {
        let fake = Fake::new(|_, _| unreachable!("another account's purchase is never asked about"));
        fake.set(|s| {
            s.session = Some(bob());
            s.play.push(PlayCheckout { token: Some("t1".into()), account: Some("anna@example.com".into()), ..checkout("anna's", "2026-10-20T12:00:00Z") });
        });
        *fake.owned.lock().unwrap() = Ok(vec![play_purchase("t1", &account_id("anna's"))]);
        assert_eq!(run(retry(&fake, &fake)).ok(), Some(PlayState::Error), "Anna's purchase is not Bob's to wait for");
        assert!(fake.asked("play_verify").is_empty());
        // Signed out, it is asked where it stands; the server not verifying Play purchases: kept.
        fake.set(|s| s.session = None);
        fake.answers(|_, _| Ok((404, json!({ "error": "play" }))));
        assert_eq!(run(retry(&fake, &fake)).ok(), Some(PlayState::Kept));
    }

    #[test]
    fn a_kept_purchase_shows_after_a_restart_and_finishes_when_asked_again() {
        let fake = Fake::new(|_, _| Err(offline()));
        fake.buys(|id| Ok(bought(native::Outcome::Purchased, "t1", id)));
        assert_eq!(run(purchase(&fake, &fake, PlanInterval::Year)).ok(), Some(PlayState::Kept));
        // The app starts again: nothing followed, the kept purchase is what the sheet resumes on.
        let restarted = Billing::load(fake.folder.join("account.json")).get();
        assert_eq!(restarted.play_progress(), Some(PlayProgress { state: PlayState::Kept, email: None }));
        // Asked again on the way back, it finishes as the server says.
        fake.answers(|_, _| Ok((200, json!({ "status": "email" }))));
        run(resume(&fake, &fake, Some(Vec::new()), true)).unwrap();
        assert_eq!(fake.billing.get().play_progress().map(|p| p.state), Some(PlayState::Email));
        fake.answers(|_, _| Ok((200, json!({ "status": "invalid" }))));
        run(resume(&fake, &fake, Some(Vec::new()), true)).unwrap();
        assert!(fake.billing.get().play.is_empty());
    }
}
