//! Supporter through Google Play Billing (NP-154), in the Play build only: the app's feature
//! `store-play` brings this crate in, so the site's APK carries no billing library and no
//! `com.android.vending.BILLING` permission.
//!
//! The Kotlin side (`app.koona.pin.play`, Play Billing Library 9.1.0) answers the app's Rust side
//! (billing.rs), never the page: the prices ([`KoonaPlay::products`]), a purchase
//! ([`KoonaPlay::buy`]), what the Google account owns ([`KoonaPlay::purchases`]), and the
//! `purchases` event ([`KoonaPlay::on_purchases`]) when Play reports a purchase outside a `buy`. It
//! never acknowledges or consumes: the server does, after it has verified the purchase.
//!
//! The types are on every platform, so the app's code that reads them is checked on a desktop too;
//! only the plugin itself is Android's.

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// A price the sheet shows: a base plan of a subscription, or a one-time product.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    pub product: String,
    #[serde(default)]
    pub base_plan: Option<String>,
    /// Formatted by Play in the person's currency: «€2.00».
    pub price: String,
    pub currency: String,
    pub micros: i64,
    /// ISO 8601 (`P1M`, `P1Y`); none for a one-time product.
    #[serde(default)]
    pub period: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PurchaseState {
    Purchased,
    Pending,
    #[serde(other)]
    Unspecified,
}

/// A purchase as Play reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Purchase {
    pub token: String,
    pub products: Vec<String>,
    pub state: PurchaseState,
    pub acknowledged: bool,
    /// On hold or paused: no access, the person fixes the payment in Google Play.
    #[serde(default)]
    pub suspended: bool,
    /// The `obfuscatedAccountId` the purchase was made with: SHA-256 hex of the app's secret.
    #[serde(default)]
    pub account_id: Option<String>,
}

/// What a purchase came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Purchased,
    Pending,
    Canceled,
    /// This Google account owns it already; `purchases` holds what it owns.
    AlreadyOwned,
    /// No Play Store, a blocked one, or the product is not on sale here.
    Unavailable,
    #[serde(other)]
    Error,
}

/// The answer of [`KoonaPlay::buy`], and of the `purchases` event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bought {
    pub outcome: Outcome,
    #[serde(default)]
    pub purchases: Vec<Purchase>,
}

/// A question to Play that failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Billing cannot run here: no Play Store, a blocked one, an old one.
    Unavailable(String),
    /// Play or the plugin failed otherwise.
    Failed(String),
    /// No answer in time (set by the caller's time limit): what Play did meanwhile is not known.
    NoAnswer,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Unavailable(message) => write!(f, "Google Play Billing is unavailable: {message}"),
            Error::Failed(message) => write!(f, "Google Play Billing failed: {message}"),
            Error::NoAnswer => write!(f, "Google Play did not answer in time"),
        }
    }
}

impl std::error::Error for Error {}

#[cfg(target_os = "android")]
mod android {
    use super::{Bought, Error, Product, Purchase};
    use serde::{Deserialize, Serialize};
    use tauri::ipc::{Channel, InvokeResponseBody};
    use tauri::plugin::{mobile::PluginInvokeError, PluginHandle};
    use tauri::Runtime;

    /// The plugin, managed by the app once registered: `app.state::<KoonaPlay<R>>()`.
    pub struct KoonaPlay<R: Runtime>(pub(crate) PluginHandle<R>);

    /// A handle a call can carry past its caller (the app's time limits run calls on their own task).
    impl<R: Runtime> Clone for KoonaPlay<R> {
        fn clone(&self) -> Self {
            KoonaPlay(self.0.clone())
        }
    }

