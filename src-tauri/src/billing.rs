//! Supporter (NP-066, Р-64, sheet 45): the plan the app keeps, buying it in the browser and
//! signing in on another computer. The plan comes signed by the server (a lease, `PLAN_KEY`)
//! and only what verifies counts, so editing `account.json` changes nothing. It is kept without
//! asking until its `offline_until`: 30 days from the server's last answer, never past the paid
//! period and a week of grace. The server is asked once a week, daily in the last three days of
//! the period, when the Supporter dialog opens, and while the purchase dialog waits for a payment.
//! Free features never depend on any of it, and sync checks the plan on its own server.
//!
//! Sales are closed until sync ships (Р-64): a build without the account service, or a sandbox
//! one that is not a development build, has no purchase at all.
//!
//! The Google Play build sells through Play Billing instead of Paddle (NP-154, [`play`]): the
//! purchase comes first, the email given after it claims it, and the server binds it once the code
//! from that email has signed in.

pub mod deletion;
pub mod play;

use crate::error::{CommandError, ErrorCode, ErrorDetail};
use chrono::{DateTime, TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use ts_rs::TS;

pub const EVENT: &str = "supporter-status";
pub(crate) const FILE: &str = "account.json";

/// The Supabase project of accounts and the environment of Paddle, from `.env` (build.rs).
const URL: Option<&str> = option_env!("KOONAPIN_ACCOUNT_URL");
const KEY: Option<&str> = option_env!("KOONAPIN_ACCOUNT_KEY");
const ENVIRONMENT: Option<&str> = option_env!("KOONAPIN_PADDLE_ENV");

/// The last days of a paid period, when the app asks once a day whether it renewed.
const RENEWAL_WINDOW: TimeDelta = TimeDelta::days(3);
const CHECK_EVERY: TimeDelta = TimeDelta::days(1);
/// After a check that failed: the background (hourly) asks again at its next wake.
const CHECK_AGAIN: TimeDelta = TimeDelta::hours(1);
/// Before them, once a week: a change of plan, a cancellation or a refund shows within a week
/// without asking more often (the Supporter dialog also asks when it opens).
const CHECK_WEEKLY: TimeDelta = TimeDelta::days(7);
/// An automatic check this soon after the last one is not asked again.
const FRESH: TimeDelta = TimeDelta::seconds(15);
/// The dialog says the plan could not be checked this long before it would stop offline.
const WARN_OFFLINE: TimeDelta = TimeDelta::days(7);
/// The server's Ed25519 public key for plans (koona-services `_shared/lease.ts`), raw, base64.
const PLAN_KEY: &str = "f7D5WIrZOYI9609dzdH7bj/tHaMyXI482chUwA4m86E=";
/// A purchase started but not seen paid is forgotten after this.
const CLAIM_LIFETIME: TimeDelta = TimeDelta::days(2);
/// Purchases waiting at once: one per plan is the usual case, a few more cover going back and forth.
const MAX_CHECKOUTS: usize = 4;
/// How often the app asks about a purchase waiting here, by the age of the newest one: often while
/// the payment page is likely open, then rarely until CLAIM_LIFETIME. Never without one.
const CLAIM_EVERY: [(TimeDelta, Duration); 3] = [
    (TimeDelta::minutes(30), Duration::from_secs(15)),
    (TimeDelta::hours(3), Duration::from_secs(60)),
    (CLAIM_LIFETIME, Duration::from_secs(10 * 60)),
];
const TICK: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Copy)]
pub struct Service {
    pub url: &'static str,
    pub key: &'static str,
    pub sandbox: bool,
}

/// The account service of this build, if it sells anything.
pub fn service() -> Option<Service> {
    service_of(URL, KEY, ENVIRONMENT, cfg!(play), cfg!(debug_assertions))
}

/// The account service from the build's settings. Paddle's environment says whether it is the
/// sandbox; the Google Play build (`play`, NP-154) sells nothing through Paddle, so it needs only the
/// accounts project, and without the setting it is production. A sandbox never reaches a build
/// people install (`debug` false).
fn service_of(url: Option<&'static str>, key: Option<&'static str>, environment: Option<&str>, play: bool, debug: bool) -> Option<Service> {
    let (url, key) = (url?, key?);
    let sandbox = match environment {
        Some("sandbox") => true,
        Some("production") => false,
        None if play => false,
        _ => return None,
    };
    if sandbox && !debug {
        return None;
    }
    Some(Service { url: url.trim_end_matches('/'), key, sandbox })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum PlanStatus {
    Active,
    /// Paddle could not take the renewal and tries again.
    PastDue,
    /// Canceled at the end of the period: no renewal.
    Canceling,
}

/// What can be bought, and what the plan is: a subscription, or Supporter's one-time purchase, paid once,
/// which never renews and never ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum PlanInterval {
    Month,
    Year,
    Lifetime,
}

/// Where the plan is paid and managed (NP-154): the channel of the renewing subscription, else of
/// the purchase that sets `valid_until`. «Manage» opens Paddle's portal or Google Play's
/// subscriptions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Store {
    Paddle,
    Play,
}

/// The plan as the server signed it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Plan {
    pub status: PlanStatus,
    pub interval: Option<PlanInterval>,
    /// The end of the paid period; none for the one-time purchase, which has no end (a Play license tester's
    /// test purchase of it has its one day).
    #[ts(type = "string | null")]
    pub valid_until: Option<DateTime<Utc>>,
    #[ts(type = "string | null")]
    pub renews_at: Option<DateTime<Utc>>,
    /// Kept until then without an answer from the server.
    #[ts(type = "string")]
    pub offline_until: DateTime<Utc>,
    /// Paid once, and a subscription of the account still renews: the dialog says to cancel it.
    #[serde(default)]
    pub also_renews: bool,
    /// Where it is paid; none from a server before NP-154, which sold through Paddle only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub store: Option<Store>,
}

/// The plan signed by the server: `payload` is the exact text signed, kept as it came.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Lease {
    payload: String,
    signature: String,
}

/// What `payload` says (koona-services `_shared/lease.ts`).
#[derive(Deserialize)]
struct LeaseTerms {
    v: u32,
    email: String,
    plan: SignedPlan,
    offline_until: DateTime<Utc>,
}

#[derive(Deserialize)]
struct SignedPlan {
    status: PlanStatus,
    interval: Option<PlanInterval>,
    valid_until: Option<DateTime<Utc>>,
    renews_at: Option<DateTime<Utc>>,
    #[serde(default)]
    also_renews: bool,
    /// A store this build does not know reads as none: never a reason to drop the whole lease.
    #[serde(default, deserialize_with = "known_store")]
    store: Option<Store>,
}

fn known_store<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Store>, D::Error> {
    Ok(Option::<Value>::deserialize(deserializer)?.and_then(|value| serde_json::from_value(value).ok()))
}

/// What a `plan` or `claim` answer says about the plan: whether the server names one at all, and
/// its signed lease.
struct Answer {
    has_plan: bool,
    lease: Option<Lease>,
    /// The account's scheduled deletion (`deletion`), none when there is none: a deletion scheduled
    /// on the web or another device shows here, one kept there or ended by a new purchase goes.
    delete_at: Option<DateTime<Utc>>,
}

impl Answer {
    /// The answer in a reply of the function, which always names `lease`: the signed plan, or null
    /// for none (koona-services `billing/handler.ts`, `planFor`). A body that does not (not JSON,
    /// a proxy's page, a reply cut short) says nothing about the plan and is never «no plan»: as a
    /// plan named that does not verify, it keeps what is here and counts as a failed check.
    fn of(value: &Value) -> Answer {
        let lease = value.as_object().and_then(|o| o.get("lease")).filter(|l| l.is_null() || l.is_object());
        match lease {
            Some(lease) => Answer {
                has_plan: value["plan"].is_object() || lease.is_object(),
                lease: serde_json::from_value(lease.clone()).unwrap_or(None),
                delete_at: value["delete_at"].as_str().and_then(|text| text.parse().ok()),
            },
            None => Answer { has_plan: true, lease: None, delete_at: None },
        }
    }
}

/// The plan of a lease when `key` verifies its signature and it is for `email`; None otherwise.
fn plan_of(lease: &Lease, email: &str, key: &[u8]) -> Option<Plan> {
    use base64::Engine;
    let signature = base64::engine::general_purpose::STANDARD.decode(&lease.signature).ok()?;
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key).verify(lease.payload.as_bytes(), &signature).ok()?;
    let terms: LeaseTerms = serde_json::from_str(&lease.payload).ok()?;
    if terms.v != 1 || !terms.email.eq_ignore_ascii_case(email.trim()) {
        return None;
    }
    let SignedPlan { status, interval, valid_until, renews_at, also_renews, store } = terms.plan;
    Some(Plan { status, interval, valid_until, renews_at, offline_until: terms.offline_until, also_renews, store })
}

fn plan_key() -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(PLAN_KEY).unwrap_or_default()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Session {
    access_token: String,
    refresh_token: String,
    /// Unix seconds.
    expires_at: i64,
    email: String,
}

/// `account.json` next to the library.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Stored {
    /// The account belongs to Paddle's sandbox: a production build forgets it.
    #[serde(default)]
    sandbox: bool,
    session: Option<Session>,
    /// The plan as the server signed it; `plan` is only what of it verifies, never read from the file.
    #[serde(default)]
    lease: Option<Lease>,
    #[serde(skip)]
    plan: Option<Plan>,
    /// The unsigned plan of the builds before 0.10: read only to ask the server at once.
    #[serde(default, rename = "plan", skip_serializing)]
    unsigned_plan: Option<Value>,
    checked_at: Option<DateTime<Utc>>,
    #[serde(default)]
    check_failed: bool,
    /// Purchases started here and not seen paid yet, oldest first. Starting another never drops
    /// one: a payment finished in an older browser tab is still picked up.
    #[serde(default)]
    checkouts: Vec<Checkout>,
    /// A purchase here went through with the email of an account that existed before: the plan
    /// is that account's, and this computer signs in with the code from the email. Kept until it
    /// does, so the dialog says so whenever it is opened, whoever saw the payment first.
    #[serde(default)]
    awaiting_sign_in: bool,
    /// The last purchase seen paid here was the one-time purchase bought again by an account that
    /// has it, which the server refunds: the dialog says so instead of «thank you», whoever saw the
    /// payment first. Cleared by the next purchase started here.
    #[serde(default)]
    paid_again: bool,
    /// The first builds (0.8.0) kept a single purchase; read once and moved into `checkouts`.
    #[serde(default, skip_serializing)]
    claim: Option<String>,
    #[serde(default, skip_serializing)]
    claim_started: Option<DateTime<Utc>>,
    /// Purchases made here through Google Play and not bound to an account yet, oldest first
    /// (NP-154). Kept over Sign out: a paid purchase's secret is its only claim.
    #[serde(default)]
    play: Vec<play::PlayCheckout>,
    /// What the last Play purchase finished as in this run, once it left `play`: its secret and state.
    #[serde(skip)]
    play_outcome: Option<(String, play::PlayState)>,
    /// The Play purchase the sheet follows in this run: the one bought last, or claimed by an email.
    #[serde(skip)]
    play_followed: Option<String>,
    /// The account is deleted on this date unless kept (billing/deletion.rs): what the server said last.
    #[serde(default)]
    delete_at: Option<DateTime<Utc>>,
    /// A `delete_account` request went out and its answer did not come (billing/deletion.rs): kept
    /// over a restart and over a session that stopped working, so «Check again» can still tell.
    #[serde(default)]
    deletion_sent: Option<deletion::SentDeletion>,
}

