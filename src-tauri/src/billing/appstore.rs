//! Supporter through the App Store (StoreKit 2): the App Store build's purchase, after the Play
//! build's flow B (billing/play.rs), whose rules it shares. The purchase comes first, made with a
//! fresh secret whose SHA-256 gives the purchase's `appAccountToken` ([`account_token`]); the server
//! (`billing`'s `appstore_verify`) checks the signed transaction with Apple and binds it to the
//! account signed in here, answering as `play_verify` does. Signed out, the person gives an email
//! (`appstore_email`) and signs in with the code sent there; the purchase is then verified again
//! with that session, which binds it.
//!
//! The secret is kept in `account.json` until the purchase is bound or found invalid, and over Sign
//! out: it is the purchase's only claim. A transaction is finished only once no secret here claims
//! it any more, that is after the server has bound it (or refused it): StoreKit hands an unfinished
//! one back on every start, so a purchase nobody has claimed yet is never lost. Unlike Google Play,
//! the App Store never refunds an unfinished purchase by itself. Purchases are looked for on start,
//! each time the app comes back to the screen, when `Transaction.updates` reports one (Ask to Buy
//! approved, a renewal, a refund), and by «Restore purchases» (`AppStore.sync()`).
//!
//! The steps talk to the app through Play's [`Account`] seam and to StoreKit through [`Store`], so
//! they are tested with fakes on a desktop. Only the App Store build (`cfg(appstore)`: the feature
//! `store-appstore` on iOS) has the plugin and the commands.

// Outside the App Store build only the sign-in's part (`verify_waiting`) runs; the rest is its tests'.
#![cfg_attr(not(appstore), allow(dead_code))]

use super::play::{ask_by, email_answer_of_store, invalid_email, owned_in, verdict_of_store, Account, Ask, EmailAnswer, Live, PlayProgress, PlayState, Verdict};
use super::{new_secret, plan_key, PlanInterval, Store as PlanStore, Stored};
use crate::error::{CommandError, ErrorCode, ErrorDetail};
use chrono::{DateTime, TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::AppHandle;

#[cfg(any(test, appstore))]
use super::play::{PlayOffer, PlayPrice};
#[cfg(any(test, appstore))]
use std::future::Future;
#[cfg(any(test, appstore))]
use tauri_plugin_koona_appstore as native;

/// The App Store's product ids (App Store Connect): the subscription group «Supporter» with its
/// monthly and annual subscriptions, and the one-time purchase, a non-consumable. The server reads
/// the same ids from its own constant.
pub const MONTHLY: &str = "app.koona.pin.supporter.monthly";
pub const ANNUAL: &str = "app.koona.pin.supporter.annual";
pub const LIFETIME_PRODUCT: &str = "app.koona.pin.supporter.lifetime";
pub const PRODUCTS: [&str; 3] = [MONTHLY, ANNUAL, LIFETIME_PRODUCT];

/// A purchase StoreKit never reported (the app ended over the sheet, Ask to Buy declined or never
/// answered) is forgotten after this; one it reported waits until the server answers.
const UNREPORTED: TimeDelta = TimeDelta::days(7);
/// The App Store's sheet is the person's to finish; the app stops waiting for its answer after
/// this, keeps the purchase and finds it by its account token on the way back.
const BUY_WAIT: std::time::Duration = std::time::Duration::from_secs(10 * 60);
/// StoreKit's prices and transactions come at once or not at all; `AppStore.sync()` may ask for the
/// Apple Account's password, so it waits for the person.
const ASK_WAIT: std::time::Duration = std::time::Duration::from_secs(30);
const SYNC_WAIT: std::time::Duration = std::time::Duration::from_secs(5 * 60);
/// Purchases kept at once. Cancelled ones are not kept, so more is unusual.
const MAX_KEPT: usize = 6;
/// A purchase asked about this recently is not asked about again on the way back to the screen.
const FRESH: TimeDelta = TimeDelta::seconds(15);

/// A purchase started here through the App Store (`account.json`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct AppStoreCheckout {
    /// Its SHA-256 makes the purchase's `appAccountToken`; the server recomputes it from the claim.
    pub secret: String,
    pub product: String,
    /// StoreKit's transaction, once reported: its id and its signed form (`jwsRepresentation`).
    #[serde(default)]
    pub transaction: Option<String>,
    #[serde(default)]
    pub jws: Option<String>,
    /// The email given for it, once the code was sent there.
    #[serde(default)]
    pub email: Option<String>,
    pub started: DateTime<Utc>,
    /// What the server said last (or `pending` for Ask to Buy); none before it was asked.
    #[serde(default)]
    pub state: Option<PlayState>,
    #[serde(default)]
    pub asked_at: Option<DateTime<Utc>>,
    /// The account signed in when the purchase started: only its session is ever sent for it.
    #[serde(default)]
    pub account: Option<String>,
    /// A purchase bought outside the app and adopted here: its original transaction, by which its
    /// transactions are known (they carry no account token).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original: Option<String>,
}

impl AppStoreCheckout {
    /// May make room for a new purchase: only one StoreKit never reported that waits for nothing.
    fn evictable(&self) -> bool {
        self.transaction.is_none() && !self.state.is_some_and(PlayState::waiting)
    }
}

/// The purchase's `appAccountToken`: the first 16 bytes of SHA-256 of the secret's text as a UUID,
/// with the version nibble set to 4 and the variant bits to `10` (RFC 9562), in lower case. The
/// server makes the same from the claim.
pub(super) fn account_token(secret: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(secret.as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).hyphenated().to_string()
}

/// The App Store's product for a plan.
pub(super) fn product_of(interval: PlanInterval) -> &'static str {
    match interval {
        PlanInterval::Month => MONTHLY,
        PlanInterval::Year => ANNUAL,
        PlanInterval::Lifetime => LIFETIME_PRODUCT,
    }
}

/// The server's answer to `appstore_verify`, read as `play_verify`'s.
pub(super) fn verdict(status: reqwest::StatusCode, value: &serde_json::Value) -> Result<Verdict, CommandError> {
    verdict_of_store(status, value, "appstore", "billing appstore_verify")
}

impl Stored {
    /// Keeps a new purchase and follows it. Room is made from the oldest StoreKit never reported
    /// and that waits for nothing; never from one it reported. False, and nothing changed, when not
    /// enough may make room.
    pub(super) fn add_appstore(&mut self, checkout: AppStoreCheckout) -> bool {
        // Purchases adopted from outside the app don't take the room of the ones made here: a few
        // nobody claims (signed out) must never stop a purchase.
        let made_here = self.appstore.iter().filter(|c| c.original.is_none()).count();
        let excess = (made_here + 1).saturating_sub(MAX_KEPT);
        let order: Vec<usize> = (0..self.appstore.len()).filter(|&i| self.appstore[i].original.is_none() && self.appstore[i].evictable()).collect();
        if order.len() < excess {
            return false;
        }
        // Oldest first; removed from the back, so the indexes hold.
        for at in order.into_iter().take(excess).rev() {
            self.appstore.remove(at);
        }
        self.appstore_outcome = None;
        self.appstore_followed = Some(checkout.secret.clone());
        self.appstore.push(checkout);
        true
    }

    /// Drops purchases StoreKit never reported, a week after their sheet.
    pub(super) fn forget_old_appstore(&mut self, now: DateTime<Utc>) {
        self.appstore.retain(|c| c.transaction.is_some() || now - c.started <= UNREPORTED);
    }

    /// A purchase that left `appstore`, and how it finished: the outcome the sheet shows when it is
    /// the purchase followed (or none is).
    fn finish_appstore(&mut self, secret: &str, state: PlayState) {
        self.appstore.retain(|c| c.secret != secret);
        if self.appstore_followed.as_deref().is_none_or(|followed| followed == secret) {
            self.appstore_outcome = Some((secret.to_string(), state));
        }
    }

