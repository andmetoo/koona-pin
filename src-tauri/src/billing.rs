//! Supporter (NP-066, Р-64, sheet 45): the plan the app keeps, buying it in the browser and
//! signing in on another computer. The plan is kept with the end of its paid period and shown
//! until then without asking anyone; the server is asked only while the purchase dialog waits
//! for a payment, when the person asks (Settings → Plan), and once a day in the last three days
//! of the period, with a week of grace when it cannot be reached. Free features never depend
//! on any of it, and sync checks the plan on its own server.
//!
//! Sales are closed until sync ships (Р-64): a build without the account service, or a sandbox
//! one that is not a development build, has no purchase at all.

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
const FILE: &str = "account.json";

/// The Supabase project of accounts and the environment of Paddle, from `.env` (build.rs).
const URL: Option<&str> = option_env!("KOONAPIN_ACCOUNT_URL");
const KEY: Option<&str> = option_env!("KOONAPIN_ACCOUNT_KEY");
const ENVIRONMENT: Option<&str> = option_env!("KOONAPIN_PADDLE_ENV");

/// The last days of a paid period, when the app asks once a day whether it renewed.
const RENEWAL_WINDOW: TimeDelta = TimeDelta::days(3);
const CHECK_EVERY: TimeDelta = TimeDelta::days(1);
/// Before them, once a week: a change of plan, a cancellation or a refund shows within a week
/// without asking more often (the Supporter dialog also asks when it opens).
const CHECK_WEEKLY: TimeDelta = TimeDelta::days(7);
/// An automatic check this soon after the last one is not asked again.
const FRESH: TimeDelta = TimeDelta::seconds(15);
/// How long a plan stays after its period when the server cannot be reached.
const GRACE: TimeDelta = TimeDelta::days(7);
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
    let (url, key) = (URL?, KEY?);
    let sandbox = match ENVIRONMENT? {
        "sandbox" => true,
        "production" => false,
        _ => return None,
    };
    // Test payments never reach a build people install.
    if sandbox && !cfg!(debug_assertions) {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum PlanInterval {
    Month,
    Year,
}

/// The plan as the server gives it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Plan {
    pub status: PlanStatus,
    pub interval: Option<PlanInterval>,
    #[ts(type = "string")]
    pub valid_until: DateTime<Utc>,
    #[ts(type = "string | null")]
    pub renews_at: Option<DateTime<Utc>>,
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
    plan: Option<Plan>,
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
    /// The first builds (0.8.0) kept a single purchase; read once and moved into `checkouts`.
    #[serde(default, skip_serializing)]
    claim: Option<String>,
    #[serde(default, skip_serializing)]
    claim_started: Option<DateTime<Utc>>,
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
        self.checkouts.push(checkout);
        let extra = self.checkouts.len().saturating_sub(MAX_CHECKOUTS);
        self.checkouts.drain(..extra);
    }

    /// Signed in by a paid purchase: that one is done; the others started here keep waiting, a
    /// payment in their tabs is still picked up. Only while the purchase is still here: an answer
    /// that arrives after Sign out (which forgets every purchase) changes nothing. False then.
    fn signed_in_by(&mut self, secret: &str, session: Session, plan: Option<Plan>, now: DateTime<Utc>) -> bool {
        if !self.checkouts.iter().any(|c| c.secret == secret) {
            return false;
        }
        self.session = Some(session);
        self.plan = plan;
        self.checked_at = Some(now);
        self.check_failed = false;
        self.awaiting_sign_in = false;
        self.checkouts.retain(|c| c.secret != secret);
        true
    }

    /// Paid with the email of an account that existed before: done here, sign in by code. Only
    /// while the purchase is still here, as `signed_in_by`.
    fn paid_for_existing_account(&mut self, secret: &str) {
        if self.checkouts.iter().any(|c| c.secret == secret) {
            self.checkouts.retain(|c| c.secret != secret);
            self.awaiting_sign_in = true;
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
    /// The paid period is over and the server could not say whether it renewed.
    pub check_failed: bool,
    /// A payment went through with the email of an existing account: the purchase dialog opens on
    /// «Payment received» and its sign-in by code.
    pub awaiting_sign_in: bool,
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

/// The plan the app shows: until the end of the period, and a week longer when the server
/// could not be asked. A successful check after the period either renewed it or removed it.
fn effective(stored: &Stored, now: DateTime<Utc>) -> Option<Plan> {
    stored.plan.clone().filter(|plan| now < plan.valid_until + GRACE)
}

/// This computer has Supporter now, as the app shows it: what the paid features check.
pub fn has_plan(app: &AppHandle) -> bool {
    service().is_some() && app.try_state::<Billing>().is_some_and(|billing| effective(&billing.get(), Utc::now()).is_some())
}

/// For a signed-in Supporter: one check a week, one a day in the last days of the period.
fn due(stored: &Stored, now: DateTime<Utc>) -> bool {
    let (Some(_), Some(plan)) = (&stored.session, &stored.plan) else {
        return false;
    };
    let every = if now >= plan.valid_until - RENEWAL_WINDOW { CHECK_EVERY } else { CHECK_WEEKLY };
    stored.checked_at.is_none_or(|at| now - at >= every)
}

fn status(stored: &Stored, now: DateTime<Utc>) -> SupporterStatus {
    let service = service();
    let plan = effective(stored, now);
    SupporterStatus {
        available: service.is_some(),
        sandbox: service.is_some_and(|s| s.sandbox),
        email: stored.session.as_ref().map(|s| s.email.clone()),
        check_failed: stored.check_failed && plan.as_ref().is_some_and(|p| now >= p.valid_until),
        plan,
        awaiting_sign_in: stored.awaiting_sign_in && stored.session.is_none(),
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
}

impl Billing {
    fn load(path: PathBuf) -> Self {
        let mut stored: Stored = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        stored.migrate();
        // An account of the other environment is not this build's.
        if service().is_some_and(|s| s.sandbox != stored.sandbox) {
            stored = Stored { sandbox: service().is_some_and(|s| s.sandbox), ..Stored::default() };
        }
        Billing {
            path,
            stored: Mutex::new(stored),
            wake: tokio::sync::Notify::new(),
            claiming: tokio::sync::Mutex::new(()),
            checking: tokio::sync::Mutex::new(()),
            refreshing: tokio::sync::Mutex::new(()),
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
        if let Some(folder) = self.path.parent() {
            std::fs::create_dir_all(folder).map_err(CommandError::internal)?;
        }
        let text = serde_json::to_string_pretty(stored).map_err(CommandError::internal)?;
        // Through a temporary file: a crash mid-write never leaves half an account.
        let temporary = self.path.with_extension("json.tmp");
        std::fs::write(&temporary, text).map_err(CommandError::internal)?;
        std::fs::rename(&temporary, &self.path).map_err(CommandError::internal)
    }
}

/// Called in `setup`: loads the account and asks the server only when a check is due or a
/// purchase is waiting. A purchase is followed here whether its dialog is open or not, and a
/// failed request is simply asked again at the next wake.
pub fn start(app: &AppHandle) {
    let path = crate::library::Paths::from_env().folder().join(FILE);
    app.manage(Billing::load(path));
    if service().is_none() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(15)).await;
        let billing = app.state::<Billing>();
        loop {
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

fn client(app: &AppHandle) -> Result<reqwest::Client, CommandError> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .user_agent(format!("KoonaPin/{}", app.package_info().version))
        .build()
        .map_err(CommandError::internal)
}

fn offline(error: reqwest::Error) -> CommandError {
    let detail = if error.is_connect() { ErrorDetail::NoConnection } else { ErrorDetail::ServiceFailed };
    CommandError::detailed(ErrorCode::Network, detail, error.without_url().to_string())
}

fn refused(what: &str, status: reqwest::StatusCode) -> CommandError {
    CommandError::detailed(ErrorCode::Network, ErrorDetail::ServiceFailed, format!("{what} answered {status}"))
}

/// One action of the Edge Function `billing`.
async fn call(app: &AppHandle, body: Value, token: Option<&str>) -> Result<(reqwest::StatusCode, Value), CommandError> {
    let service = need_service()?;
    let mut request = client(app)?.post(format!("{}/functions/v1/billing", service.url)).json(&body);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.map_err(offline)?;
    let status = response.status();
    let value = response.json::<Value>().await.unwrap_or(Value::Null);
    if status.is_server_error() {
        return Err(refused("billing", status));
    }
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
    let billing = app.state::<Billing>();
    // The session is read under the lock: a refresh that just finished is used, not repeated.
    let _one = billing.refreshing.lock().await;
    let Some(session) = billing.get().session else {
        return Ok(None);
    };
    if session.expires_at - 60 > Utc::now().timestamp() {
        return Ok(Some(session.access_token));
    }
    let (status, value) = auth(app, "token?grant_type=refresh_token", json!({ "refresh_token": session.refresh_token })).await?;
    // Only the session this refresh was for: Sign out or another sign-in meanwhile wins.
    let same = |s: &Stored| s.session.as_ref().is_some_and(|now| now.refresh_token == session.refresh_token);
    if status.is_client_error() {
        billing.update(app, |s| {
            if same(s) {
                s.session = None;
            }
        })?;
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

/// Asks for the plan of the signed-in account; marks the check failed when the server is away.
/// The answer counts only for the account it was asked for: after Sign out it changes nothing.
async fn check(app: &AppHandle, automatic: bool) -> Result<SupporterStatus, CommandError> {
    let billing = app.state::<Billing>();
    let _one = billing.checking.lock().await;
    let stored = billing.get();
    let Some(email) = stored.session.map(|s| s.email) else {
        return Ok(status(&billing.get(), Utc::now()));
    };
    // The dialog asks each time it opens or comes back into focus: an answer this fresh is enough.
    if automatic && stored.checked_at.is_some_and(|at| Utc::now() - at < FRESH) {
        return Ok(status(&billing.get(), Utc::now()));
    }
    let result = async {
        let Some(token) = access_token(app).await? else {
            return Ok(None);
        };
        let (status, value) = call(app, json!({ "action": "plan" }), Some(&token)).await?;
        Ok::<_, CommandError>(Some((status, value)))
    }
    .await;
    match result {
        Ok(Some((status, value))) if status.is_success() => {
            let plan = serde_json::from_value::<Option<Plan>>(value["plan"].clone()).unwrap_or(None);
            billing.update(app, |s| {
                if s.same_account(&email) {
                    s.plan = plan;
                    s.checked_at = Some(Utc::now());
                    s.check_failed = false;
                }
            })
        }
        // Signed out elsewhere: the plan stays until its period ends, as when offline.
        Ok(_) => billing.update(app, |s| {
            if s.same_account(&email) || s.session.is_none() {
                s.checked_at = Some(Utc::now());
            }
        }),
        Err(error) => {
            billing.update(app, |s| {
                if s.same_account(&email) {
                    s.checked_at = Some(Utc::now());
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
    let mut for_existing: Vec<String> = Vec::new();
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
            for_existing.push(checkout.secret.clone());
        } else if value["status"] == "paid" {
            let session = session_of(&value["session"]).ok_or_else(|| refused("billing claim", status))?;
            let plan = serde_json::from_value::<Option<Plan>>(value["plan"].clone()).unwrap_or(None);
            let mut signed_in = false;
            billing.update(app, |s| {
                signed_in = s.signed_in_by(&checkout.secret, session, plan, Utc::now());
                s.checkouts.retain(|c| !finished.contains(&c.secret));
            })?;
            if signed_in {
                return Ok(CheckoutState::Paid);
            }
        }
    }
    if !finished.is_empty() || !for_existing.is_empty() {
        billing.update(app, |s| {
            for secret in &for_existing {
                s.paid_for_existing_account(secret);
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
        open(&app, &url)?;
        return Ok(url);
    }
    let secret = new_secret();
    let token = access_token(&app).await.unwrap_or(None);
    let name = match interval {
        PlanInterval::Month => "month",
        PlanInterval::Year => "year",
    };
    let (status, value) = call(&app, json!({ "action": "checkout", "interval": name, "claim": secret }), token.as_deref()).await?;
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
    let (status, value) = auth(&app, "otp", json!({ "email": email, "create_user": false })).await?;
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

/// «Sign in»: the code from the email becomes a session and the plan.
#[tauri::command]
pub async fn verify_sign_in_code(app: AppHandle, email: String, code: String) -> Result<SupporterStatus, CommandError> {
    let code: String = code.chars().filter(char::is_ascii_digit).collect();
    let (status, value) = auth(&app, "verify", json!({ "type": "email", "email": email.trim(), "token": code })).await?;
    if status.is_client_error() {
        return Err(CommandError::detailed(ErrorCode::InvalidRequest, ErrorDetail::WrongCode, "The code did not work"));
    }
    let session = session_of(&value).ok_or_else(|| refused("auth verify", status))?;
    app.state::<Billing>().update(&app, |s| {
        s.session = Some(session);
        s.checked_at = None;
        s.awaiting_sign_in = false;
    })?;
    check(&app, false).await
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
    billing.update(&app, |s| *s = Stored { sandbox: s.sandbox, ..Stored::default() })
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
            plan: Some(Plan { status: PlanStatus::Active, interval: Some(PlanInterval::Year), valid_until: at(until), renews_at: Some(at(until)) }),
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
        assert!(!due(&Stored::default(), at("2027-10-10T00:00:00Z")), "Free: never");
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
    fn the_plan_reads_what_the_server_sends() {
        let plan: Plan = serde_json::from_value(json!({
            "plan": "supporter", "status": "canceling", "interval": "year",
            "valid_until": "2027-10-11T12:00:00Z", "renews_at": null
        }))
        .unwrap();
        assert_eq!(plan.status, PlanStatus::Canceling);
        assert_eq!(plan.renews_at, None);
    }

    fn checkout(secret: &str, started: &str, interval: PlanInterval) -> Checkout {
        Checkout { secret: secret.into(), started: at(started), interval: Some(interval), url: Some(format!("https://koona.app/pin/checkout/?_ptxn={secret}")) }
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
        assert!(stored.signed_in_by("year1", session.clone(), None, at("2026-10-12T11:10:00Z")));
        assert!(stored.same_account("anna@example.com"));
        assert_eq!(stored.checkouts.iter().map(|c| c.secret.as_str()).collect::<Vec<_>>(), ["month1"]);
        assert_eq!(stored.settled(), CheckoutState::Waiting, "month1 is still followed");
        // Sign out forgets every purchase: a «paid» that arrives after it signs nobody in.
        let mut signed_out = Stored { sandbox: stored.sandbox, ..Stored::default() };
        assert!(!signed_out.signed_in_by("month1", session, None, at("2026-10-12T11:20:00Z")));
        assert!(signed_out.session.is_none());
        assert_eq!(signed_out.settled(), CheckoutState::None);
    }

    #[test]
    fn a_payment_for_an_existing_account_waits_for_the_code_whoever_saw_it() {
        let mut stored = Stored::default();
        stored.add_checkout(checkout("year1", "2026-10-12T11:00:00Z", PlanInterval::Year));
        stored.paid_for_existing_account("year1");
        assert!(stored.checkouts.is_empty());
        // The background saw it: the dialog's next ask, and a dialog opened later, still say so.
        assert_eq!(stored.settled(), CheckoutState::SignIn);
        assert_eq!(stored.settled(), CheckoutState::SignIn);
        assert!(status(&stored, at("2026-10-12T11:10:00Z")).awaiting_sign_in);
        // A late answer for a purchase gone after Sign out sets nothing.
        let mut signed_out = Stored::default();
        signed_out.paid_for_existing_account("year1");
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