/// A purchase started here: the secret the server knows by its hash, and the payment page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Checkout {
    secret: String,
    started: DateTime<Utc>,
    /// None for a purchase kept by 0.8.0, which did not record it.
    interval: Option<PlanInterval>,
    url: Option<String>,
}

impl Stored {
    /// Signed out, as «Sign out» leaves the file: the environment stays, and Play purchases not bound
    /// yet (NP-154), whose secrets are their only claim; the account and all of its state go.
    fn signed_out(&mut self) {
        *self = Stored { sandbox: self.sandbox, play: std::mem::take(&mut self.play), ..Stored::default() };
    }

    /// Keeps the server's signed plan and what of it verifies for the account signed in here.
    fn keep_lease(&mut self, lease: Option<Lease>, key: &[u8]) {
        self.plan = match (&lease, &self.session) {
            (Some(lease), Some(session)) => plan_of(lease, &session.email, key),
            _ => None,
        };
        self.lease = lease;
    }

    /// The server's answer about the plan, asked at `at`. When it says there is a plan but nothing
    /// signed verifies (an old server, a key out of step), it is a failed check that keeps what is
    /// here, as when offline: never «no plan» for a plan the app could not verify.
    fn take_answer(&mut self, answer: Answer, key: &[u8], at: DateTime<Utc>) {
        let verified = match (&answer.lease, &self.session) {
            (Some(lease), Some(session)) => plan_of(lease, &session.email, key),
            _ => None,
        };
        self.checked_at = Some(at);
        if answer.has_plan && verified.is_none() {
            eprintln!("The server's answer has no plan that verifies; the plan here is kept");
            self.check_failed = true;
        } else {
            self.keep_lease(answer.lease, key);
            self.check_failed = false;
            // The date is the server's: an answer without one clears it.
            self.delete_at = answer.delete_at;
        }
    }

    /// The single purchase of 0.8.0 as the first of the list.
    fn migrate(&mut self) {
        if let Some(secret) = self.claim.take() {
            let started = self.claim_started.take().unwrap_or_else(Utc::now);
            self.checkouts.insert(0, Checkout { secret, started, interval: None, url: None });
        }
    }

    /// Drops purchases too old to be paid now.
    fn forget_old(&mut self, now: DateTime<Utc>) {
        self.checkouts.retain(|c| now - c.started <= CLAIM_LIFETIME);
    }

    /// A purchase of this plan still waiting, to open again instead of a second payment.
    fn waiting(&self, interval: PlanInterval, now: DateTime<Utc>) -> Option<&Checkout> {
        self.checkouts.iter().rev().find(|c| c.interval == Some(interval) && c.url.is_some() && now - c.started <= CLAIM_LIFETIME)
    }

    fn add_checkout(&mut self, checkout: Checkout) {
        self.paid_again = false;
        self.checkouts.push(checkout);
        let extra = self.checkouts.len().saturating_sub(MAX_CHECKOUTS);
        self.checkouts.drain(..extra);
    }

    /// Signed in by a paid purchase: that one is done; the others started here keep waiting, a
    /// payment in their tabs is still picked up. Only while the purchase is still here: an answer
    /// that arrives after Sign out (which forgets every purchase) changes nothing. False then.
    fn signed_in_by(&mut self, secret: &str, session: Session, answer: Answer, key: &[u8], now: DateTime<Utc>) -> bool {
        if !self.checkouts.iter().any(|c| c.secret == secret) {
            return false;
        }
        // As any sign-in: what another account left here goes first, so an answer that fails (a
        // reply without its plan) keeps nothing of that account for this one.
        self.sign_in(session, key);
        self.take_answer(answer, key, now);
        self.checkouts.retain(|c| c.secret != secret);
        true
    }

    /// A new sign-in: the session, and of the signed plan kept here only what is this account's.
    /// Another account's lease is dropped, never shown, nor sent to the sync relay, as this one's.
    fn sign_in(&mut self, session: Session, key: &[u8]) {
        // A deletion scheduled for another account is not this one's.
        if !self.same_account(&session.email) {
            self.delete_at = None;
        }
        // A repeat purchase is said before the sign-in it waits for («Payment received»), and by the
        // claim that signs in after this; any sign-in by code may be another account's, so it ends.
        self.paid_again = false;
        self.session = Some(session);
        let kept = self.lease.take();
        self.keep_lease(kept, key);
        if self.plan.is_none() {
            self.lease = None;
        }
        self.checked_at = None;
        self.awaiting_sign_in = false;
    }

    /// The server no longer takes the refresh token of the session here: it ends. Only that session,
    /// `refresh_token`: Sign out or another sign-in meanwhile wins.
    fn session_ended(&mut self, refresh_token: &str) {
        if self.session.as_ref().is_some_and(|now| now.refresh_token == refresh_token) {
            self.session = None;
            // As Sign out: a repeat said for that session is not the next one's.
            self.paid_again = false;
        }
    }

    /// Paid with the email of an account that existed before: done here, sign in by code. Only
    /// while the purchase is still here, as `signed_in_by`.
    /// `again`: the one-time purchase bought again (the usual way a repeat is paid), refunded.
    fn paid_for_existing_account(&mut self, secret: &str, again: bool) {
        if self.checkouts.iter().any(|c| c.secret == secret) {
            self.checkouts.retain(|c| c.secret != secret);
            self.awaiting_sign_in = true;
            self.paid_again = again;
        }
    }

    /// What the payment step shows when no purchase here is paid now.
    fn settled(&self) -> CheckoutState {
        if self.awaiting_sign_in && self.session.is_none() {
            CheckoutState::SignIn
        } else if self.checkouts.is_empty() {
            CheckoutState::None
        } else {
            CheckoutState::Waiting
        }
    }

    /// The account a request was made for is still the one here: an answer that comes after Sign
    /// out, or after another account signed in, changes nothing.
    fn same_account(&self, email: &str) -> bool {
        self.session.as_ref().is_some_and(|s| s.email == email)
    }

    /// When the background asks next: about the purchases waiting here, else the hourly tick.
    fn next_wake(&self, now: DateTime<Utc>) -> Duration {
        let Some(newest) = self.checkouts.iter().map(|c| c.started).max() else {
            return TICK;
        };
        CLAIM_EVERY.iter().find(|(age, _)| now - newest < *age).map_or(TICK, |(_, every)| *every)
    }
}

/// What the sidebar, the dialog and Settings → Plan show.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct SupporterStatus {
    /// This build sells Supporter.
    pub available: bool,
    /// Test payments: the dialog says so.
    pub sandbox: bool,
    pub email: Option<String>,
    pub plan: Option<Plan>,
    /// The server could not be asked when it matters: the paid period is over, or the plan stops
    /// offline within a week (`offline_until`).
    pub check_failed: bool,
    /// Signed in, no plan here, and the last question about it failed: not «no plan», only not
    /// known yet. The sign-in dialog says so and offers to try again.
    pub plan_unknown: bool,
    /// A payment went through with the email of an existing account: the purchase dialog opens on
    /// «Payment received» and its sign-in by code.
    pub awaiting_sign_in: bool,
    /// A purchase through Google Play here (NP-154): one waiting for its email, its code or a slow
    /// payment, else how the last one in this run finished. Only the Play build has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub play: Option<play::PlayProgress>,
    /// The account is deleted on this date unless kept (billing/deletion.rs).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub delete_at: Option<DateTime<Utc>>,
    /// The email of the account here (or just signed out) whose deletion was sent and not answered:
    /// the deletion dialog opens on «We couldn't confirm the deletion».
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub deletion_pending: Option<String>,
    /// The last payment seen here was the one-time purchase bought again: it is refunded.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub paid_again: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Price {
    pub price_id: String,
    /// Formatted by Paddle in the person's currency, tax included: «€20.00».
    pub total: String,
    pub currency: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SupporterPrices {
    pub month: Price,
    pub year: Price,
    /// Supporter's one-time purchase, paid once; None while the server does not sell it.
    #[serde(default)]
    pub lifetime: Option<Price>,
}

/// What `poll_checkout` found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CheckoutState {
    /// Not paid yet: the dialog keeps waiting.
    Waiting,
    /// Paid: the app is signed in and has the plan.
    Paid,
    /// Paid with the email of an account that existed before: the plan is there, signing in
    /// takes the code from the email.
    SignIn,
    /// No purchase is waiting here.
    None,
}

/// The plan the app shows: the signed one, until its `offline_until` — 30 days from the server's
/// last answer, never past the period and its week of grace. Each answer moves it on.
fn effective(stored: &Stored, now: DateTime<Utc>) -> Option<Plan> {
    stored.plan.clone().filter(|plan| now < plan.offline_until)
}

/// This computer has Supporter now, as the app shows it: what the paid features check.
pub fn has_plan(app: &AppHandle) -> bool {
    service().is_some() && app.try_state::<Billing>().is_some_and(|billing| effective(&billing.get(), Utc::now()).is_some())
}

/// For a signed-in account: one check a week (a plan bought on another computer shows too), one a
/// day in the last days of the period, and within the hour after a check that failed. Never
/// checked: now. A check stamped in the future (the clock was ahead) counts as old.
fn due(stored: &Stored, now: DateTime<Utc>) -> bool {
    if stored.session.is_none() {
        return false;
    }
    let ending = stored.plan.as_ref().and_then(|plan| plan.valid_until).is_some_and(|until| now >= until - RENEWAL_WINDOW);
    let every = if stored.check_failed {
        CHECK_AGAIN
    } else if ending {
        CHECK_EVERY
    } else {
        CHECK_WEEKLY
    };
    stored.checked_at.is_none_or(|at| at > now || now - at >= every)
}