    /// StoreKit's transactions: each one a kept purchase claims (by its token, or an adopted one by
    /// its original transaction) gets its transaction, the newest seen. The secrets of those found.
    #[cfg(any(test, appstore))]
    pub(super) fn find_appstore<'a>(&mut self, transactions: impl IntoIterator<Item = &'a native::Transaction>) -> Vec<String> {
        let mut found = Vec::new();
        for transaction in transactions {
            let Some(at) = self.claimant(&transaction.original_id, transaction.account_token.as_deref()).map(|c| c.secret.clone()) else { continue };
            if let Some(checkout) = self.appstore.iter_mut().find(|c| c.secret == at) {
                checkout.transaction = Some(transaction.id.clone());
                checkout.jws = Some(transaction.jws.clone());
                if checkout.state == Some(PlayState::Pending) {
                    // Approved (Ask to Buy) or paid: the server says what it is now.
                    checkout.state = None;
                }
                if !found.contains(&checkout.secret) {
                    found.push(checkout.secret.clone());
                }
            }
        }
        found
    }

    /// The kept purchase a transaction belongs to: by its account token, or, for one bought without
    /// a token and adopted here, by its original transaction.
    fn claimant(&self, original: &str, token: Option<&str>) -> Option<&AppStoreCheckout> {
        match token {
            Some(token) => self.appstore.iter().find(|c| account_token(&c.secret).eq_ignore_ascii_case(token)),
            None => self.appstore.iter().find(|c| c.original.as_deref() == Some(original)),
        }
    }

    fn claims(&self, original: &str, token: Option<&str>) -> bool {
        self.claimant(original, token).is_some()
    }

    /// Purchases bought outside the app (an offer code, the App Store's own page) carry no
    /// `appAccountToken`, so no secret here claims them. Each, by its original transaction and the
    /// first time any of its transactions is seen (a renewal too: what the Apple Account owns is the
    /// latest), gets a fresh secret of its own: the server takes it as the purchase's claim
    /// (`appstore_verify` adopts a purchase without a token once), and it is then verified as any.
    #[cfg(any(test, appstore))]
    pub(super) fn adopt_appstore<'a>(&mut self, transactions: impl IntoIterator<Item = &'a native::Transaction>, account: Option<String>, now: DateTime<Utc>) {
        for transaction in transactions {
            let ours = PRODUCTS.contains(&transaction.product.as_str());
            if !ours || transaction.account_token.is_some() || transaction.revoked || self.appstore_adopted.contains(&transaction.original_id) {
                continue;
            }
            self.appstore_adopted.push(transaction.original_id.clone());
            self.appstore.push(AppStoreCheckout {
                transaction: Some(transaction.id.clone()),
                jws: Some(transaction.jws.clone()),
                product: transaction.product.clone(),
                original: Some(transaction.original_id.clone()),
                ..started(PlanInterval::Month, account.clone(), now)
            });
        }
    }

    /// What the server said about the purchase with this secret, as for Play
    /// ([`Stored::take_play_answer`]): bound or refused, it is done; otherwise it waits.
    pub(super) fn take_appstore_answer(&mut self, secret: &str, verdict: Verdict, asked_for: Option<&str>, key: &[u8], at: DateTime<Utc>) -> Option<PlayState> {
        let checkout = self.appstore.iter_mut().find(|c| c.secret == secret)?;
        checkout.asked_at = Some(at);
        let state = match verdict.state {
            PlayState::Email if checkout.email.is_some() => PlayState::SignIn,
            state => state,
        };
        if state.waiting() {
            checkout.state = Some(state);
            return Some(state);
        }
        // The server cannot verify App Store purchases now: kept, shown as such, asked again later.
        if state == PlayState::Unavailable {
            checkout.state = Some(PlayState::Kept);
            return Some(PlayState::Kept);
        }
        if let (Some(answer), Some(email)) = (verdict.answer, asked_for) {
            if self.same_account(email) {
                self.take_answer(answer, key, at);
            }
        }
        self.finish_appstore(secret, state);
        Some(state)
    }

    /// What the sheet shows: the purchase it follows in this run, waiting or finished; with none
    /// followed (the app just started), the newest one waiting here.
    pub(super) fn appstore_progress(&self) -> Option<PlayProgress> {
        let shown = |c: &AppStoreCheckout| c.state.filter(|s| s.waiting()).map(|state| PlayProgress { state, email: c.email.clone() });
        if let Some(followed) = &self.appstore_followed {
            if let Some(checkout) = self.appstore.iter().find(|c| &c.secret == followed) {
                return shown(checkout);
            }
            return self.appstore_outcome.as_ref().filter(|(secret, _)| secret == followed).map(|(_, state)| PlayProgress { state: *state, email: None });
        }
        match self.appstore.iter().rev().find_map(shown) {
            Some(waiting) => Some(waiting),
            None => self.appstore_outcome.as_ref().map(|(_, state)| PlayProgress { state: *state, email: None }),
        }
    }

    /// The purchase the email is for: the one followed if it waits for an email or its code, else
    /// the newest one that does.
    fn claimable_appstore(&self) -> Option<&AppStoreCheckout> {
        let claimable = |c: &&AppStoreCheckout| c.jws.is_some() && matches!(c.state, Some(PlayState::Email | PlayState::SignIn));
        self.appstore
            .iter()
            .find(|c| self.appstore_followed.as_deref() == Some(c.secret.as_str()))
            .filter(claimable)
            .or_else(|| self.appstore.iter().rev().find(claimable))
    }
}

/// The prices the sheet shows, from StoreKit's products: a subscription only with the period its
/// card says (a wrong one would put a wrong disclosure on the sheet), as Play's.
#[cfg(any(test, appstore))]
pub(super) fn offer_of(products: &native::Products) -> PlayOffer {
    let price = |id: &str, period: Option<&str>| {
        products.products.iter().find(|p| p.id == id && p.period.as_deref() == period).map(|p| PlayPrice {
            price: p.price.clone(),
            currency: p.currency.clone(),
            micros: p.micros,
            period: p.period.clone(),
        })
    };
    PlayOffer {
        available: true,
        month: price(MONTHLY, Some("P1M")),
        year: price(ANNUAL, Some("P1Y")),
        lifetime: price(LIFETIME_PRODUCT, None),
        suspended: products.suspended,
    }
}

/// What to do after the App Store's sheet closed.
#[cfg(any(test, appstore))]
#[derive(Debug, PartialEq)]
pub(super) enum AfterBuy {
    /// Bought with this purchase's token: the server verifies this transaction.
    Verify(native::Transaction),
    /// Waiting for approval (Ask to Buy) or the bank: kept, the transaction comes later.
    Pending,
    /// Nothing was bought; the purchase is forgotten.
    Forget(PlayState),
    /// StoreKit answered with an earlier transaction (owned already): one kept here is verified
    /// again, if it is one.
    Owned(native::Transaction),
}

#[cfg(any(test, appstore))]
pub(super) fn after_buy(bought: native::Bought, token: &str) -> AfterBuy {
    use native::Outcome;
    match (bought.outcome, bought.transaction) {
        (Outcome::Purchased, Some(transaction)) if transaction.account_token.as_deref().is_some_and(|t| t.eq_ignore_ascii_case(token)) => AfterBuy::Verify(transaction),
        (Outcome::Purchased, Some(transaction)) => AfterBuy::Owned(transaction),
        // Purchased with no transaction is not something StoreKit answers: nothing to verify.
        (Outcome::Purchased, None) | (Outcome::Error, _) => AfterBuy::Forget(PlayState::Error),
        (Outcome::Pending, _) => AfterBuy::Pending,
        (Outcome::Canceled, _) => AfterBuy::Forget(PlayState::Canceled),
        (Outcome::Unavailable, _) => AfterBuy::Forget(PlayState::Unavailable),
    }
}

fn too_many() -> CommandError {
    CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::PurchasesWaiting, "App Store purchases are still waiting here")
}

/// A fresh purchase kept here before the App Store's sheet opens, with the account signed in: a
/// payment whose answer never reaches the app is still found by its account token later.
fn started(interval: PlanInterval, account: Option<String>, now: DateTime<Utc>) -> AppStoreCheckout {
    AppStoreCheckout {
        secret: new_secret(),
        product: product_of(interval).to_string(),
        transaction: None,
        jws: None,
        email: None,
        started: now,
        state: None,
        asked_at: None,
        account,
        original: None,
    }
}

// ── The seam ─────────────────────────────────────────────────────────────────

/// What an App Store purchase needs of StoreKit, each within its time limit.
#[cfg(any(test, appstore))]
pub(super) trait Store: Send + Sync {
    fn buy(&self, product: String, account_token: String) -> impl Future<Output = Result<native::Bought, native::Error>> + Send;
    /// The transactions not finished and what the Apple Account owns; `sync` first for «Restore».
    fn transactions(&self, sync: bool) -> impl Future<Output = Result<native::Transactions, native::Error>> + Send;
    /// Finishes these transactions, in one pass over StoreKit's unfinished ones.
    fn finish(&self, ids: Vec<String>) -> impl Future<Output = Result<(), native::Error>> + Send;
}