    fn error(error: PluginInvokeError) -> Error {
        match error {
            PluginInvokeError::InvokeRejected(rejected) => {
                let message = rejected.message.unwrap_or_default();
                if rejected.code.as_deref() == Some("unavailable") {
                    Error::Unavailable(message)
                } else {
                    Error::Failed(message)
                }
            }
            other => Error::Failed(other.to_string()),
        }
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ProductsArgs<'a> {
        subscriptions: &'a [&'a str],
        one_time: &'a [&'a str],
    }

    #[derive(Deserialize)]
    struct Products {
        products: Vec<Product>,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct BuyArgs<'a> {
        product: &'a str,
        base_plan: Option<&'a str>,
        account_id: &'a str,
    }

    #[derive(Deserialize)]
    struct Purchases {
        purchases: Vec<Purchase>,
    }

    #[derive(Serialize)]
    struct Listener {
        event: &'static str,
        handler: Channel<serde_json::Value>,
    }

    impl<R: Runtime> KoonaPlay<R> {
        /// The prices of these products, by Play's ids: one per base plan of each subscription,
        /// one per one-time product. A product Play does not know is left out.
        pub async fn products(&self, subscriptions: &[&str], one_time: &[&str]) -> Result<Vec<Product>, Error> {
            let args = ProductsArgs { subscriptions, one_time };
            let answer: Products = self.0.run_mobile_plugin_async("products", args).await.map_err(error)?;
            Ok(answer.products)
        }

        /// Play's purchase sheet; answers when the person has finished with it. A subscription is
        /// bought through `base_plan`'s own offer; `account_id` goes to Play as the purchase's
        /// `obfuscatedAccountId`.
        pub async fn buy(&self, product: &str, base_plan: Option<&str>, account_id: &str) -> Result<Bought, Error> {
            let args = BuyArgs { product, base_plan, account_id };
            self.0.run_mobile_plugin_async("buy", args).await.map_err(error)
        }

        /// What this Google account owns now: subscriptions (suspended ones too) and one-time
        /// products, acknowledged or not.
        pub async fn purchases(&self) -> Result<Vec<Purchase>, Error> {
            let answer: Purchases = self.0.run_mobile_plugin_async("purchases", ()).await.map_err(error)?;
            Ok(answer.purchases)
        }

        /// Calls `handler` with each purchase Play reports outside a `buy`: a slow payment that
        /// completed, a purchase made while no sheet waited.
        pub fn on_purchases(&self, handler: impl Fn(Bought) + Send + Sync + 'static) -> Result<(), Error> {
            let channel = Channel::new(move |body: InvokeResponseBody| {
                match body.deserialize::<Bought>() {
                    Ok(bought) => handler(bought),
                    Err(error) => eprintln!("Koona Pin: a purchases event that does not read: {error}"),
                }
                Ok(())
            });
            self.0.run_mobile_plugin::<()>("registerListener", Listener { event: "purchases", handler: channel }).map_err(error)
        }
    }
}

#[cfg(target_os = "android")]
pub use android::KoonaPlay;

/// Registered by the app on Android in the Play build; nothing elsewhere.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("koona-play")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = _api.register_android_plugin("app.koona.pin.play", "KoonaPlayPlugin")?;
                _app.manage(KoonaPlay(handle));
            }
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_answers_of_the_kotlin_side_read() {
        // As Jackson writes the Kotlin data classes (Catalog.kt).
        let bought: Bought = serde_json::from_value(json!({
            "outcome": "already_owned",
            "purchases": [{
                "token": "t", "products": ["supporter"], "state": "purchased",
                "acknowledged": false, "suspended": true, "accountId": null
            }]
        }))
        .unwrap();
        assert_eq!(bought.outcome, Outcome::AlreadyOwned);
        assert_eq!(
            bought.purchases,
            [Purchase {
                token: "t".into(),
                products: vec!["supporter".into()],
                state: PurchaseState::Purchased,
                acknowledged: false,
                suspended: true,
                account_id: None,
            }]
        );
        let product: Product = serde_json::from_value(json!({
            "product": "supporter_5_years", "basePlan": null, "price": "€29.99",
            "currency": "EUR", "micros": 29_990_000i64, "period": null
        }))
        .unwrap();
        assert_eq!((product.base_plan, product.micros, product.period), (None, 29_990_000, None));
    }

    #[test]
    fn an_answer_it_does_not_know_is_not_a_purchase() {
        let bought: Bought = serde_json::from_value(json!({ "outcome": "something_new", "purchases": [] })).unwrap();
        assert_eq!(bought.outcome, Outcome::Error);
        let purchase: Purchase = serde_json::from_value(json!({
            "token": "t", "products": [], "state": "new_state", "acknowledged": true
        }))
        .unwrap();
        assert_eq!(purchase.state, PurchaseState::Unspecified);
    }
}