/// A check that may use the answer already here instead of asking: an automatic one an answer
/// seconds old, and any one the answer of a check that ran while it waited for its turn (a manual
/// one only if that answer came, so «Try again» after a failure still asks). `waited_from` is the
/// stamp seen before waiting. An answer to a question asked before `portal_at` never counts: what
/// was changed in the portal since is not in it.
fn answered(stored: &Stored, waited_from: Option<DateTime<Utc>>, now: DateTime<Utc>, automatic: bool, portal_at: Option<DateTime<Utc>>) -> bool {
    let Some(at) = stored.checked_at.filter(|at| *at <= now && portal_at.is_none_or(|portal| *at >= portal)) else {
        return false;
    };
    let meanwhile = waited_from != Some(at);
    // A failure seconds old is not an answer: the dialog opening right after it asks again.
    (automatic && (meanwhile || (now - at < FRESH && !stored.check_failed))) || (meanwhile && !stored.check_failed)
}

fn status(stored: &Stored, now: DateTime<Utc>) -> SupporterStatus {
    let service = service();
    let plan = effective(stored, now);
    SupporterStatus {
        available: service.is_some(),
        sandbox: service.is_some_and(|s| s.sandbox),
        email: stored.session.as_ref().map(|s| s.email.clone()),
        // Said once it matters: the period is over, or the plan stops offline within a week.
        check_failed: stored.check_failed && plan.as_ref().is_some_and(|p| p.valid_until.is_some_and(|until| now >= until) || p.offline_until - now <= WARN_OFFLINE),
        plan,
        plan_unknown: stored.session.is_some() && stored.plan.is_none() && stored.check_failed,
        awaiting_sign_in: stored.awaiting_sign_in && stored.session.is_none(),
        play: stored.play_progress(),
        delete_at: stored.delete_at.filter(|_| stored.session.is_some()),
        deletion_pending: deletion::pending(stored, now),
        paid_again: stored.paid_again.then_some(true),
    }
}

/// A random secret for one purchase: 64 hex characters, 244 random bits.
fn new_secret() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

pub struct Billing {
    path: PathBuf,
    stored: Mutex<Stored>,
    /// Wakes the background when a purchase starts, so it asks about it after the dialog closes.
    wake: tokio::sync::Notify,
    /// One `claim` at a time, network included, for the dialog, the background and Sign out: two
    /// asks at once would let a «taken» answer drop the purchase whose «paid» is still on its way.
    claiming: tokio::sync::Mutex<()>,
    /// One plan check at a time (the background, the dialog, «Try again»): a late failure must not
    /// overwrite a newer answer.
    checking: tokio::sync::Mutex<()>,
    /// One token refresh at a time: two with the same refresh token would race for the session.
    refreshing: tokio::sync::Mutex<()>,
    /// When «Manage» last opened the portal: the check after it asks the server again.
    portal_at: Mutex<Option<DateTime<Utc>>>,
    /// One Play purchase step at a time, Play's sheet included (NP-154): the check on the way back
    /// to the screen waits for the purchase that put Play's sheet over the app.
    playing: tokio::sync::Mutex<()>,
}

impl Billing {
    fn load(path: PathBuf) -> Self {
        let mut stored: Stored = crate::secrets::read(&path)
            .ok()
            .flatten()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        stored.migrate();
        // An account of the other environment is not this build's.
        if service().is_some_and(|s| s.sandbox != stored.sandbox) {
            stored = Stored { sandbox: service().is_some_and(|s| s.sandbox), ..Stored::default() };
        }
        // The plan only as the server signed it: a plan written in the file by hand, or kept by
        // the builds before 0.10, counts for nothing until the server answers.
        let lease = stored.lease.take();
        stored.keep_lease(lease, &plan_key());
        if stored.unsigned_plan.take().is_some() && stored.lease.is_none() {
            stored.checked_at = None;
        }
        Billing {
            path,
            stored: Mutex::new(stored),
            wake: tokio::sync::Notify::new(),
            claiming: tokio::sync::Mutex::new(()),
            checking: tokio::sync::Mutex::new(()),
            refreshing: tokio::sync::Mutex::new(()),
            portal_at: Mutex::new(None),
            playing: tokio::sync::Mutex::new(()),
        }
    }

    fn get(&self) -> Stored {
        self.stored.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// Changes the stored state, writes the file and tells the interface. The lock is held until
    /// the file is written: two updates at once (a background check and Sign out) are written in
    /// the order they changed the state, and never share the temporary file. A write that fails
    /// leaves the state in memory as it was.
    fn update(&self, app: &AppHandle, change: impl FnOnce(&mut Stored)) -> Result<SupporterStatus, CommandError> {
        let status = status(&self.apply(change)?, Utc::now());
        let _ = app.emit(EVENT, status.clone());
        Ok(status)
    }

    fn apply(&self, change: impl FnOnce(&mut Stored)) -> Result<Stored, CommandError> {
        let mut stored = self.stored.lock().map_err(CommandError::internal)?;
        let mut next = stored.clone();
        change(&mut next);
        self.write(&next)?;
        *stored = next;
        Ok(stored.clone())
    }

    fn write(&self, stored: &Stored) -> Result<(), CommandError> {
        let text = serde_json::to_string_pretty(stored).map_err(CommandError::internal)?;
        // Through the secrets' store (NP-153): a file renamed into place on a computer, so a crash
        // mid-write never leaves half an account; the Keychain on an iPhone.
        crate::secrets::write(&self.path, &text).map_err(CommandError::internal)
    }
}

/// Called in `setup`: loads the account and asks the server only when a check is due or a
/// purchase is waiting. A purchase is followed here whether its dialog is open or not, and a
/// failed request is simply asked again at the next wake.
pub fn start(app: &AppHandle) {
    let path = app.state::<std::sync::Arc<crate::library_state::Library>>().paths.folder().join(FILE);
    app.manage(Billing::load(path));
    if service().is_none() {
        return;
    }
    // Purchases through Google Play, on start and each time the app comes back (NP-154).
    #[cfg(play)]
    play::watch(app);
    let app = app.clone();
    let mut foreground = crate::lifecycle::foreground(&app);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(15)).await;
        let billing = app.state::<Billing>();
        loop {
            // Not behind a phone's screen (NP-151): the check waits for the app to come back.
            foreground.wait().await;
            if !billing.get().checkouts.is_empty() {
                let _ = claim(&app).await;
            }
            if due(&billing.get(), Utc::now()) {
                let _ = check(&app, false).await;
            }
            let wait = billing.get().next_wake(Utc::now());
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = billing.wake.notified() => {}
            }
        }
    });
}

// ── Network ──────────────────────────────────────────────────────────────────

fn need_service() -> Result<Service, CommandError> {
    service().ok_or_else(|| CommandError::new(ErrorCode::InvalidRequest, "This build does not sell Supporter"))
}

pub(crate) fn client(app: &AppHandle) -> Result<reqwest::Client, CommandError> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        // Built with reqwest's `gzip` for feeds (NP-128); this request stays as it was.
        .gzip(false)
        .user_agent(format!("KoonaPin/{}", app.package_info().version))
        .build()
        .map_err(CommandError::internal)
}

pub(crate) fn offline(error: reqwest::Error) -> CommandError {
    let detail = if error.is_connect() { ErrorDetail::NoConnection } else { ErrorDetail::ServiceFailed };
    CommandError::detailed(ErrorCode::Network, detail, error.without_url().to_string())
}

fn refused(what: &str, status: reqwest::StatusCode) -> CommandError {
    CommandError::detailed(ErrorCode::Network, ErrorDetail::ServiceFailed, format!("{what} answered {status}"))
}

/// A refresh refused because the refresh token no longer works (signed out elsewhere, revoked):
/// the session ends here. A rate limit (429) or a timeout (408) is not that, nor is a server error.
fn ends_session(status: reqwest::StatusCode) -> bool {
    status.is_client_error() && status != reqwest::StatusCode::TOO_MANY_REQUESTS && status != reqwest::StatusCode::REQUEST_TIMEOUT
}

/// A code check Supabase refused: too many attempts (429) is said as such, not as a wrong code,
/// or the person keeps retyping a good one; any other 4xx is the code.
fn verify_refused(status: reqwest::StatusCode) -> Option<CommandError> {
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        Some(CommandError::detailed(ErrorCode::Network, ErrorDetail::TooManyMessages, "Too many codes tried"))
    } else if status.is_client_error() {
        Some(CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::WrongCode, "The code did not work"))
    } else {
        None
    }
}

/// One action of the Edge Function `billing`; a server error is a failure.
async fn call(app: &AppHandle, body: Value, token: Option<&str>) -> Result<(reqwest::StatusCode, Value), CommandError> {
    let (status, value) = call_raw(app, body, token, None).await?;
    if status.is_server_error() {
        return Err(refused("billing", status));
    }
    Ok((status, value))
}

/// The action's answer whatever its status: a deletion's 502 says what failed ([`deletion`]).
/// `timeout` replaces the client's 15 seconds for an action that takes longer (deleting now).
async fn call_raw(app: &AppHandle, body: Value, token: Option<&str>, timeout: Option<Duration>) -> Result<(reqwest::StatusCode, Value), CommandError> {
    let service = need_service()?;
    let mut request = client(app)?.post(format!("{}/functions/v1/billing", service.url)).json(&body);
    if let Some(timeout) = timeout {
        request = request.timeout(timeout);
    }
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.map_err(offline)?;
    let status = response.status();
    let value = response.json::<Value>().await.unwrap_or(Value::Null);
    Ok((status, value))
}

/// Supabase Auth with the publishable key.
async fn auth(app: &AppHandle, path: &str, body: Value) -> Result<(reqwest::StatusCode, Value), CommandError> {
    let service = need_service()?;
    let response = client(app)?
        .post(format!("{}/auth/v1/{path}", service.url))
        .header("apikey", service.key)
        .json(&body)
        .send()
        .await
        .map_err(offline)?;
    let status = response.status();
    Ok((status, response.json::<Value>().await.unwrap_or(Value::Null)))
}