// ── The steps ────────────────────────────────────────────────────────────────

/// Asks the server about the purchase with this secret, with the session of its account only.
async fn verify<A: Account>(account: &A, secret: &str) -> Result<Option<PlayState>, CommandError> {
    let stored = account.billing().get();
    let Some(checkout) = stored.appstore.into_iter().find(|c| c.secret == secret) else {
        return Ok(None);
    };
    let Some(jws) = checkout.jws.clone() else {
        return Ok(checkout.state);
    };
    let signed_in = stored.session.map(|s| s.email);
    let bearer = match ask_by(checkout.email.as_deref(), checkout.account.as_deref(), signed_in.as_deref()) {
        Ask::Skip => return Ok(checkout.state),
        Ask::WithoutSession => None,
        Ask::WithSession => account.token().await?,
    };
    let asked_for = bearer.as_ref().and(signed_in);
    let body = json!({ "action": "appstore_verify", "transaction": jws, "claim": checkout.secret });
    let asked_at = Utc::now();
    let (status, value) = account.ask(body, bearer).await?;
    // An adopted purchase whose claim the server refuses was adopted first elsewhere (another
    // iPhone on the same Apple Account): not invalid, it belongs to the account it was bound to.
    if checkout.original.is_some() && status == reqwest::StatusCode::FORBIDDEN && value["error"] == "claim" {
        account.update(|s| s.appstore.retain(|c| c.secret != secret))?;
        return owned_here(account).await.map(Some);
    }
    let verdict = verdict(status, &value)?;
    let mut state = None;
    account.update(|s| state = s.take_appstore_answer(secret, verdict, asked_for.as_deref(), &plan_key(), asked_at))?;
    Ok(state)
}

/// After a sign-in by code: every purchase waiting here is verified with the new session, which
/// binds those of its account; in the App Store build the transactions bound are then finished.
/// Best effort: one that fails is asked about again on the way back.
pub(super) async fn verify_waiting(app: &AppHandle) {
    verify_waiting_with(&Live(app)).await;
    #[cfg(appstore)]
    if let Ok(store) = commands::plugin(app) {
        if let Err(error) = resume(&Live(app), &commands::AppStore(store), None, false).await {
            eprintln!("Koona Pin: App Store transactions could not be settled after the sign-in: {}", error.message);
        }
    }
}

async fn verify_waiting_with<A: Account>(account: &A) {
    let billing = account.billing();
    if billing.get().appstore.iter().all(|c| c.jws.is_none()) {
        return;
    }
    let _one = billing.playing.lock().await;
    let secrets: Vec<String> = billing.get().appstore.iter().filter(|c| c.jws.is_some()).map(|c| c.secret.clone()).collect();
    for secret in secrets {
        if let Err(error) = verify(account, &secret).await {
            eprintln!("Koona Pin: an App Store purchase could not be verified after the sign-in: {}", error.message);
        }
    }
}

/// «Continue» on the email step, as Play's ([`super::play::play_claim_email`]).
#[tauri::command]
pub async fn appstore_claim_email(app: AppHandle, email: String) -> Result<PlayState, CommandError> {
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
    let Some(checkout) = billing.get().claimable_appstore().cloned() else {
        return Ok(PlayState::Invalid);
    };
    let body = json!({ "action": "appstore_email", "transaction": checkout.jws, "claim": checkout.secret, "email": email });
    let (status, value) = account.ask(body, None).await?;
    match email_answer_of_store(status, &value, "appstore", "billing appstore_email")? {
        EmailAnswer::Gone => {
            account.update(|s| s.finish_appstore(&checkout.secret, PlayState::Invalid))?;
            return Ok(PlayState::Invalid);
        }
        EmailAnswer::Unavailable => return Ok(PlayState::Kept),
        EmailAnswer::Code => {}
    }
    // Only a code that went out makes the code step: one that failed leaves the email step.
    account.send_code(email.clone()).await?;
    account.update(|s| {
        if let Some(kept) = s.appstore.iter_mut().find(|c| c.secret == checkout.secret) {
            kept.email = Some(email);
            kept.state = Some(PlayState::SignIn);
            s.appstore_followed = Some(checkout.secret.clone());
        }
    })?;
    Ok(PlayState::SignIn)
}

/// A purchase a payment may exist for, not confirmed now: kept, with its state saying so.
fn keep<A: Account>(account: &A, secret: &str, state: PlayState) -> Result<PlayState, CommandError> {
    account.update(|s| {
        if let Some(kept) = s.appstore.iter_mut().find(|c| c.secret == secret) {
            kept.state = Some(state);
        }
    })?;
    Ok(state)
}

/// After a payment the purchase is never lost to a failure: it is kept and asked about again.
fn kept_after_payment<A: Account>(account: &A, secret: &str, asked: Result<Option<PlayState>, CommandError>) -> Result<PlayState, CommandError> {
    match asked {
        Ok(Some(state)) => Ok(state),
        Ok(None) => Ok(PlayState::Error),
        Err(error) => {
            eprintln!("Koona Pin: an App Store purchase is kept, the server could not be asked: {}", error.message);
            keep(account, secret, PlayState::Kept)
        }
    }
}

/// Finishes every transaction StoreKit has unfinished that no purchase here claims any more: bound
/// or refused by the server, a renewal, a refund, one bought elsewhere. Then, signed in and when one
/// was finished, the plan is asked again (a renewal or a refund changes it). Best effort.
#[cfg(any(test, appstore))]
async fn settle<A: Account, S: Store>(account: &A, store: &S, unfinished: &[native::Transaction]) {
    let stored = account.billing().get();
    let done: Vec<&native::Transaction> = unfinished.iter().filter(|t| !stored.claims(&t.original_id, t.account_token.as_deref())).collect();
    if !done.is_empty() {
        if let Err(error) = store.finish(done.iter().map(|t| t.id.clone()).collect()).await {
            eprintln!("Koona Pin: App Store transactions could not be finished: {error}");
        }
    }
    if !done.is_empty() && stored.session.is_some() {
        account.check_plan().await;
    }
}

/// «Subscribe» or «Buy»: the App Store's sheet for this plan, then the server's verdict.
#[cfg(any(test, appstore))]
async fn purchase<A: Account, S: Store>(account: &A, store: &S, interval: PlanInterval) -> Result<PlayState, CommandError> {
    let billing = account.billing();
    let _one = billing.playing.lock().await;
    let checkout = started(interval, billing.get().session.map(|s| s.email), Utc::now());
    let secret = checkout.secret.clone();
    let token = account_token(&secret);
    let mut added = false;
    account.update(|s| added = s.add_appstore(checkout.clone()))?;
    if !added {
        return Err(too_many());
    }
    let bought = match store.buy(checkout.product.clone(), token.clone()).await {
        Ok(bought) => bought,
        Err(native::Error::Unavailable(_)) => {
            account.update(|s| s.finish_appstore(&secret, PlayState::Unavailable))?;
            return Ok(PlayState::Unavailable);
        }
        // No answer from the sheet: a payment may exist, kept and found by its token later.
        Err(native::Error::NoAnswer) => {
            eprintln!("Koona Pin: the App Store's sheet gave no answer, the purchase is kept");
            return keep(account, &secret, PlayState::Kept);
        }
        Err(error) => {
            eprintln!("Koona Pin: the App Store's sheet did not open: {error}");
            account.update(|s| s.finish_appstore(&secret, PlayState::Error))?;
            return Ok(PlayState::Error);
        }
    };
    match after_buy(bought, &token) {
        AfterBuy::Verify(transaction) => {
            account.update(|s| {
                s.find_appstore([&transaction]);
            })?;
            let state = kept_after_payment(account, &secret, verify(account, &secret).await);
            settle(account, store, std::slice::from_ref(&transaction)).await;
            state
        }
        AfterBuy::Pending => keep(account, &secret, PlayState::Pending),
        AfterBuy::Forget(state) => {
            account.update(|s| s.finish_appstore(&secret, state))?;
            Ok(state)
        }
        AfterBuy::Owned(transaction) => {
            // Nothing was bought now. A purchase made here before is verified again, and followed.
            let mut found = Vec::new();
            account.update(|s| {
                s.appstore.retain(|c| c.secret != secret);
                found = s.find_appstore([&transaction]);
                if let Some(earlier) = found.last() {
                    s.appstore_followed = Some(earlier.clone());
                }
            })?;
            if let Some(earlier) = found.last() {
                return kept_after_payment(account, earlier, verify(account, earlier).await);
            }
            Ok(owned_here(account).await?)
        }
    }
}