fn session_of(value: &Value) -> Option<Session> {
    let expires_at = value["expires_at"].as_i64().or_else(|| Some(Utc::now().timestamp() + value["expires_in"].as_i64()?))?;
    Some(Session {
        access_token: value["access_token"].as_str()?.to_string(),
        refresh_token: value["refresh_token"].as_str()?.to_string(),
        expires_at,
        email: value["email"].as_str().or_else(|| value["user"]["email"].as_str())?.to_string(),
    })
}

/// A fresh access token, refreshed when it has less than a minute left; None when the
/// account was signed out elsewhere (the refresh token no longer works).
async fn access_token(app: &AppHandle) -> Result<Option<String>, CommandError> {
    fresh_token(app, false).await
}

/// `force`: refreshed whatever its time left, for a token a server refused (the sync relay's 4001).
async fn fresh_token(app: &AppHandle, force: bool) -> Result<Option<String>, CommandError> {
    let billing = app.state::<Billing>();
    // The session is read under the lock: a refresh that just finished is used, not repeated.
    let _one = billing.refreshing.lock().await;
    let Some(session) = billing.get().session else {
        return Ok(None);
    };
    if !force && session.expires_at - 60 > Utc::now().timestamp() {
        return Ok(Some(session.access_token));
    }
    let (status, value) = auth(app, "token?grant_type=refresh_token", json!({ "refresh_token": session.refresh_token })).await?;
    // Only the session this refresh was for: Sign out or another sign-in meanwhile wins.
    let same = |s: &Stored| s.session.as_ref().is_some_and(|now| now.refresh_token == session.refresh_token);
    if !ends_session(status) && !status.is_success() {
        // Too many requests, a timeout, the server down: the session is still good, ask later.
        return Err(refused("auth refresh", status));
    }
    if ends_session(status) {
        billing.update(app, |s| s.session_ended(&session.refresh_token))?;
        return Ok(None);
    }
    let fresh = session_of(&value).ok_or_else(|| refused("auth refresh", status))?;
    let token = fresh.access_token.clone();
    let mut kept = false;
    billing.update(app, |s| {
        if same(s) {
            s.session = Some(fresh);
            kept = true;
        }
    })?;
    Ok(kept.then_some(token))
}

/// What the sync relay checks before it lets a device in (NP-059, commercial/sync): a fresh
/// access token and base64 of the signed lease as stored. `refresh` after the relay refused the
/// token. None when signed out or without a lease; an error when the token could not be refreshed
/// now (offline, the account service away), which is not being signed out.
pub(crate) async fn sync_credentials(app: &AppHandle, refresh: bool) -> Result<Option<(String, String)>, CommandError> {
    use base64::Engine;
    let Some(token) = fresh_token(app, refresh).await? else {
        return Ok(None);
    };
    let Some(lease) = app.state::<Billing>().get().lease else {
        return Ok(None);
    };
    let json = serde_json::to_string(&lease).map_err(CommandError::internal)?;
    Ok(Some((token, base64::engine::general_purpose::STANDARD.encode(json))))
}

/// Asks for the plan of the signed-in account; marks the check failed when the server is away.
/// The answer counts only for the account it was asked for: after Sign out it changes nothing.
async fn check(app: &AppHandle, automatic: bool) -> Result<SupporterStatus, CommandError> {
    let billing = app.state::<Billing>();
    let waited_from = billing.get().checked_at;
    let _one = billing.checking.lock().await;
    let stored = billing.get();
    let Some(email) = stored.session.as_ref().map(|s| s.email.clone()) else {
        return Ok(status(&stored, Utc::now()));
    };
    // The dialog asks each time it opens or comes back into focus, and «Try again» may wait for a
    // check already on its way: the answer here is then enough.
    let portal_at = billing.portal_at.lock().ok().and_then(|at| *at);
    if answered(&stored, waited_from, Utc::now(), automatic, portal_at) {
        return Ok(status(&stored, Utc::now()));
    }
    // Stamped with when it was asked, not answered: an answer that set off before the portal
    // opened is older than it, however late it comes.
    let asked_at = Utc::now();
    let result = async {
        let Some(token) = access_token(app).await? else {
            return Ok(None);
        };
        let (status, value) = call(app, json!({ "action": "plan" }), Some(&token)).await?;
        // Any refusal — 401 for a token the gateway does not take, too many requests, a gateway's
        // 4xx — says nothing about the plan: a failed check, asked again, never «no plan». A session
        // that really ended shows in the refresh of its token (`access_token`, `ends_session`).
        if !status.is_success() {
            return Err(refused("billing plan", status));
        }
        Ok::<_, CommandError>(Some(value))
    }
    .await;
    match result {
        // A body that is not the function's answer is a failed check, as when offline: the plan
        // here stays until its own `offline_until` and is asked about again within the hour.
        Ok(Some(value)) => {
            let answer = Answer::of(&value);
            billing.update(app, |s| {
                if s.same_account(&email) {
                    s.take_answer(answer, &plan_key(), asked_at);
                }
            })
        }
        // Signed out elsewhere (the refresh token no longer works): the plan stays until its period
        // ends, as when offline.
        Ok(None) => billing.update(app, |s| {
            if s.same_account(&email) || s.session.is_none() {
                s.checked_at = Some(asked_at);
            }
        }),
        Err(error) => {
            billing.update(app, |s| {
                if s.same_account(&email) {
                    s.checked_at = Some(asked_at);
                    s.check_failed = true;
                }
            })?;
            Err(error)
        }
    }
}

/// Asks about every purchase started here and trades the first one seen paid for a session.
async fn claim(app: &AppHandle) -> Result<CheckoutState, CommandError> {
    let billing = app.state::<Billing>();
    let _one_at_a_time = billing.claiming.lock().await;
    let now = Utc::now();
    if billing.get().checkouts.iter().any(|c| now - c.started > CLAIM_LIFETIME) {
        billing.update(app, |s| s.forget_old(now))?;
    }
    let checkouts = billing.get().checkouts;
    if checkouts.is_empty() {
        return Ok(billing.get().settled());
    }
    // Every answer is applied under the lock and only to a purchase still here: Sign out, or the
    // dialog and the background asking at once, never let a late answer undo what came after.
    let mut finished: Vec<String> = Vec::new();
    let mut for_existing: Vec<(String, bool)> = Vec::new();
    let mut answered = false;
    let mut failure = None;
    for checkout in &checkouts {
        let (status, value) = match call(app, json!({ "action": "claim", "claim": checkout.secret }), None).await {
            Ok(answer) => answer,
            Err(error) => {
                failure.get_or_insert(error);
                continue;
            }
        };
        answered = true;
        if status.as_u16() == 404 || value["status"] == "taken" {
            finished.push(checkout.secret.clone());
        } else if value["status"] == "sign_in" {
            for_existing.push((checkout.secret.clone(), value["again"] == true));
        } else if value["status"] == "paid" {
            let session = session_of(&value["session"]).ok_or_else(|| refused("billing claim", status))?;
            // Signed in either way; a plan the reply does not give is not known yet, not «none».
            let answer = Answer::of(&value);
            // The one-time purchase bought again (koona-services `boughtAgain`): refunded by the server.
            let again = value["again"] == true;
            let mut signed_in = false;
            billing.update(app, |s| {
                signed_in = s.signed_in_by(&checkout.secret, session, answer, &plan_key(), Utc::now());
                if signed_in {
                    s.paid_again = again;
                }
                s.checkouts.retain(|c| !finished.contains(&c.secret));
            })?;
            if signed_in {
                return Ok(CheckoutState::Paid);
            }
        }
    }
    if !finished.is_empty() || !for_existing.is_empty() {
        billing.update(app, |s| {
            for (secret, again) in &for_existing {
                s.paid_for_existing_account(secret, *again);
            }
            s.checkouts.retain(|c| !finished.contains(&c.secret));
        })?;
    }
    match failure {
        Some(error) if !answered => Err(error),
        _ => Ok(billing.get().settled()),
    }
}

fn open(app: &AppHandle, url: &str) -> Result<(), CommandError> {
    let parsed = url::Url::parse(url).map_err(CommandError::internal)?;
    let local = parsed.host_str().is_some_and(|h| h == "localhost" || h == "127.0.0.1");
    if parsed.scheme() != "https" && !(local && service().is_some_and(|s| s.sandbox)) {
        return Err(CommandError::internal("The service gave a link that is not https"));
    }
    app.opener().open_url(parsed.as_str(), None::<&str>).map_err(CommandError::internal)
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// The plan as kept: no request.
#[tauri::command]
pub fn get_supporter_status(billing: State<'_, Billing>) -> SupporterStatus {
    status(&billing.get(), Utc::now())
}

/// The two prices in the person's currency, for the dialog.
#[tauri::command]
pub async fn get_supporter_prices(app: AppHandle) -> Result<SupporterPrices, CommandError> {
    let (status, value) = call(&app, json!({ "action": "prices" }), None).await?;
    if !status.is_success() {
        return Err(refused("billing prices", status));
    }
    serde_json::from_value(value["prices"].clone()).map_err(CommandError::internal)
}

/// «Continue»: a Paddle transaction for this copy of the app, opened in the browser; its address,
/// for «Open the page again». A purchase of the same plan still waiting is opened again instead
/// of a second one; one of the other plan stays and is still asked about.
#[tauri::command]
pub async fn start_checkout(app: AppHandle, interval: PlanInterval) -> Result<String, CommandError> {
    let billing = app.state::<Billing>();
    if let Some(url) = billing.get().waiting(interval, Utc::now()).and_then(|c| c.url.clone()) {
        // A purchase going on, as a new one: a repeat said before is not this one's.
        billing.update(&app, |s| s.paid_again = false)?;
        open(&app, &url)?;
        return Ok(url);
    }
    let secret = new_secret();
    let token = access_token(&app).await.unwrap_or(None);
    let name = match interval {
        PlanInterval::Month => "month",
        PlanInterval::Year => "year",
        PlanInterval::Lifetime => "lifetime",
    };
    let (status, value) = call(&app, json!({ "action": "checkout", "interval": name, "claim": secret }), token.as_deref()).await?;
    if status.as_u16() == 409 && value["error"] == "already_supporter" {
        return Err(CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::AlreadySupporter, "The account already has the one-time purchase"));
    }
    let url = value["url"].as_str().filter(|_| status.is_success()).ok_or_else(|| refused("billing checkout", status))?.to_string();
    let checkout = Checkout { secret, started: Utc::now(), interval: Some(interval), url: Some(url.clone()) };
    billing.update(&app, |s| s.add_checkout(checkout))?;
    billing.wake.notify_one();
    open(&app, &url)?;
    Ok(url)
}