/// The Apple Account owns Supporter, and not by a purchase kept here: the account signed in is its
/// owner only when its plan, checked just now, is paid through the App Store; otherwise signing in
/// to the account that owns it shows the plan.
async fn owned_here<A: Account>(account: &A) -> Result<PlayState, CommandError> {
    let billing = account.billing();
    if billing.get().session.is_some() {
        account.check_plan().await;
    }
    let plan_store = super::effective(&billing.get(), Utc::now()).and_then(|plan| plan.store);
    let state = owned_in(PlanStore::AppStore, plan_store, false);
    account.update(|s| {
        s.appstore_outcome = Some((String::new(), state));
        s.appstore_followed = Some(String::new());
    })?;
    Ok(state)
}

/// Every purchase kept here: StoreKit's transactions (`reported` by `Transaction.updates`, else
/// what it has unfinished and owns) matched to their secrets, then each one verified unless asked
/// about seconds ago and not `now`, then the transactions no purchase here claims finished. The
/// first failure at the end.
#[cfg(any(test, appstore))]
async fn resume<A: Account, S: Store>(account: &A, store: &S, reported: Option<Vec<native::Transaction>>, now: bool) -> Result<(), CommandError> {
    let listed = reported.map(|unfinished| native::Transactions { unfinished, entitlements: Vec::new() });
    resume_with(account, store, listed, now).await
}

/// [`resume`] with StoreKit's transactions read already (`listed`), or read now when none.
#[cfg(any(test, appstore))]
async fn resume_with<A: Account, S: Store>(account: &A, store: &S, listed: Option<native::Transactions>, now: bool) -> Result<(), CommandError> {
    let billing = account.billing();
    account.update(|s| s.forget_old_appstore(Utc::now()))?;
    let _one = billing.playing.lock().await;
    let mut failure: Option<CommandError> = None;
    let listed = match listed {
        Some(listed) => Some(listed),
        None => match store.transactions(false).await {
            Ok(listed) => Some(listed),
            Err(error) => {
                eprintln!("Koona Pin: the App Store's transactions could not be read: {error}");
                failure = Some(store_failed(error));
                None
            }
        },
    };
    if let Some(listed) = &listed {
        account.update(|s| {
            let signed_in = s.session.as_ref().map(|session| session.email.clone());
            s.adopt_appstore(listed.entitlements.iter().chain(&listed.unfinished), signed_in, Utc::now());
            s.find_appstore(listed.entitlements.iter().chain(&listed.unfinished));
        })?;
    }
    let at = Utc::now();
    let due: Vec<String> = billing
        .get()
        .appstore
        .iter()
        .filter(|c| c.jws.is_some() && (now || c.asked_at.is_none_or(|asked| asked > at || at - asked >= FRESH)))
        .map(|c| c.secret.clone())
        .collect();
    for secret in due {
        if let Err(error) = verify(account, &secret).await {
            eprintln!("Koona Pin: an App Store purchase could not be verified: {}", error.message);
            failure.get_or_insert(error);
        }
    }
    settle(account, store, &listed.map(|l| l.unfinished).unwrap_or_default()).await;
    failure.map_or(Ok(()), Err)
}

/// «Try again» after a purchase was kept: the purchases here asked about again now, without the
/// App Store's sheet, as Play's.
#[cfg(any(test, appstore))]
async fn retry<A: Account, S: Store>(account: &A, store: &S) -> Result<PlayState, CommandError> {
    let asked = resume(account, store, None, true).await;
    let stored = account.billing().get();
    let signed_in = stored.session.as_ref().map(|s| s.email.clone());
    let unconfirmed = stored.appstore.iter().any(|c| c.jws.is_some() && ask_by(c.email.as_deref(), c.account.as_deref(), signed_in.as_deref()) != Ask::Skip);
    match (stored.appstore_progress(), asked) {
        (Some(progress), _) => Ok(progress.state),
        (None, Err(error)) => Err(error),
        (None, Ok(_)) if unconfirmed => Ok(PlayState::Kept),
        (None, Ok(_)) => Ok(PlayState::Error),
    }
}

/// «Restore purchases»: `AppStore.sync()`, then everything the Apple Account owns. A purchase made
/// here is verified again and its step shown; one made elsewhere belongs to the account it was
/// bound to: the plan here when it is that account, else signing in to it. Nothing owned:
/// `nothing_to_restore`. The person closing the Apple Account's sign-in: `canceled`.
#[cfg(any(test, appstore))]
async fn restore<A: Account, S: Store>(account: &A, store: &S) -> Result<PlayState, CommandError> {
    account.update(|s| {
        s.appstore_followed = None;
        s.appstore_outcome = None;
    })?;
    let listed = match store.transactions(true).await {
        Ok(listed) => listed,
        Err(native::Error::Canceled) => return Ok(PlayState::Canceled),
        Err(error) => return Err(store_failed(error)),
    };
    let entitlements = listed.entitlements.clone();
    resume_with(account, store, Some(listed), true).await?;
    let stored = account.billing().get();
    let ours: Vec<&native::Transaction> = entitlements.iter().filter(|t| !t.revoked).collect();
    // A purchase of this phone's among them: its own step (paid, email, sign in…).
    if let Some(found) = ours.iter().rev().find_map(|t| stored.claimant(&t.original_id, t.account_token.as_deref())) {
        let secret = found.secret.clone();
        account.update(|s| s.appstore_followed = Some(secret))?;
        if let Some(progress) = account.billing().get().appstore_progress() {
            return Ok(progress.state);
        }
    }
    if let Some(progress) = stored.appstore_outcome.as_ref().map(|(_, state)| *state) {
        return Ok(progress);
    }
    if ours.is_empty() {
        return Ok(PlayState::NothingToRestore);
    }
    owned_here(account).await
}

#[cfg(any(test, appstore))]
fn store_failed(error: native::Error) -> CommandError {
    CommandError::detailed(ErrorCode::Network, ErrorDetail::ServiceFailed, error.to_string())
}

// ── The App Store build ──────────────────────────────────────────────────────

#[cfg(appstore)]
pub use commands::*;

#[cfg(appstore)]
mod commands {
    use super::*;
    use tauri::{Manager, Wry};

    /// The plugin, as an owned handle a call can carry past its caller.
    pub(super) fn plugin(app: &AppHandle) -> Result<native::KoonaAppStore<Wry>, CommandError> {
        app.try_state::<native::KoonaAppStore<Wry>>()
            .map(|store| store.inner().clone())
            .ok_or_else(|| CommandError::internal("The App Store plugin is not registered"))
    }

    /// StoreKit through the plugin, each call within its time limit.
    pub(super) struct AppStore(pub(super) native::KoonaAppStore<Wry>);

    impl Store for AppStore {
        async fn buy(&self, product: String, account_token: String) -> Result<native::Bought, native::Error> {
            let store = self.0.clone();
            super::super::play::within_or(BUY_WAIT, async move { store.buy(&product, &account_token).await }, native::Error::NoAnswer).await
        }

        async fn transactions(&self, sync: bool) -> Result<native::Transactions, native::Error> {
            let store = self.0.clone();
            let wait = if sync { SYNC_WAIT } else { ASK_WAIT };
            super::super::play::within_or(wait, async move { store.transactions(sync).await }, native::Error::NoAnswer).await
        }

        async fn finish(&self, ids: Vec<String>) -> Result<(), native::Error> {
            let store = self.0.clone();
            super::super::play::within_or(ASK_WAIT, async move { store.finish(&ids).await }, native::Error::NoAnswer).await
        }
    }

    /// The prices for the sheet, from StoreKit, and whether this Apple Account's subscription is in
    /// billing retry (the sheet then offers to fix the payment in the App Store).
    #[tauri::command]
    pub async fn get_appstore_offer(app: AppHandle) -> Result<PlayOffer, CommandError> {
        let store = plugin(&app)?;
        match super::super::play::within_or(ASK_WAIT, async move { store.products(&PRODUCTS).await }, native::Error::NoAnswer).await {
            Ok(products) => Ok(offer_of(&products)),
            Err(native::Error::Unavailable(_)) => Ok(PlayOffer::default()),
            Err(error) => Err(store_failed(error)),
        }
    }