/// «Open the page again»: the same payment, not a new one.
#[tauri::command]
pub fn open_checkout(app: AppHandle, url: String) -> Result<(), CommandError> {
    open(&app, &url)
}

/// Asked every few seconds while the dialog waits for the payment, and never otherwise.
#[tauri::command]
pub async fn poll_checkout(app: AppHandle) -> Result<CheckoutState, CommandError> {
    claim(&app).await
}

/// «Try again» asks now; `automatic` — the Supporter dialog opening or coming back into focus —
/// asks unless the plan was checked moments ago.
#[tauri::command]
pub async fn refresh_supporter(app: AppHandle, automatic: Option<bool>) -> Result<SupporterStatus, CommandError> {
    check(&app, automatic.unwrap_or(false)).await
}

/// «Manage ↗»: Paddle's customer portal in the browser.
#[tauri::command]
pub async fn open_supporter_portal(app: AppHandle) -> Result<(), CommandError> {
    if let Ok(mut at) = app.state::<Billing>().portal_at.lock() {
        *at = Some(Utc::now());
    }
    let token = access_token(&app).await?.ok_or_else(|| CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::SignedOut, "Not signed in"))?;
    let (status, value) = call(&app, json!({ "action": "portal" }), Some(&token)).await?;
    let url = value["url"].as_str().filter(|_| status.is_success()).ok_or_else(|| refused("billing portal", status))?.to_string();
    open(&app, &url)
}

/// «Send code»: Supabase emails a code to an existing Supporter; nobody new signs up here.
#[tauri::command]
pub async fn send_sign_in_code(app: AppHandle, email: String) -> Result<(), CommandError> {
    let email = email.trim().to_string();
    if !crate::feedback::email_shape(&email) {
        return Err(CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::InvalidEmail, "The email address does not look right"));
    }
    email_code(&app, &email).await
}

/// The email of the account signed in here.
pub(crate) fn signed_in_email(app: &AppHandle) -> Option<String> {
    app.state::<Billing>().get().session.map(|s| s.email)
}

fn signed_out() -> CommandError {
    CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::SignedOut, "Not signed in")
}

/// Sync's «Start over» (commercial/sync, `PROTOCOL.md` 2.6): a code to the email of the account
/// signed in here, which is returned.
pub(crate) async fn send_code_to_signed_in(app: &AppHandle) -> Result<String, CommandError> {
    let email = signed_in_email(app).ok_or_else(signed_out)?;
    email_code(app, &email).await?;
    Ok(email)
}

/// Then the code signs this account in afresh, kept as `verify_sign_in_code` keeps a sign-in;
/// returns the new access token, which proves to the relay a sign-in by email code just now.
pub(crate) async fn sign_in_again(app: &AppHandle, code: &str) -> Result<String, CommandError> {
    let email = signed_in_email(app).ok_or_else(signed_out)?;
    let session = verified_session(app, &email, code).await?;
    let token = session.access_token.clone();
    app.state::<Billing>().update(app, |s| keep_session(s, session))?;
    Ok(token)
}

async fn email_code(app: &AppHandle, email: &str) -> Result<(), CommandError> {
    let (status, value) = auth(app, "otp", json!({ "email": email, "create_user": false })).await?;
    if status.is_success() {
        return Ok(());
    }
    let code = value["error_code"].as_str().or_else(|| value["code"].as_str()).unwrap_or_default();
    Err(match (status.as_u16(), code) {
        (_, "otp_disabled" | "signup_disabled" | "user_not_found") | (422, _) => {
            CommandError::detailed(ErrorCode::NotFound, ErrorDetail::NotSupporter, "No Supporter has this email")
        }
        (429, _) | (_, "over_email_send_rate_limit") => {
            CommandError::detailed(ErrorCode::Network, ErrorDetail::TooManyMessages, "Too many codes asked for")
        }
        _ => refused("auth otp", status),
    })
}

/// Supabase `verify` of a code from the email: the digits typed, whatever else came with them.
fn verify_body(email: &str, code: &str) -> Value {
    let code: String = code.chars().filter(char::is_ascii_digit).collect();
    json!({ "type": "email", "email": email.trim(), "token": code })
}

async fn verified_session(app: &AppHandle, email: &str, code: &str) -> Result<Session, CommandError> {
    let (status, value) = auth(app, "verify", verify_body(email, code)).await?;
    if let Some(error) = verify_refused(status) {
        return Err(error);
    }
    session_of(&value).ok_or_else(|| refused("auth verify", status))
}

/// A new sign-in in `account.json`.
fn keep_session(s: &mut Stored, session: Session) {
    s.sign_in(session, &plan_key());
}

/// The app store review's account: a code Supabase refused as wrong or expired is asked about
/// once more at the server, which knows a single reviewer's email and its reusable code. Too many
/// tries, no connection or the service down are not a wrong code and are said as they are.
fn asks_review(error: &CommandError) -> bool {
    error.detail == Some(ErrorDetail::WrongCode)
}

/// The server's `review_sign_in` answer: a session and its plan on a match (200, `paid`); None
/// for its 404 and anything else, and the wrong code stays the answer.
fn review_answer(status: reqwest::StatusCode, value: &Value) -> Option<(Session, Answer)> {
    if !status.is_success() || value["status"] != "paid" {
        return None;
    }
    Some((session_of(&value["session"])?, Answer::of(value)))
}

/// Asks `review_sign_in` with the email and the digits typed; None on no match or any failure.
async fn review_session(app: &AppHandle, email: &str, code: &str) -> Option<(Session, Answer)> {
    let digits: String = code.chars().filter(char::is_ascii_digit).collect();
    let (status, value) = call(app, json!({ "action": "review_sign_in", "email": email.trim(), "code": digits }), None).await.ok()?;
    review_answer(status, &value)
}

/// «Sign in»: the code from the email becomes a session and the plan.
#[tauri::command]
pub async fn verify_sign_in_code(app: AppHandle, email: String, code: String) -> Result<SupporterStatus, CommandError> {
    let (session, answer) = match verified_session(&app, &email, &code).await {
        Ok(session) => (session, None),
        Err(error) if asks_review(&error) => match review_session(&app, &email, &code).await {
            Some((session, answer)) => (session, Some(answer)),
            None => return Err(error),
        },
        Err(error) => return Err(error),
    };
    let billing = app.state::<Billing>();
    let reviewed = answer.is_some();
    billing.update(&app, |s| {
        keep_session(s, session);
        // As a paid claim: the plan in the same answer, taken as a plan check's.
        if let Some(answer) = answer {
            s.take_answer(answer, &plan_key(), Utc::now());
        }
    })?;
    // A Play purchase waiting for this sign-in is bound to the account now (NP-154); one that fails
    // here is asked about again when the app comes back to the screen.
    play::verify_waiting(&app).await;
    // The review's answer carried its plan just now: asking again would only repeat it.
    if reviewed {
        return Ok(self::status(&billing.get(), Utc::now()));
    }
    // Signed in whatever the plan check says: when it fails, the status says the plan is not known
    // yet (`plan_unknown`) and the background asks again within the hour.
    match check(&app, false).await {
        Ok(shown) => Ok(shown),
        Err(_) => Ok(self::status(&billing.get(), Utc::now())),
    }
}

/// «Sign out»: the account and the plan leave this computer; the subscription goes on.
#[tauri::command]
pub async fn sign_out_supporter(app: AppHandle) -> Result<SupporterStatus, CommandError> {
    let billing = app.state::<Billing>();
    if let Some(session) = billing.get().session {
        // Best effort: this computer's refresh token stops working on the server too. Only this
        // one: Supabase's default scope, global, would sign out the person's other computers.
        if let Ok(service) = need_service() {
            if let Ok(client) = client(&app) {
                let _ = client
                    .post(format!("{}/auth/v1/logout?scope=local", service.url))
                    .header("apikey", service.key)
                    .bearer_auth(session.access_token)
                    .send()
                    .await;
            }
        }
    }
    // After a claim already asking: what it signs in is signed out here, and one starting later
    // finds no purchase.
    let _one_at_a_time = billing.claiming.lock().await;
    // Play purchases not bound yet stay: their secrets are their only claim (NP-154).
    billing.update(&app, Stored::signed_out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> DateTime<Utc> {
        text.parse().unwrap()
    }

    fn supporter(until: &str) -> Stored {
        Stored {
            session: Some(Session { access_token: "a".into(), refresh_token: "r".into(), expires_at: 0, email: "anna@example.com".into() }),
            // As the server signs it in the last days of the period: kept a week past its end.
            plan: Some(Plan {
                status: PlanStatus::Active,
                interval: Some(PlanInterval::Year),
                valid_until: Some(at(until)),
                renews_at: Some(at(until)),
                offline_until: at(until) + TimeDelta::days(7),
                also_renews: false,
                store: None,
            }),
            ..Stored::default()
        }
    }

    #[test]
    fn the_plan_is_checked_once_a_week_and_daily_in_the_last_days_of_the_period() {
        let stored = Stored { checked_at: Some(at("2026-10-12T00:00:00Z")), ..supporter("2027-10-11T12:00:00Z") };
        assert!(!due(&stored, at("2026-10-12T12:00:00Z")), "a fresh plan is not checked");
        assert!(!due(&stored, at("2026-10-18T23:00:00Z")), "nor within a week");
        assert!(due(&stored, at("2026-10-19T00:00:00Z")), "a week later: a cancellation or a refund shows");
        let weekly = Stored { checked_at: Some(at("2027-10-05T13:00:00Z")), ..stored.clone() };
        assert!(!due(&weekly, at("2027-10-08T11:00:00Z")), "more than three days before its end: weekly still");
        assert!(due(&weekly, at("2027-10-08T13:00:00Z")), "three days before: daily");
        let checked = Stored { checked_at: Some(at("2027-10-08T13:00:00Z")), ..stored.clone() };
        assert!(!due(&checked, at("2027-10-09T12:00:00Z")), "not twice a day");
        assert!(due(&checked, at("2027-10-09T13:00:00Z")), "the next day again");
        assert!(!due(&Stored { session: None, ..stored.clone() }, at("2027-10-10T00:00:00Z")), "signed out: nothing to ask");
        assert!(!due(&Stored::default(), at("2027-10-10T00:00:00Z")), "signed out: never");
        let free = Stored { plan: None, ..stored.clone() };
        assert!(!due(&free, at("2026-10-18T23:00:00Z")), "signed in without a plan: weekly too");
        assert!(due(&free, at("2026-10-19T00:00:00Z")), "a plan bought on another computer shows");
        let failed = Stored { check_failed: true, ..stored.clone() };
        assert!(!due(&failed, at("2026-10-12T00:59:00Z")), "a failed check is not asked again at once");
        assert!(due(&failed, at("2026-10-12T01:00:00Z")), "but within the hour, not in a week");
        let ahead = Stored { checked_at: Some(at("2026-10-20T00:00:00Z")), ..stored.clone() };
        assert!(due(&ahead, at("2026-10-12T12:00:00Z")), "a check stamped in the future counts as old");
    }

    #[test]
    fn a_check_uses_an_answer_already_here_only_when_it_may() {
        let now = at("2026-10-12T12:00:00Z");
        let checked = |when: &str, failed: bool| Stored { checked_at: Some(at(when)), check_failed: failed, ..supporter("2027-10-11T12:00:00Z") };
        let seconds_ago = checked("2026-10-12T11:59:55Z", false);
        let before = seconds_ago.checked_at;
        assert!(answered(&seconds_ago, before, now, true, None), "the dialog skips an answer seconds old");
        assert!(!answered(&seconds_ago, before, now, false, None), "«Try again» asks anyway");
        assert!(!answered(&checked("2026-10-12T11:59:00Z", false), Some(at("2026-10-12T11:59:00Z")), now, true, None), "a minute old: asked again");
        // A check ran while this one waited for its turn.
        let meanwhile = checked("2026-10-12T11:59:58Z", false);
        assert!(answered(&meanwhile, Some(at("2026-10-05T00:00:00Z")), now, false, None), "«Try again» takes the answer that just came");
        let failed_meanwhile = checked("2026-10-12T11:59:58Z", true);
        assert!(!answered(&failed_meanwhile, Some(at("2026-10-05T00:00:00Z")), now, false, None), "but asks itself after a failure");
        assert!(answered(&failed_meanwhile, Some(at("2026-10-05T00:00:00Z")), now, true, None), "the dialog does not repeat it");
        let failed_seconds_ago = checked("2026-10-12T11:59:55Z", true);
        assert!(!answered(&failed_seconds_ago, failed_seconds_ago.checked_at, now, true, None), "a failure seconds old is asked again");
        assert!(!answered(&checked("2026-10-13T00:00:00Z", false), None, now, true, None), "a stamp in the future is not fresh");
        assert!(!answered(&Stored { checked_at: None, ..seconds_ago.clone() }, None, now, true, None), "never checked: ask");
        // Back from «Manage»: an answer asked before the portal opened, seconds old or one that came
        // while this check waited, says nothing about what was changed there.
        let portal = Some(at("2026-10-12T11:59:57Z"));
        assert!(!answered(&seconds_ago, before, now, true, portal), "seconds old but asked before the portal: asked again");
        assert!(!answered(&checked("2026-10-12T11:59:56Z", false), Some(at("2026-10-05T00:00:00Z")), now, true, portal), "nor one that came meanwhile");
        assert!(answered(&meanwhile, Some(at("2026-10-05T00:00:00Z")), now, true, portal), "one asked after the portal counts");
    }

    #[test]
    fn a_plan_lasts_a_week_past_its_period_when_the_server_is_away() {
        let stored = Stored { check_failed: true, ..supporter("2027-10-11T12:00:00Z") };
        assert!(effective(&stored, at("2027-10-11T11:00:00Z")).is_some());
        assert!(effective(&stored, at("2027-10-17T12:00:00Z")).is_some(), "six days of grace");
        assert!(effective(&stored, at("2027-10-18T12:00:01Z")).is_none(), "then Free");
        assert!(!status(&stored, at("2027-10-10T00:00:00Z")).check_failed, "the period is still paid");
        assert!(status(&stored, at("2027-10-12T00:00:00Z")).check_failed);
    }

    #[test]
    fn a_plan_is_kept_30_days_without_the_server_and_says_so_a_week_before() {
        // Signed on 12 October for a yearly plan: offline until 11 November, not until 2027.
        let mut stored = Stored { check_failed: true, ..supporter("2027-10-11T12:00:00Z") };
        stored.plan.as_mut().unwrap().offline_until = at("2026-11-11T12:00:00Z");
        assert!(effective(&stored, at("2026-11-11T11:00:00Z")).is_some());
        assert!(effective(&stored, at("2026-11-11T12:00:01Z")).is_none(), "then Free until the server answers");
        assert!(!status(&stored, at("2026-11-03T12:00:00Z")).check_failed, "eight days left: nothing to say yet");
        assert!(status(&stored, at("2026-11-05T12:00:00Z")).check_failed, "a week left: the dialog says it could not check");
        assert!(!status(&Stored { check_failed: false, ..stored.clone() }, at("2026-11-05T12:00:00Z")).check_failed, "only after a failed check");
    }

    /// A lease as koona-services signs it (`_shared/lease.ts`), with a test key.
    fn lease(payload: &str, seed: u8) -> (Lease, Vec<u8>) {
        use base64::Engine;
        use ring::signature::KeyPair;
        let pair = ring::signature::Ed25519KeyPair::from_seed_unchecked(&[seed; 32]).unwrap();
        let signature = base64::engine::general_purpose::STANDARD.encode(pair.sign(payload.as_bytes()).as_ref());
        (Lease { payload: payload.into(), signature }, pair.public_key().as_ref().to_vec())
    }

    const PAYLOAD: &str = r#"{"v":1,"email":"anna@example.com","plan":{"plan":"supporter","status":"canceling","interval":"month","valid_until":"2026-11-12T03:02:36.583Z","renews_at":null},"issued_at":"2026-10-12T12:00:00.000Z","offline_until":"2026-11-11T12:00:00.000Z"}"#;

    #[test]
    fn only_a_plan_the_server_signed_counts() {
        let (signed, key) = lease(PAYLOAD, 7);
        // The same text signed by WebCrypto with the same key, as the Edge Function signs: the
        // two agree, so what Deno signs, ring verifies.
        assert_eq!(signed.signature, "RscxwFxtATNYHH+JE2o7kf9QWeyHQe01oU0jnoAkNXni9ypnlWfHp5nDrTumbEAs+4fwFeKVdkr+NZBNQHL3CA==");
        assert_eq!(
            plan_of(&signed, "Anna@Example.com", &key),
            Some(Plan {
                status: PlanStatus::Canceling,
                interval: Some(PlanInterval::Month),
                valid_until: Some(at("2026-11-12T03:02:36.583Z")),
                renews_at: None,
                offline_until: at("2026-11-11T12:00:00Z"),
                also_renews: false,
                store: None,
            })
        );
        let edited = Lease { payload: PAYLOAD.replace("2026-11-11", "2099-11-11"), ..signed.clone() };
        assert_eq!(plan_of(&edited, "anna@example.com", &key), None, "an edited date does not verify");
        assert_eq!(plan_of(&signed, "bob@example.com", &key), None, "another account's lease is not this one's");
        assert_eq!(plan_of(&signed, "anna@example.com", &lease(PAYLOAD, 8).1), None, "another key");
        assert_eq!(plan_of(&Lease { signature: "not base64!".into(), ..signed.clone() }, "anna@example.com", &key), None);
        let (future, future_key) = lease(&PAYLOAD.replace(r#""v":1"#, r#""v":2"#), 7);
        assert_eq!(plan_of(&future, "anna@example.com", &future_key), None, "a version it does not know");
        assert!(!plan_key().is_empty() && plan_key().len() == 32, "the server's public key is built in");
    }

    #[test]
    fn only_a_refresh_token_that_no_longer_works_ends_the_session() {
        use reqwest::StatusCode;
        assert!(ends_session(StatusCode::BAD_REQUEST), "revoked or already used");
        assert!(ends_session(StatusCode::UNAUTHORIZED));
        assert!(!ends_session(StatusCode::TOO_MANY_REQUESTS), "a rate limit is asked again later");
        assert!(!ends_session(StatusCode::REQUEST_TIMEOUT));
        assert!(!ends_session(StatusCode::BAD_GATEWAY), "the server down is not a sign out");
        assert!(!ends_session(StatusCode::OK));
    }

    #[test]
    fn a_rate_limited_code_is_not_called_wrong() {
        use reqwest::StatusCode;
        let detail = |status| verify_refused(status).map(|e| e.detail);
        assert_eq!(detail(StatusCode::TOO_MANY_REQUESTS), Some(Some(ErrorDetail::TooManyMessages)));
        assert_eq!(detail(StatusCode::FORBIDDEN), Some(Some(ErrorDetail::WrongCode)), "an expired or wrong code");
        assert!(verify_refused(StatusCode::OK).is_none());
    }

    #[test]
    fn only_a_wrong_code_is_asked_about_as_the_review_account() {
        use reqwest::StatusCode;
        let asks = |status| verify_refused(status).is_some_and(|e| asks_review(&e));
        assert!(asks(StatusCode::FORBIDDEN), "a wrong or expired code");
        assert!(asks(StatusCode::BAD_REQUEST));
        assert!(!asks(StatusCode::TOO_MANY_REQUESTS), "too many tries");
        assert!(!asks_review(&refused("auth verify", StatusCode::BAD_GATEWAY)), "the service down");
        assert!(!asks_review(&CommandError::detailed(ErrorCode::Network, ErrorDetail::NoConnection, "offline")));
    }

    #[test]
    fn the_review_account_signs_in_only_on_a_match() {
        use reqwest::StatusCode;
        let paid = json!({
            "status": "paid",
            "session": { "access_token": "a", "refresh_token": "r", "expires_at": 1_900_000_000, "email": "review@example.com" },
            "plan": { "status": "active" },
            "lease": { "payload": "{}", "signature": "c2ln" },
        });
        let (session, answer) = review_answer(StatusCode::OK, &paid).expect("a match signs in");
        assert_eq!(session.email, "review@example.com");
        assert!(answer.has_plan && answer.lease.is_some());
        assert!(review_answer(StatusCode::NOT_FOUND, &json!({ "error": "review" })).is_none(), "no match");
        assert!(review_answer(StatusCode::NOT_FOUND, &paid).is_none());
        assert!(review_answer(StatusCode::OK, &json!({ "status": "paid" })).is_none(), "no session");
        assert!(review_answer(StatusCode::OK, &Value::Null).is_none());
    }

    #[test]
    fn a_plan_the_server_names_but_that_does_not_verify_is_never_no_plan() {
        let (signed, key) = lease(PAYLOAD, 7);
        let mut stored = Stored { session: supporter("2027-10-11T12:00:00Z").session, ..Stored::default() };
        stored.take_answer(Answer { has_plan: true, lease: Some(signed.clone()), delete_at: None }, &key, at("2026-10-12T12:00:00Z"));
        assert!(stored.plan.is_some() && !stored.check_failed);
        // The server names a plan, but the lease is missing or signed by another key: the plan here
        // stays and the check counts as failed.
        stored.take_answer(Answer { has_plan: true, lease: None, delete_at: None }, &key, at("2026-10-12T13:00:00Z"));
        assert!(stored.plan.is_some(), "kept");
        assert!(stored.check_failed);
        assert_eq!(stored.lease, Some(signed.clone()), "the lease that verified stays too");
        stored.take_answer(Answer { has_plan: true, lease: Some(signed.clone()), delete_at: None }, &lease(PAYLOAD, 8).1, at("2026-10-12T14:00:00Z"));
        assert!(stored.plan.is_some() && stored.check_failed);
        // The server says there is none: Free.
        stored.take_answer(Answer { has_plan: false, lease: None, delete_at: None }, &key, at("2026-10-12T15:00:00Z"));
        assert!(stored.plan.is_none() && !stored.check_failed);
        assert!(!status(&stored, at("2026-10-12T15:00:00Z")).plan_unknown, "no plan, known");
        // Signed in with nothing known yet: not «no plan».
        stored.take_answer(Answer { has_plan: true, lease: None, delete_at: None }, &key, at("2026-10-12T16:00:00Z"));
        assert!(status(&stored, at("2026-10-12T16:00:00Z")).plan_unknown);
    }

    /// A 200 whose body is not the function's answer (not JSON, a proxy's page, no `lease`) says
    /// nothing about the plan: the lease stays, the check failed and is asked again within the hour.
    /// Only the function's own «none», `lease: null`, is Free.
    #[test]
    fn a_broken_answer_keeps_the_plan_and_asks_again_soon() {
        let (signed, key) = lease(PAYLOAD, 7);
        let asked = at("2026-10-12T12:00:00Z");
        let mut stored = Stored { session: supporter("2027-10-11T12:00:00Z").session, ..Stored::default() };
        stored.take_answer(Answer::of(&json!({ "email": "anna@example.com", "plan": {}, "lease": signed })), &key, asked);
        assert!(stored.plan.is_some() && !stored.check_failed);
        for broken in [Value::Null, json!("<html>"), json!([]), json!({}), json!({ "email": "anna@example.com" }), json!({ "lease": "x" })] {
            let mut after = stored.clone();
            after.take_answer(Answer::of(&broken), &key, asked);
            assert_eq!(after.lease, Some(signed.clone()), "{broken}: the lease stays");
            assert!(after.plan.is_some() && after.check_failed, "{broken}: kept, as when offline");
            assert!(due(&after, asked + CHECK_AGAIN), "{broken}: asked again within the hour, not in a week");
        }
        stored.take_answer(Answer::of(&json!({ "email": "anna@example.com", "plan": null, "lease": null })), &key, asked);
        assert!(stored.plan.is_none() && stored.lease.is_none() && !stored.check_failed, "the server says there is none");
    }

    #[test]
    fn a_plan_written_in_the_file_counts_for_nothing() {
        // The file of a build before 0.10, or one edited by hand: a plan, no lease.
        let file = json!({
            "session": { "access_token": "a", "refresh_token": "r", "expires_at": 0, "email": "anna@example.com" },
            "plan": { "status": "active", "interval": "year", "valid_until": "2099-01-01T00:00:00Z", "renews_at": null, "offline_until": "2099-01-01T00:00:00Z" },
            "checked_at": Utc::now(),
        });
        let path = std::env::temp_dir().join(format!("koonapin-account-{}.json", uuid::Uuid::new_v4().simple()));
        std::fs::write(&path, file.to_string()).unwrap();
        let mut stored = Billing::load(path.clone()).get();
        let _ = std::fs::remove_file(&path);
        assert_eq!(stored.plan, None);
        assert!(due(&stored, Utc::now()), "checked a moment ago, but the plan was unsigned: the server is asked at once");
        let rewritten: Value = serde_json::to_value(&stored).unwrap();
        assert!(rewritten.get("plan").is_none(), "and the unsigned plan is not written back");
        // A signed one is kept, and only for the account signed in.
        let (signed, key) = lease(PAYLOAD, 7);
        stored.keep_lease(Some(signed.clone()), &key);
        assert!(stored.plan.is_some());
        stored.session = None;
        stored.keep_lease(Some(signed), &key);
        assert_eq!(stored.plan, None, "signed out: no plan");
    }

    #[test]
    fn a_purchase_secret_is_random_hex() {
        let (a, b) = (new_secret(), new_secret());
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn a_session_is_read_from_auth_and_from_billing() {
        let auth = json!({ "access_token": "a", "refresh_token": "r", "expires_in": 3600, "user": { "email": "anna@example.com" } });
        let session = session_of(&auth).unwrap();
        assert_eq!(session.email, "anna@example.com");
        assert!(session.expires_at > Utc::now().timestamp());
        let billing = json!({ "access_token": "a", "refresh_token": "r", "expires_at": 1, "email": "b@example.com" });
        assert_eq!(session_of(&billing).unwrap().expires_at, 1);
        assert!(session_of(&json!({ "access_token": "a" })).is_none());
    }

    #[test]
    fn a_code_is_verified_by_its_digits_for_the_email_given() {
        assert_eq!(
            verify_body(" anna@example.com ", "123 45-6"),
            json!({ "type": "email", "email": "anna@example.com", "token": "123456" })
        );
    }

    #[test]
    fn a_new_sign_in_replaces_the_session_and_asks_for_the_plan_again() {
        let mut stored = supporter("2026-11-12T00:00:00Z");
        stored.checked_at = Some(at("2026-10-12T00:00:00Z"));
        stored.awaiting_sign_in = true;
        let fresh = Session { access_token: "new".into(), refresh_token: "r2".into(), expires_at: 9, email: "anna@example.com".into() };
        keep_session(&mut stored, fresh);
        assert_eq!(stored.session.as_ref().map(|s| s.access_token.as_str()), Some("new"));
        assert_eq!(stored.checked_at, None);
        assert!(!stored.awaiting_sign_in);
    }

    /// A purchase here signs in another account than the one with a plan, and its «paid» reply has
    /// no plan in it: nothing of the first account's plan is kept, shown or sent for the new one.
    #[test]
    fn a_purchase_signing_in_another_account_keeps_nothing_of_the_first_ones_plan() {
        let (signed, key) = lease(PAYLOAD, 7);
        let mut stored = Stored { session: supporter("2027-10-11T12:00:00Z").session, ..Stored::default() };
        stored.keep_lease(Some(signed.clone()), &key);
        assert!(stored.plan.is_some(), "anna has a plan");
        stored.add_checkout(checkout("year1", "2026-10-12T11:00:00Z", PlanInterval::Year));
        let bob = Session { access_token: "b".into(), refresh_token: "rb".into(), expires_at: 9, email: "bob@example.com".into() };
        let broken = Answer::of(&json!({ "status": "paid", "session": {} }));
        assert!(stored.signed_in_by("year1", bob, broken, &key, at("2026-10-12T11:10:00Z")));
        assert!(stored.same_account("bob@example.com"));
        assert_eq!(stored.plan, None, "anna's plan is not bob's");
        assert_eq!(stored.lease, None, "nor is her lease, which sync would send");
        assert!(stored.check_failed && status(&stored, at("2026-10-12T11:10:00Z")).plan_unknown, "bob's plan is not known yet");
        // The same account signing in again keeps its own lease until the server answers.
        let mut again = Stored { session: supporter("2027-10-11T12:00:00Z").session, ..Stored::default() };
        again.keep_lease(Some(signed.clone()), &key);
        again.sign_in(supporter("2027-10-11T12:00:00Z").session.unwrap(), &key);
        assert_eq!(again.lease, Some(signed));
        assert!(again.plan.is_some());
    }

    #[test]
    fn the_plan_reads_what_the_server_signs() {
        let plan: SignedPlan = serde_json::from_value(json!({
            "plan": "supporter", "status": "canceling", "interval": "year",
            "valid_until": "2027-10-11T12:00:00Z", "renews_at": null
        }))
        .unwrap();
        assert_eq!(plan.status, PlanStatus::Canceling);
        assert_eq!(plan.renews_at, None);
        assert!(!plan.also_renews);
    }

    #[test]
    fn lifetime_paid_once_comes_signed_without_an_end() {
        // As koona-services signs Supporter's one-time purchase: no end, no renewal.
        let payload = r#"{"v":1,"email":"anna@example.com","plan":{"plan":"supporter","status":"active","interval":"lifetime","valid_until":null,"renews_at":null,"also_renews":true},"issued_at":"2026-10-12T12:00:00.000Z","offline_until":"2026-11-11T12:00:00.000Z"}"#;
        let (signed, key) = lease(payload, 7);
        let plan = plan_of(&signed, "anna@example.com", &key).unwrap();
        assert_eq!((plan.interval, plan.renews_at, plan.also_renews), (Some(PlanInterval::Lifetime), None, true));
        assert_eq!(plan.valid_until, None);
        // Checked weekly like any plan: a refund shows within a week; never the daily checks of an ending period.
        let stored = Stored { plan: Some(plan), checked_at: Some(at("2026-10-12T12:00:00Z")), ..supporter("2031-10-12T10:00:00Z") };
        assert!(!due(&stored, at("2026-10-18T12:00:00Z")));
        assert!(due(&stored, at("2026-10-19T12:00:00Z")));
        // A failed check says so only once the lease nears its end: there is no period to be over.
        let failed = Stored { check_failed: true, ..stored.clone() };
        assert!(!status(&failed, at("2026-10-20T12:00:00Z")).check_failed);
        assert!(status(&failed, at("2026-11-05T12:00:00Z")).check_failed);
        // The prices of a server that does not sell them yet still read.
        let prices: SupporterPrices = serde_json::from_value(json!({
            "month": { "price_id": "m", "total": "$2.00", "currency": "USD" },
            "year": { "price_id": "y", "total": "$20.00", "currency": "USD" },
        }))
        .unwrap();
        assert!(prices.lifetime.is_none());
    }

    fn checkout(secret: &str, started: &str, interval: PlanInterval) -> Checkout {
        Checkout { secret: secret.into(), started: at(started), interval: Some(interval), url: Some(format!("https://koona.app/pin/checkout/?_ptxn={secret}")) }
    }

    #[test]
    fn a_one_time_purchase_bought_again_is_said_until_the_next_purchase_or_sign_in() {
        let now = at("2026-10-12T12:00:00Z");
        let mut stored = Stored { paid_again: true, ..supporter("2027-10-12T12:00:00Z") };
        assert_eq!(status(&stored, now).paid_again, Some(true));
        // Kept in account.json: the dialog says so whoever saw the payment first.
        let kept: Stored = serde_json::from_value(serde_json::to_value(&stored).unwrap()).unwrap();
        assert!(kept.paid_again);
        stored.add_checkout(checkout("year1", "2026-10-12T11:00:00Z", PlanInterval::Year));
        assert_eq!(status(&stored, now).paid_again, None);
        // Another sign-in, or signing out, says nothing of it either.
        let mut other = Stored { paid_again: true, ..supporter("2027-10-12T12:00:00Z") };
        other.sign_in(Session { access_token: "b".into(), refresh_token: "r2".into(), expires_at: 0, email: "ben@example.com".into() }, &[]);
        assert!(!other.paid_again);
        let mut out = Stored { paid_again: true, ..supporter("2027-10-12T12:00:00Z") };
        out.signed_out();
        assert!(!out.paid_again);
    }

    #[test]
    fn a_session_the_server_ended_ends_its_repeat_too_but_not_another_sessions() {
        let mut stored = Stored { paid_again: true, ..supporter("2027-10-12T12:00:00Z") };
        // A refresh for a session replaced meanwhile changes nothing.
        stored.session_ended("old");
        assert!(stored.session.is_some() && stored.paid_again);
        stored.session_ended("r");
        assert!(stored.session.is_none() && !stored.paid_again);
    }

    #[test]
    fn a_repeat_paid_with_an_existing_accounts_email_is_said_until_the_code_signs_in() {
        let now = at("2026-10-12T12:00:00Z");
        let mut stored = Stored::default();
        stored.add_checkout(checkout("once1", "2026-10-12T11:00:00Z", PlanInterval::Lifetime));
        stored.paid_for_existing_account("once1", true);
        assert_eq!((stored.settled(), status(&stored, now).paid_again), (CheckoutState::SignIn, Some(true)));
        // The code signs in, whichever account: it is said no more (the open dialog keeps what it showed).
        stored.sign_in(Session { access_token: "b".into(), refresh_token: "r2".into(), expires_at: 0, email: "ben@example.com".into() }, &[]);
        assert!(!stored.paid_again && !stored.awaiting_sign_in);
        assert_eq!(status(&stored, now).paid_again, None);
        // Not a repeat: nothing said.
        let mut plain = Stored::default();
        plain.add_checkout(checkout("year1", "2026-10-12T11:00:00Z", PlanInterval::Year));
        plain.paid_for_existing_account("year1", false);
        assert_eq!(status(&plain, now).paid_again, None);
    }

    #[test]
    fn a_new_purchase_keeps_the_ones_still_waiting() {
        let now = at("2026-10-12T12:00:00Z");
        let mut stored = Stored::default();
        stored.add_checkout(checkout("year1", "2026-10-12T11:00:00Z", PlanInterval::Year));
        // The same plan again opens the same payment, not a second one.
        assert_eq!(stored.waiting(PlanInterval::Year, now).map(|c| c.secret.as_str()), Some("year1"));
        // Another plan is a new purchase; the first stays, so a payment in its tab is still seen.
        assert!(stored.waiting(PlanInterval::Month, now).is_none());
        stored.add_checkout(checkout("month1", "2026-10-12T11:30:00Z", PlanInterval::Month));
        assert_eq!(stored.checkouts.iter().map(|c| c.secret.as_str()).collect::<Vec<_>>(), ["year1", "month1"]);
        // Too old to be paid now: forgotten.
        stored.forget_old(at("2026-10-14T11:15:00Z"));
        assert_eq!(stored.checkouts.iter().map(|c| c.secret.as_str()).collect::<Vec<_>>(), ["month1"]);
        assert!(stored.waiting(PlanInterval::Month, at("2026-10-15T00:00:00Z")).is_none());
        for i in 0..6 {
            stored.add_checkout(checkout(&format!("extra{i}"), "2026-10-14T12:00:00Z", PlanInterval::Year));
        }
        assert_eq!(stored.checkouts.len(), MAX_CHECKOUTS);
        assert_eq!(stored.checkouts.last().unwrap().secret, "extra5");
    }

    #[test]
    fn a_paid_purchase_signs_in_and_leaves_the_others_waiting() {
        let mut stored = Stored::default();
        stored.add_checkout(checkout("year1", "2026-10-12T11:00:00Z", PlanInterval::Year));
        stored.add_checkout(checkout("month1", "2026-10-12T11:05:00Z", PlanInterval::Month));
        let session = supporter("2027-10-12T11:00:00Z").session.unwrap();
        assert!(stored.signed_in_by("year1", session.clone(), Answer { has_plan: false, lease: None, delete_at: None }, &plan_key(), at("2026-10-12T11:10:00Z")));
        assert!(stored.same_account("anna@example.com"));
        assert_eq!(stored.checkouts.iter().map(|c| c.secret.as_str()).collect::<Vec<_>>(), ["month1"]);
        assert_eq!(stored.settled(), CheckoutState::Waiting, "month1 is still followed");
        // Sign out forgets every purchase: a «paid» that arrives after it signs nobody in.
        let mut signed_out = Stored { sandbox: stored.sandbox, ..Stored::default() };
        assert!(!signed_out.signed_in_by("month1", session, Answer { has_plan: false, lease: None, delete_at: None }, &plan_key(), at("2026-10-12T11:20:00Z")));
        assert!(signed_out.session.is_none());
        assert_eq!(signed_out.settled(), CheckoutState::None);
    }

    #[test]
    fn a_payment_for_an_existing_account_waits_for_the_code_whoever_saw_it() {
        let mut stored = Stored::default();
        stored.add_checkout(checkout("year1", "2026-10-12T11:00:00Z", PlanInterval::Year));
        stored.paid_for_existing_account("year1", false);
        assert!(stored.checkouts.is_empty());
        // The background saw it: the dialog's next ask, and a dialog opened later, still say so.
        assert_eq!(stored.settled(), CheckoutState::SignIn);
        assert_eq!(stored.settled(), CheckoutState::SignIn);
        assert!(status(&stored, at("2026-10-12T11:10:00Z")).awaiting_sign_in);
        // A late answer for a purchase gone after Sign out sets nothing.
        let mut signed_out = Stored::default();
        signed_out.paid_for_existing_account("year1", false);
        assert_eq!(signed_out.settled(), CheckoutState::None);
        // Signed in by the code: done.
        stored.session = supporter("2027-10-12T11:00:00Z").session;
        assert_eq!(stored.settled(), CheckoutState::None);
        assert!(!status(&stored, at("2026-10-12T11:20:00Z")).awaiting_sign_in);
    }

    #[test]
    fn an_answer_for_an_account_that_left_changes_nothing() {
        let stored = supporter("2027-10-11T12:00:00Z");
        assert!(stored.same_account("anna@example.com"));
        assert!(!stored.same_account("bob@example.com"), "another account signed in meanwhile");
        assert!(!Stored::default().same_account("anna@example.com"), "signed out meanwhile");
    }

    #[test]
    fn a_waiting_purchase_is_followed_often_at_first_then_rarely_and_never_without_one() {
        let mut stored = Stored::default();
        assert_eq!(stored.next_wake(at("2026-10-12T12:00:00Z")), TICK);
        stored.add_checkout(checkout("year1", "2026-10-12T12:00:00Z", PlanInterval::Year));
        assert_eq!(stored.next_wake(at("2026-10-12T12:10:00Z")), Duration::from_secs(15));
        assert_eq!(stored.next_wake(at("2026-10-12T13:00:00Z")), Duration::from_secs(60));
        assert_eq!(stored.next_wake(at("2026-10-13T12:00:00Z")), Duration::from_secs(600));
        assert_eq!(stored.next_wake(at("2026-10-14T13:00:00Z")), TICK, "past its lifetime");
    }

    #[test]
    fn the_purchase_kept_by_0_8_0_is_still_asked_about() {
        let file = json!({ "sandbox": true, "claim": "old", "claim_started": "2026-10-11T12:00:00Z" });
        let mut stored: Stored = serde_json::from_value(file).unwrap();
        stored.migrate();
        assert_eq!(stored.checkouts, [Checkout { secret: "old".into(), started: at("2026-10-11T12:00:00Z"), interval: None, url: None }]);
        // Its plan is unknown: Continue makes a new purchase rather than guess.
        assert!(stored.waiting(PlanInterval::Year, at("2026-10-11T13:00:00Z")).is_none());
        let written = serde_json::to_value(&stored).unwrap();
        assert!(written.get("claim").is_none() && written.get("claim_started").is_none());
    }

    #[test]
    fn updates_are_written_one_at_a_time_and_a_failed_write_changes_nothing() {
        let folder = std::env::temp_dir().join(format!("koonapin-billing-{}", new_secret()));
        let billing = std::sync::Arc::new(Billing::load(folder.join(FILE)));
        let threads: Vec<_> = (0..8)
            .map(|i| {
                let billing = billing.clone();
                std::thread::spawn(move || {
                    for j in 0..20 {
                        billing.apply(|s| s.add_checkout(checkout(&format!("{i}-{j}"), "2026-10-12T12:00:00Z", PlanInterval::Year))).unwrap();
                    }
                })
            })
            .collect();
        threads.into_iter().for_each(|t| t.join().unwrap());
        // The file holds exactly the state in memory: the last update wins on disk as in memory.
        let on_disk: Stored = serde_json::from_str(&std::fs::read_to_string(folder.join(FILE)).unwrap()).unwrap();
        assert_eq!(on_disk.checkouts, billing.get().checkouts);
        assert!(!folder.join("account.json.tmp").exists());
        // A write that cannot happen leaves the state as it was.
        std::fs::remove_file(folder.join(FILE)).unwrap();
        std::fs::create_dir(folder.join(FILE)).unwrap();
        let before = billing.get().checkouts;
        assert!(billing.apply(|s| s.checkouts.clear()).is_err());
        assert_eq!(billing.get().checkouts, before);
        let _ = std::fs::remove_dir_all(&folder);
    }
}