    /// «Subscribe» or «Buy»: the App Store's sheet for this plan, then the server's verdict.
    #[tauri::command]
    pub async fn start_appstore_purchase(app: AppHandle, interval: PlanInterval) -> Result<PlayState, CommandError> {
        super::super::need_service()?;
        purchase(&Live(&app), &AppStore(plugin(&app)?), interval).await
    }

    /// «Try again» after a purchase was kept: asked of the server again, not the App Store's sheet.
    #[tauri::command]
    pub async fn retry_appstore_purchase(app: AppHandle) -> Result<PlayState, CommandError> {
        super::super::need_service()?;
        retry(&Live(&app), &AppStore(plugin(&app)?)).await
    }

    /// «Restore purchases» (App Review 3.1.1): `AppStore.sync()` and what the Apple Account owns.
    #[tauri::command]
    pub async fn restore_appstore_purchases(app: AppHandle) -> Result<PlayState, CommandError> {
        super::super::need_service()?;
        restore(&Live(&app), &AppStore(plugin(&app)?)).await
    }

    /// «Manage in the App Store»: the system's sheet of this app's subscriptions.
    #[tauri::command]
    pub async fn manage_appstore_subscriptions(app: AppHandle) -> Result<(), CommandError> {
        let store = plugin(&app)?;
        store.manage().await.map_err(store_failed)
    }

    /// Looks for this app's transactions on start and each time the app comes back to the screen,
    /// and whenever `Transaction.updates` reports one.
    pub(in crate::billing) fn watch(app: &AppHandle) {
        let Ok(store) = plugin(app) else {
            return;
        };
        let reported = app.clone();
        let listening = store.clone();
        let registered = store.on_transactions(move |transactions| {
            let app = reported.clone();
            let store = AppStore(listening.clone());
            tauri::async_runtime::spawn(async move {
                if let Err(error) = resume(&Live(&app), &store, Some(transactions), false).await {
                    eprintln!("Koona Pin: a transaction the App Store reported could not be verified: {}", error.message);
                }
            });
        });
        if let Err(error) = registered {
            eprintln!("Koona Pin: the App Store's transactions event is not heard: {error}");
        }
        let app = app.clone();
        let mut foreground = crate::lifecycle::foreground(&app);
        tauri::async_runtime::spawn(async move {
            let store = AppStore(store);
            loop {
                foreground.wait().await;
                if let Err(error) = resume(&Live(&app), &store, None, false).await {
                    eprintln!("Koona Pin: App Store purchases could not be verified: {}", error.message);
                }
                foreground.suspended().await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::super::{status, Billing, Session};
    use super::*;
    use serde_json::Value;

    fn at(text: &str) -> DateTime<Utc> {
        text.parse().unwrap()
    }

    fn checkout(secret: &str, started: &str) -> AppStoreCheckout {
        AppStoreCheckout {
            secret: secret.into(),
            product: MONTHLY.into(),
            transaction: None,
            jws: None,
            email: None,
            started: at(started),
            state: None,
            asked_at: None,
            account: None,
            original: None,
        }
    }

    fn anna() -> Session {
        Session { access_token: "a".into(), refresh_token: "r".into(), expires_at: 0, email: "anna@example.com".into() }
    }

    fn bob() -> Session {
        Session { access_token: "b".into(), refresh_token: "rb".into(), expires_at: 0, email: "bob@example.com".into() }
    }

    #[test]
    fn the_account_token_is_a_version_4_uuid_from_the_sha256_of_the_secret() {
        // SHA-256("abc") = ba7816bf 8f01 cfea 4141 40de5dae2223…: version nibble c→4, variant 4→8.
        assert_eq!(account_token("abc"), "ba7816bf-8f01-4fea-8141-40de5dae2223");
        let token = account_token(&new_secret());
        let parsed = uuid::Uuid::parse_str(&token).unwrap();
        assert_eq!(parsed.get_version_num(), 4);
        assert_eq!(parsed.get_variant(), uuid::Variant::RFC4122);
        assert_eq!(token, token.to_lowercase());
    }

    #[test]
    fn each_plan_is_a_product_of_the_app_store() {
        assert_eq!(product_of(PlanInterval::Month), "app.koona.pin.supporter.monthly");
        assert_eq!(product_of(PlanInterval::Year), "app.koona.pin.supporter.annual");
        assert_eq!(product_of(PlanInterval::Lifetime), "app.koona.pin.supporter.lifetime");
    }

    #[test]
    fn the_servers_answers_are_read_as_plays_with_the_app_stores_error_name() {
        let verdict_of = |status: u16, value: Value| verdict(reqwest::StatusCode::from_u16(status).unwrap(), &value);
        assert_eq!(verdict_of(200, json!({ "status": "paid", "lease": null })).unwrap().state, PlayState::Paid);
        assert_eq!(verdict_of(200, json!({ "status": "suspended", "lease": null })).unwrap().state, PlayState::Suspended);
        assert_eq!(verdict_of(404, json!({ "error": "appstore" })).unwrap().state, PlayState::Unavailable);
        assert_eq!(verdict_of(403, json!({ "error": "claim" })).unwrap().state, PlayState::Invalid);
        // Play's error name says nothing about App Store purchases.
        assert!(verdict_of(404, json!({ "error": "play" })).is_err());
        let email = |status: u16, value: Value| email_answer_of_store(reqwest::StatusCode::from_u16(status).unwrap(), &value, "appstore", "billing appstore_email");
        assert_eq!(email(404, json!({ "error": "appstore" })).unwrap(), EmailAnswer::Unavailable);
        assert_eq!(email(200, json!({ "status": "code" })).unwrap(), EmailAnswer::Code);
    }

    #[test]
    fn storekits_products_are_the_sheets_prices() {
        let product = |id: &str, price: &str, micros: i64, period: Option<&str>| native::Product { id: id.into(), price: price.into(), currency: "USD".into(), micros, period: period.map(Into::into) };
        let offer = offer_of(&native::Products {
            products: vec![product(MONTHLY, "$1.49", 1_490_000, Some("P1M")), product(ANNUAL, "$9.99", 9_990_000, Some("P1Y")), product(LIFETIME_PRODUCT, "$29.99", 29_990_000, None)],
            suspended: false,
        });
        assert!(offer.available && !offer.suspended);
        assert_eq!(offer.month.map(|p| p.price), Some("$1.49".into()));
        assert_eq!(offer.year.map(|p| p.micros), Some(9_990_000));
        assert_eq!(offer.lifetime.map(|p| p.period), Some(None));
        // A subscription whose period is not its card's is not offered.
        let wrong = offer_of(&native::Products { products: vec![product(MONTHLY, "$4.49", 4_490_000, Some("P3M"))], suspended: true });
        assert_eq!(wrong.month, None);
        assert!(wrong.suspended);
    }

    #[test]
    fn a_purchase_survives_in_the_file_and_sign_out() {
        let mut stored = Stored { session: Some(anna()), ..Stored::default() };
        stored.add_appstore(AppStoreCheckout { transaction: Some("1".into()), jws: Some("j".into()), state: Some(PlayState::Email), ..checkout("s1", "2026-10-25T12:00:00Z") });
        let read: Stored = serde_json::from_str(&serde_json::to_string(&stored).unwrap()).unwrap();
        assert_eq!(read.appstore, stored.appstore);
        stored.signed_out();
        assert_eq!(stored.appstore.len(), 1, "its secret is its only claim");
        let old: Stored = serde_json::from_value(json!({ "session": null })).unwrap();
        assert!(old.appstore.is_empty(), "a file from before reads with none");
    }

    #[test]
    fn a_purchase_never_reported_is_forgotten_after_a_week_one_reported_waits() {
        let mut stored = Stored::default();
        stored.add_appstore(AppStoreCheckout { state: Some(PlayState::Pending), ..checkout("ask", "2026-10-20T12:00:00Z") });
        stored.add_appstore(AppStoreCheckout { transaction: Some("1".into()), jws: Some("j".into()), ..checkout("paid", "2026-10-01T12:00:00Z") });
        stored.forget_old_appstore(at("2026-10-27T12:00:00Z"));
        assert_eq!(stored.appstore.len(), 2);
        stored.forget_old_appstore(at("2026-10-27T12:00:01Z"));
        assert_eq!(stored.appstore.iter().map(|c| c.secret.as_str()).collect::<Vec<_>>(), ["paid"]);
    }

    #[test]
    fn a_new_purchase_never_drops_one_storekit_reported_or_one_that_waits() {
        let mut full = Stored::default();
        for i in 0..MAX_KEPT {
            assert!(full.add_appstore(AppStoreCheckout { transaction: Some(format!("t{i}")), ..checkout(&format!("r{i}"), "2026-10-25T12:00:00Z") }));
        }
        assert!(!full.add_appstore(checkout("new", "2026-10-25T13:00:00Z")), "refused, nothing dropped");
        let mut mixed = Stored::default();
        for i in 0..MAX_KEPT - 1 {
            mixed.add_appstore(AppStoreCheckout { state: Some(PlayState::Pending), ..checkout(&format!("ask{i}"), "2026-10-25T12:00:00Z") });
        }
        mixed.add_appstore(checkout("unreported", "2026-10-25T12:30:00Z"));
        assert!(mixed.add_appstore(checkout("new", "2026-10-25T13:00:00Z")));
        assert!(!mixed.appstore.iter().any(|c| c.secret == "unreported"));
    }

    // ── The steps, with fakes of the app and of StoreKit ────────────────────

    type Answering = Box<dyn Fn(&Value, Option<&str>) -> Result<(u16, Value), CommandError> + Send + Sync>;
    type Buying = Box<dyn Fn(&str, &str) -> Result<native::Bought, native::Error> + Send + Sync>;

    struct Fake {
        billing: Billing,
        folder: std::path::PathBuf,
        asked: std::sync::Mutex<Vec<(Value, Option<String>)>>,
        answer: std::sync::Mutex<Answering>,
        codes: std::sync::Mutex<Vec<String>>,
        plan_checks: std::sync::atomic::AtomicUsize,
        buy: std::sync::Mutex<Buying>,
        /// StoreKit's unfinished transactions and entitlements; `finish` takes one out.
        listed: std::sync::Mutex<Result<native::Transactions, native::Error>>,
        finished: std::sync::Mutex<Vec<String>>,
        synced: std::sync::atomic::AtomicBool,
    }

    impl Fake {
        fn new(answer: impl Fn(&Value, Option<&str>) -> Result<(u16, Value), CommandError> + Send + Sync + 'static) -> Fake {
            let folder = std::env::temp_dir().join(format!("koonapin-appstore-{}", new_secret()));
            Fake {
                billing: Billing::load(folder.join("account.json")),
                folder,
                asked: Default::default(),
                answer: std::sync::Mutex::new(Box::new(answer)),
                codes: Default::default(),
                plan_checks: Default::default(),
                buy: std::sync::Mutex::new(Box::new(|_, _| Err(native::Error::Failed("no sheet".into())))),
                listed: std::sync::Mutex::new(Ok(native::Transactions::default())),
                finished: Default::default(),
                synced: Default::default(),
            }
        }

        fn answers(&self, answer: impl Fn(&Value, Option<&str>) -> Result<(u16, Value), CommandError> + Send + Sync + 'static) {
            *self.answer.lock().unwrap() = Box::new(answer);
        }

        fn buys(&self, buy: impl Fn(&str, &str) -> Result<native::Bought, native::Error> + Send + Sync + 'static) {
            *self.buy.lock().unwrap() = Box::new(buy);
        }

        fn lists(&self, unfinished: Vec<native::Transaction>, entitlements: Vec<native::Transaction>) {
            *self.listed.lock().unwrap() = Ok(native::Transactions { unfinished, entitlements });
        }

        fn set(&self, change: impl FnOnce(&mut Stored)) {
            self.billing.apply(change).unwrap();
        }

        fn asked(&self, action: &str) -> Vec<(Value, Option<String>)> {
            self.asked.lock().unwrap().iter().filter(|(body, _)| body["action"] == action).cloned().collect()
        }

        fn finished(&self) -> Vec<String> {
            self.finished.lock().unwrap().clone()
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
            self.codes.lock().unwrap().push(email);
            Ok(())
        }

        async fn check_plan(&self) {
            self.plan_checks.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    impl Store for Fake {
        async fn buy(&self, product: String, account_token: String) -> Result<native::Bought, native::Error> {
            (self.buy.lock().unwrap())(&product, &account_token)
        }

        async fn transactions(&self, sync: bool) -> Result<native::Transactions, native::Error> {
            if sync {
                self.synced.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            self.listed.lock().unwrap().clone()
        }

        async fn finish(&self, ids: Vec<String>) -> Result<(), native::Error> {
            if let Ok(listed) = self.listed.lock().unwrap().as_mut() {
                listed.unfinished.retain(|t| !ids.contains(&t.id));
            }
            self.finished.lock().unwrap().extend(ids);
            Ok(())
        }
    }

    fn transaction(id: &str, product: &str, token: Option<&str>) -> native::Transaction {
        native::Transaction {
            id: id.into(),
            original_id: id.into(),
            product: product.into(),
            jws: format!("jws-{id}"),
            account_token: token.map(Into::into),
            revoked: false,
            verified: true,
        }
    }

    /// StoreKit's sheet bought the product asked for, with the token it was given.
    fn bought(id: &'static str) -> impl Fn(&str, &str) -> Result<native::Bought, native::Error> + Send + Sync + 'static {
        move |product, token| Ok(native::Bought { outcome: native::Outcome::Purchased, transaction: Some(transaction(id, product, Some(token))) })
    }

    fn run<T>(future: impl Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    fn offline() -> CommandError {
        CommandError::detailed(ErrorCode::Network, ErrorDetail::NoConnection, "offline")
    }

    fn paid() -> Result<(u16, Value), CommandError> {
        Ok((200, json!({ "status": "paid", "lease": null })))
    }

    #[test]
    fn each_plan_bought_signed_in_is_bound_with_the_session_and_then_finished() {
        for (interval, product) in [(PlanInterval::Month, MONTHLY), (PlanInterval::Year, ANNUAL), (PlanInterval::Lifetime, LIFETIME_PRODUCT)] {
            let fake = Fake::new(|_, _| paid());
            fake.set(|s| s.session = Some(anna()));
            fake.buys(bought("1001"));
            *fake.listed.lock().unwrap() = Ok(native::Transactions { unfinished: vec![transaction("1001", product, None)], entitlements: vec![] });
            assert_eq!(run(purchase(&fake, &fake, interval)).ok(), Some(PlayState::Paid), "{product}");
            let asked = fake.asked("appstore_verify");
            assert_eq!(asked.len(), 1);
            let (body, bearer) = &asked[0];
            assert_eq!((body["transaction"].as_str(), bearer.as_deref()), (Some("jws-1001"), Some("a")), "Anna's own session");
            assert_eq!(body["claim"].as_str().map(str::len), Some(64), "the secret, which the server hashes");
            assert!(body.get("product").is_none(), "the contract sends the transaction and the claim only");
            assert!(fake.billing.get().appstore.is_empty(), "bound: the secret is not needed any more");
            assert_eq!(fake.finished(), ["1001"], "finished once bound");
            assert_eq!(status(&fake.billing.get(), Utc::now()).appstore, Some(PlayProgress { state: PlayState::Paid, email: None }));
        }
    }

    #[test]
    fn the_purchase_carries_the_token_of_its_secret() {
        let fake = Fake::new(|_, _| Ok((200, json!({ "status": "email" }))));
        fake.buys(bought("7"));
        run(purchase(&fake, &fake, PlanInterval::Month)).unwrap();
        let kept = &fake.billing.get().appstore[0];
        let asked = fake.asked("appstore_verify");
        assert_eq!(asked[0].0["claim"].as_str(), Some(kept.secret.as_str()));
        assert_eq!(kept.transaction.as_deref(), Some("7"));
        assert!(fake.billing.get().claims("any", Some(&account_token(&kept.secret).to_uppercase())), "StoreKit's case does not matter");
    }

    #[test]
    fn signed_out_the_email_claims_the_purchase_and_the_sign_in_binds_it_before_it_is_finished() {
        let fake = Fake::new(|body, bearer| {
            let status = match (body["action"].as_str(), bearer) {
                (Some("appstore_email"), _) => "code",
                (_, Some("a")) => "paid",
                _ => "email",
            };
            Ok((200, json!({ "status": status, "lease": null })))
        });
        fake.buys(bought("2001"));
        assert_eq!(run(purchase(&fake, &fake, PlanInterval::Year)).ok(), Some(PlayState::Email));
        assert!(fake.finished().is_empty(), "never finished before it is bound");
        let secret = fake.billing.get().appstore[0].secret.clone();
        fake.lists(vec![transaction("2001", ANNUAL, Some(&account_token(&secret)))], vec![]);
        assert_eq!(run(claim_email(&fake, " anna@example.com ".into())).ok(), Some(PlayState::SignIn));
        assert_eq!(*fake.codes.lock().unwrap(), ["anna@example.com"]);
        let email = fake.asked("appstore_email");
        assert_eq!((email[0].0["transaction"].as_str(), email[0].1.as_deref()), (Some("jws-2001"), None));
        assert_eq!(status(&fake.billing.get(), Utc::now()).appstore, Some(PlayProgress { state: PlayState::SignIn, email: Some("anna@example.com".into()) }));
        // The app comes back from the mail app: still unbound, still unfinished.
        run(resume(&fake, &fake, None, true)).unwrap();
        assert!(fake.finished().is_empty());
        // The code signs Anna in: bound with her session, then finished.
        fake.set(|s| s.session = Some(anna()));
        run(verify_waiting_with(&fake));
        assert_eq!(fake.billing.get().appstore_progress().map(|p| p.state), Some(PlayState::Paid));
        run(resume(&fake, &fake, None, false)).unwrap();
        assert_eq!(fake.finished(), ["2001"]);
    }

    #[test]
    fn a_purchase_is_asked_about_only_with_the_session_of_its_account() {
        let fake = Fake::new(|_, _| Ok((200, json!({ "status": "pending" }))));
        fake.set(|s| s.session = Some(anna()));
        fake.buys(bought("3001"));
        run(purchase(&fake, &fake, PlanInterval::Month)).unwrap();
        let secret = fake.billing.get().appstore[0].secret.clone();
        fake.lists(vec![transaction("3001", MONTHLY, Some(&account_token(&secret)))], vec![]);
        fake.set(|s| s.session = Some(bob()));
        run(verify_waiting_with(&fake));
        run(resume(&fake, &fake, None, true)).unwrap();
        assert!(fake.asked("appstore_verify").iter().all(|(_, bearer)| bearer.as_deref() != Some("b")));
        assert_eq!(fake.asked("appstore_verify").len(), 1, "not asked at all with another account here");
        assert!(fake.finished().is_empty(), "Anna's purchase is still hers to claim");
    }

    #[test]
    fn a_cancelled_or_refused_sheet_keeps_nothing_and_asks_nothing() {
        for (answer, expected) in [
            (Ok(native::Bought { outcome: native::Outcome::Canceled, transaction: None }), PlayState::Canceled),
            (Err(native::Error::Unavailable("Screen Time".into())), PlayState::Unavailable),
            (Err(native::Error::Failed("no network".into())), PlayState::Error),
            (Ok(native::Bought { outcome: native::Outcome::Unavailable, transaction: None }), PlayState::Unavailable),
        ] {
            let fake = Fake::new(|_, _| unreachable!("nothing to ask"));
            fake.buys(move |_, _| answer.clone());
            assert_eq!(run(purchase(&fake, &fake, PlanInterval::Month)).ok(), Some(expected));
            assert!(fake.billing.get().appstore.is_empty());
            assert!(fake.finished().is_empty());
        }
    }

    #[test]
    fn ask_to_buy_waits_and_the_approval_reported_later_is_bound() {
        let fake = Fake::new(|_, _| paid());
        fake.set(|s| s.session = Some(anna()));
        fake.buys(|_, _| Ok(native::Bought { outcome: native::Outcome::Pending, transaction: None }));
        assert_eq!(run(purchase(&fake, &fake, PlanInterval::Lifetime)).ok(), Some(PlayState::Pending));
        assert!(fake.asked("appstore_verify").is_empty(), "nothing to verify yet");
        let stored = fake.billing.get();
        assert_eq!(stored.appstore_progress().map(|p| p.state), Some(PlayState::Pending), "the sheet shows the wait, after a restart too");
        // The parent approves: Transaction.updates reports it.
        let token = account_token(&stored.appstore[0].secret);
        let approved = transaction("4001", LIFETIME_PRODUCT, Some(&token));
        fake.lists(vec![approved.clone()], vec![approved.clone()]);
        run(resume(&fake, &fake, Some(vec![approved]), false)).unwrap();
        assert_eq!(fake.billing.get().appstore_progress().map(|p| p.state), Some(PlayState::Paid));
        assert_eq!(fake.finished(), ["4001"]);
    }

    #[test]
    fn a_purchase_the_server_could_not_confirm_is_kept_unfinished_and_asked_again() {
        let fake = Fake::new(|_, _| Err(offline()));
        fake.buys(bought("5001"));
        assert_eq!(run(purchase(&fake, &fake, PlanInterval::Year)).ok(), Some(PlayState::Kept));
        let secret = fake.billing.get().appstore[0].secret.clone();
        fake.lists(vec![transaction("5001", ANNUAL, Some(&account_token(&secret)))], vec![]);
        // The server does not verify App Store purchases yet (no keys): still kept.
        fake.answers(|_, _| Ok((404, json!({ "error": "appstore" }))));
        assert_eq!(run(retry(&fake, &fake)).ok(), Some(PlayState::Kept));
        assert!(fake.finished().is_empty(), "never finished while unclaimed");
        // A restart: the kept purchase is what the sheet resumes on.
        let restarted = Billing::load(fake.folder.join("account.json")).get();
        assert_eq!(restarted.appstore_progress(), Some(PlayProgress { state: PlayState::Kept, email: None }));
        // Then it answers.
        fake.answers(|_, _| Ok((200, json!({ "status": "email" }))));
        assert_eq!(run(retry(&fake, &fake)).ok(), Some(PlayState::Email));
        // No answer from the sheet at all: kept too.
        let hung = Fake::new(|_, _| unreachable!("nothing reported to ask about"));
        hung.buys(|_, _| Err(native::Error::NoAnswer));
        assert_eq!(run(purchase(&hung, &hung, PlanInterval::Month)).ok(), Some(PlayState::Kept));
        assert_eq!(hung.billing.get().appstore.len(), 1);
    }

    #[test]
    fn owned_already_recovers_the_purchase_made_here_before() {
        let fake = Fake::new(|body, _| Ok((200, json!({ "status": if body["transaction"] == "jws-6000" { "email" } else { "invalid" } }))));
        fake.set(|s| s.appstore.push(AppStoreCheckout { state: Some(PlayState::Kept), ..checkout("s0", "2026-10-25T10:00:00Z") }));
        let earlier = transaction("6000", MONTHLY, Some(&account_token("s0")));
        fake.buys(move |_, _| Ok(native::Bought { outcome: native::Outcome::Purchased, transaction: Some(earlier.clone()) }));
        assert_eq!(run(purchase(&fake, &fake, PlanInterval::Month)).ok(), Some(PlayState::Email));
        let stored = fake.billing.get();
        assert_eq!(stored.appstore.iter().map(|c| c.secret.as_str()).collect::<Vec<_>>(), ["s0"], "the new one is gone, the old one kept");
        // Owned by a purchase made elsewhere, signed out: sign in to its account.
        let elsewhere = Fake::new(|_, _| unreachable!("nothing of this phone's to ask"));
        elsewhere.buys(|_, _| Ok(native::Bought { outcome: native::Outcome::Purchased, transaction: Some(transaction("6100", ANNUAL, Some("00000000-0000-4000-8000-000000000000"))) }));
        assert_eq!(run(purchase(&elsewhere, &elsewhere, PlanInterval::Year)).ok(), Some(PlayState::Owned));
        assert!(elsewhere.billing.get().appstore.is_empty());
        assert_eq!(elsewhere.billing.get().appstore_progress().map(|p| p.state), Some(PlayState::Owned));
    }

    #[test]
    fn restore_verifies_what_was_bought_here_and_points_to_the_account_of_the_rest() {
        // A purchase made here, unbound: restore finds it and shows its step.
        let fake = Fake::new(|_, _| Ok((200, json!({ "status": "email" }))));
        fake.set(|s| s.appstore.push(checkout("s1", "2026-10-25T10:00:00Z")));
        let mine = transaction("7001", ANNUAL, Some(&account_token("s1")));
        fake.lists(vec![], vec![mine]);
        assert_eq!(run(restore(&fake, &fake)).ok(), Some(PlayState::Email));
        assert!(fake.synced.load(std::sync::atomic::Ordering::SeqCst), "AppStore.sync() first");
        // Bought on another iPhone and bound there: no secret here; signed out, sign in to it.
        let other = Fake::new(|_, _| unreachable!("no claim here to ask with"));
        other.lists(vec![], vec![transaction("7100", MONTHLY, Some("00000000-0000-4000-8000-000000000000"))]);
        assert_eq!(run(restore(&other, &other)).ok(), Some(PlayState::Owned));
        // Nothing owned at all, or only refunded.
        let none = Fake::new(|_, _| unreachable!());
        assert_eq!(run(restore(&none, &none)).ok(), Some(PlayState::NothingToRestore));
        none.lists(vec![], vec![native::Transaction { revoked: true, ..transaction("7200", LIFETIME_PRODUCT, None) }]);
        assert_eq!(run(restore(&none, &none)).ok(), Some(PlayState::NothingToRestore));
        // The person closes the Apple Account's sign-in.
        *none.listed.lock().unwrap() = Err(native::Error::Canceled);
        assert_eq!(run(restore(&none, &none)).ok(), Some(PlayState::Canceled));
        // The App Store out of reach: a failure the sheet says, nothing changed.
        *none.listed.lock().unwrap() = Err(native::Error::Failed("offline".into()));
        assert!(run(restore(&none, &none)).is_err());
    }

    #[test]
    fn a_refund_or_a_renewal_reported_later_is_finished_and_the_plan_asked_again() {
        let fake = Fake::new(|_, _| unreachable!("no purchase of this phone's waits"));
        fake.set(|s| s.session = Some(anna()));
        // Refunded from Xcode's transaction manager: StoreKit reports it on the next start.
        let refunded = native::Transaction { revoked: true, ..transaction("8001", MONTHLY, Some("00000000-0000-4000-8000-000000000001")) };
        fake.lists(vec![refunded.clone()], vec![]);
        run(resume(&fake, &fake, Some(vec![refunded]), false)).unwrap();
        assert_eq!(fake.finished(), ["8001"]);
        assert_eq!(fake.plan_checks.load(std::sync::atomic::Ordering::SeqCst), 1, "the plan is asked again");
        // A refund of a purchase still waiting here: the server says invalid, it is done.
        let waiting = Fake::new(|_, _| Ok((200, json!({ "status": "invalid" }))));
        waiting.set(|s| s.appstore.push(AppStoreCheckout { transaction: Some("8100".into()), jws: Some("old".into()), state: Some(PlayState::Email), ..checkout("s1", "2026-10-25T10:00:00Z") }));
        let revoked = native::Transaction { revoked: true, ..transaction("8100", MONTHLY, Some(&account_token("s1"))) };
        waiting.lists(vec![revoked.clone()], vec![]);
        run(resume(&waiting, &waiting, Some(vec![revoked]), false)).unwrap();
        assert_eq!(waiting.asked("appstore_verify")[0].0["transaction"], "jws-8100", "the newest signed form");
        assert!(waiting.billing.get().appstore.is_empty());
        assert_eq!(waiting.finished(), ["8100"]);
    }

    #[test]
    fn a_purchase_made_outside_the_app_is_adopted_once_and_finished_only_once_bound() {
        // An offer code redeemed in the App Store: no account token, so no secret here claims it.
        let fake = Fake::new(|_, _| Ok((200, json!({ "status": "paid", "lease": null }))));
        fake.set(|s| s.session = Some(anna()));
        let redeemed = transaction("9500", ANNUAL, None);
        fake.lists(vec![redeemed.clone()], vec![redeemed.clone()]);
        run(resume(&fake, &fake, None, false)).unwrap();
        let asked = fake.asked("appstore_verify");
        assert_eq!(asked.len(), 1, "adopted with a fresh secret and verified");
        assert_eq!(asked[0].0["transaction"], "jws-9500");
        assert!(fake.billing.get().appstore.is_empty(), "bound, so done");
        assert_eq!(fake.finished(), ["9500"]);
        // Seen again (Restore, the next start): never adopted a second time.
        fake.lists(vec![], vec![redeemed]);
        run(resume(&fake, &fake, None, false)).unwrap();
        assert_eq!(fake.asked("appstore_verify").len(), 1);
        // The server out of reach: kept, and the transaction stays unfinished.
        let offline = Fake::new(|_, _| Err(CommandError::detailed(ErrorCode::Network, ErrorDetail::ServiceFailed, "offline")));
        let other = transaction("9600", MONTHLY, None);
        offline.lists(vec![other.clone()], vec![other]);
        assert!(run(resume(&offline, &offline, None, false)).is_err());
        assert_eq!(offline.billing.get().appstore.len(), 1);
        assert!(offline.finished().is_empty());
    }

    #[test]
    fn a_renewed_purchase_made_outside_the_app_is_adopted_by_its_original_transaction() {
        // What the Apple Account owns is the renewal; the first transaction was finished long ago.
        let fake = Fake::new(|_, _| Ok((200, json!({ "status": "email" }))));
        let renewal = native::Transaction { original_id: "9700".into(), ..transaction("9701", ANNUAL, None) };
        fake.lists(vec![], vec![renewal.clone()]);
        run(resume(&fake, &fake, None, false)).unwrap();
        let kept = fake.billing.get().appstore;
        assert_eq!(kept.len(), 1);
        assert_eq!((kept[0].original.as_deref(), kept[0].jws.as_deref()), (Some("9700"), Some("jws-9701")));
        // A later renewal, still unfinished, is the same purchase: claimed, never finished, not adopted again.
        let next = native::Transaction { original_id: "9700".into(), ..transaction("9702", ANNUAL, None) };
        fake.lists(vec![next.clone()], vec![next]);
        run(resume(&fake, &fake, None, true)).unwrap();
        assert_eq!(fake.billing.get().appstore.len(), 1);
        assert_eq!(fake.billing.get().appstore[0].jws.as_deref(), Some("jws-9702"), "the newest signed form");
        assert!(fake.finished().is_empty());
        // Restore shows its own step (the email), not «sign in to the account that owns it».
        assert_eq!(run(restore(&fake, &fake)).ok(), Some(PlayState::Email));
    }

    #[test]
    fn a_purchase_adopted_first_on_another_iphone_belongs_to_that_account() {
        let fake = Fake::new(|_, _| Ok((403, json!({ "error": "claim" }))));
        fake.lists(vec![], vec![transaction("9800", LIFETIME_PRODUCT, None)]);
        assert_eq!(run(restore(&fake, &fake)).ok(), Some(PlayState::Owned));
        assert!(fake.billing.get().appstore.is_empty());
    }

    #[test]
    fn purchases_adopted_and_unclaimed_never_stop_a_purchase() {
        let fake = Fake::new(|_, _| Ok((200, json!({ "status": "email" }))));
        let codes: Vec<native::Transaction> = (0..MAX_KEPT + 2).map(|i| transaction(&format!("99{i:02}"), MONTHLY, None)).collect();
        fake.lists(vec![], codes);
        run(resume(&fake, &fake, None, false)).unwrap();
        assert_eq!(fake.billing.get().appstore.len(), MAX_KEPT + 2);
        let mut room = fake.billing.get();
        assert!(room.add_appstore(checkout("new", "2026-10-25T10:00:00Z")));
    }

    #[test]
    fn already_a_supporter_or_another_accounts_purchase_ends_it() {
        for (answer, expected) in [("already_supporter", PlayState::AlreadySupporter), ("other_account", PlayState::OtherAccount), ("invalid", PlayState::Invalid)] {
            let fake = Fake::new(move |_, _| Ok((200, json!({ "status": answer, "lease": null }))));
            fake.set(|s| s.session = Some(anna()));
            fake.buys(bought("9001"));
            assert_eq!(run(purchase(&fake, &fake, PlanInterval::Lifetime)).ok(), Some(expected), "{answer}");
            assert!(fake.billing.get().appstore.is_empty());
            assert_eq!(fake.finished(), ["9001"]);
        }
    }
}
