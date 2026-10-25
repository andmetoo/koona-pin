//! Supporter through the App Store (StoreKit 2), in the App Store build only: the app's feature
//! `store-appstore` brings this crate in on iOS, so the Simulator's build without it has no
//! purchase at all.
//!
//! The Swift side (`ios/Sources/KoonaAppStorePlugin.swift`) answers the app's Rust side
//! (billing/appstore.rs), never the page: the prices ([`KoonaAppStore::products`]), a purchase
//! made with the purchase's `appAccountToken` ([`KoonaAppStore::buy`]), the transactions not
//! finished and what the Apple Account owns ([`KoonaAppStore::transactions`], after
//! `AppStore.sync()` for «Restore purchases»), [`KoonaAppStore::finish`] once the server has bound
//! a purchase, the system's subscriptions sheet ([`KoonaAppStore::manage`]) and the `transactions`
//! event ([`KoonaAppStore::on_transactions`]) for what `Transaction.updates` brings: a purchase
//! approved later (Ask to Buy), a renewal, a refund.
//!
//! The types are on every platform, so the app's code that reads them is checked on a desktop too;
//! only the plugin itself is iOS's.

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// A price the sheet shows: one product, in the person's currency.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    pub id: String,
    /// Formatted by StoreKit (`displayPrice`): «$1.49».
    pub price: String,
    pub currency: String,
    /// The price in millionths of `currency`.
    pub micros: i64,
    /// ISO 8601 (`P1M`, `P1Y`) for a subscription; none for the one-time purchase.
    #[serde(default)]
    pub period: Option<String>,
}

/// What `products` answers: the products StoreKit knows, and whether a subscription of this Apple
/// Account's in the group is in billing retry (no access: the payment is fixed in the App Store).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Products {
    pub products: Vec<Product>,
    #[serde(default)]
    pub suspended: bool,
}

/// A transaction as StoreKit reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transaction {
    pub id: String,
    pub original_id: String,
    pub product: String,
    /// `jwsRepresentation`: what the server verifies.
    pub jws: String,
    /// The purchase's `appAccountToken`, lower case; none for one bought without it.
    #[serde(default)]
    pub account_token: Option<String>,
    /// Refunded or revoked (`revocationDate`).
    #[serde(default)]
    pub revoked: bool,
    /// StoreKit verified its signature on the phone; the server verifies it anyway.
    #[serde(default)]
    pub verified: bool,
}

/// What a purchase came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Purchased,
    /// Waiting for approval (Ask to Buy) or for the bank: the transaction comes later through
    /// `Transaction.updates`.
    Pending,
    Canceled,
    /// Purchases are not allowed here (Screen Time), or the product is not on sale.
    Unavailable,
    #[serde(other)]
    Error,
}

/// The answer of [`KoonaAppStore::buy`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bought {
    pub outcome: Outcome,
    /// The purchase's transaction when `purchased`; it may be an earlier one (owned already).
    #[serde(default)]
    pub transaction: Option<Transaction>,
}

/// The answer of [`KoonaAppStore::transactions`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Transactions {
    /// `Transaction.unfinished`: not finished yet, the app's to finish.
    #[serde(default)]
    pub unfinished: Vec<Transaction>,
    /// `Transaction.currentEntitlements`: what the Apple Account owns now.
    #[serde(default)]
    pub entitlements: Vec<Transaction>,
}

/// A question to StoreKit that failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Nothing can be bought here: purchases not allowed, the product not on sale.
    Unavailable(String),
    /// StoreKit or the plugin failed otherwise (no network, the App Store out of reach).
    Failed(String),
    /// The person closed the Apple Account's sign-in of «Restore purchases».
    Canceled,
    /// No answer in time (set by the caller's time limit): what StoreKit did meanwhile is not known.
    NoAnswer,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Unavailable(message) => write!(f, "App Store purchases are unavailable: {message}"),
            Error::Failed(message) => write!(f, "StoreKit failed: {message}"),
            Error::Canceled => write!(f, "The Apple Account sign-in was cancelled"),
            Error::NoAnswer => write!(f, "The App Store did not answer in time"),
        }
    }
}

impl std::error::Error for Error {}

#[cfg(target_os = "ios")]
mod ios {
    use super::{Bought, Error, Products, Transaction, Transactions};
    use serde::Serialize;
    use tauri::ipc::{Channel, InvokeResponseBody};
    use tauri::plugin::{mobile::PluginInvokeError, PluginHandle};
    use tauri::Runtime;

    tauri::ios_plugin_binding!(init_plugin_koona_appstore);

    /// The plugin, managed by the app once registered: `app.state::<KoonaAppStore<R>>()`.
    pub struct KoonaAppStore<R: Runtime>(pub(crate) PluginHandle<R>);

    /// A handle a call can carry past its caller (the app's time limits run calls on their own task).
    impl<R: Runtime> Clone for KoonaAppStore<R> {
        fn clone(&self) -> Self {
            KoonaAppStore(self.0.clone())
        }
    }

    pub(crate) fn register<R: Runtime, C: serde::de::DeserializeOwned>(api: &tauri::plugin::PluginApi<R, C>) -> Result<PluginHandle<R>, PluginInvokeError> {
        api.register_ios_plugin(init_plugin_koona_appstore)
    }

    fn error(error: PluginInvokeError) -> Error {
        match error {
            PluginInvokeError::InvokeRejected(rejected) => {
                let message = rejected.message.unwrap_or_default();
                match rejected.code.as_deref() {
                    Some("unavailable") => Error::Unavailable(message),
                    Some("canceled") => Error::Canceled,
                    _ => Error::Failed(message),
                }
            }
            other => Error::Failed(other.to_string()),
        }
    }

    #[derive(Serialize)]
    struct ProductsArgs<'a> {
        ids: &'a [&'a str],
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct BuyArgs<'a> {
        product: &'a str,
        account_token: &'a str,
    }

    #[derive(Serialize)]
    struct TransactionsArgs {
        sync: bool,
    }

    #[derive(Serialize)]
    struct FinishArgs<'a> {
        ids: &'a [String],
    }

    #[derive(serde::Deserialize)]
    struct Reported {
        transactions: Vec<Transaction>,
    }

    #[derive(Serialize)]
    struct Listener {
        event: &'static str,
        handler: Channel<serde_json::Value>,
    }

    impl<R: Runtime> KoonaAppStore<R> {
        /// The prices of these products, by their App Store ids; a product StoreKit does not know
        /// is left out.
        pub async fn products(&self, ids: &[&str]) -> Result<Products, Error> {
            self.0.run_mobile_plugin_async("products", ProductsArgs { ids }).await.map_err(error)
        }

        /// The App Store's purchase sheet, with `account_token` as the purchase's `appAccountToken`;
        /// answers when the person has finished with it. Never finishes the transaction.
        pub async fn buy(&self, product: &str, account_token: &str) -> Result<Bought, Error> {
            self.0.run_mobile_plugin_async("buy", BuyArgs { product, account_token }).await.map_err(error)
        }

        /// The transactions not finished and what the Apple Account owns; with `sync`, after
        /// `AppStore.sync()` (Restore purchases: it may ask for the Apple Account's password).
        pub async fn transactions(&self, sync: bool) -> Result<Transactions, Error> {
            self.0.run_mobile_plugin_async("transactions", TransactionsArgs { sync }).await.map_err(error)
        }

        /// Finishes the transactions with these ids that are still unfinished, in one pass.
        pub async fn finish(&self, ids: &[String]) -> Result<(), Error> {
            self.0.run_mobile_plugin_async("finish", FinishArgs { ids }).await.map_err(error)
        }

        /// The system's sheet of this app's subscriptions (`showManageSubscriptions(in:)`).
        pub async fn manage(&self) -> Result<(), Error> {
            self.0.run_mobile_plugin_async("manage", ()).await.map_err(error)
        }

        /// Calls `handler` with what `Transaction.updates` brings: a purchase approved later, a
        /// renewal, a refund or a revocation.
        pub fn on_transactions(&self, handler: impl Fn(Vec<Transaction>) + Send + Sync + 'static) -> Result<(), Error> {
            let channel = Channel::new(move |body: InvokeResponseBody| {
                match body.deserialize::<Reported>() {
                    Ok(reported) => handler(reported.transactions),
                    Err(error) => eprintln!("Koona Pin: a transactions event that does not read: {error}"),
                }
                Ok(())
            });
            self.0.run_mobile_plugin::<()>("registerListener", Listener { event: "transactions", handler: channel }).map_err(error)
        }
    }
}

#[cfg(target_os = "ios")]
pub use ios::KoonaAppStore;

/// Registered by the app on iOS in the App Store build; nothing elsewhere.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("koona-appstore")
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            {
                use tauri::Manager;
                let handle = ios::register(&_api)?;
                _app.manage(KoonaAppStore(handle));
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
    fn the_answers_of_the_swift_side_read() {
        // As Swift's JSONEncoder writes the Codable structs (KoonaAppStorePlugin.swift).
        let bought: Bought = serde_json::from_value(json!({
            "outcome": "purchased",
            "transaction": {
                "id": "2000000123", "originalId": "2000000100", "product": "app.koona.pin.supporter.monthly",
                "jws": "eyJ.x.y", "accountToken": "0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9", "revoked": false, "verified": true
            }
        }))
        .unwrap();
        assert_eq!(bought.outcome, Outcome::Purchased);
        let transaction = bought.transaction.unwrap();
        assert_eq!((transaction.original_id.as_str(), transaction.account_token.as_deref()), ("2000000100", Some("0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9")));
        // Swift leaves a nil optional out.
        let none: Transaction = serde_json::from_value(json!({ "id": "1", "originalId": "1", "product": "p", "jws": "j" })).unwrap();
        assert_eq!((none.account_token, none.revoked, none.verified), (None, false, false));
        let products: Products = serde_json::from_value(json!({
            "products": [{ "id": "app.koona.pin.supporter.lifetime", "price": "$29.99", "currency": "USD", "micros": 29_990_000i64 }],
            "suspended": false
        }))
        .unwrap();
        assert_eq!(products.products[0].period, None);
        let listed: Transactions = serde_json::from_value(json!({ "unfinished": [] })).unwrap();
        assert!(listed.entitlements.is_empty());
    }

    #[test]
    fn an_answer_it_does_not_know_is_not_a_purchase() {
        let bought: Bought = serde_json::from_value(json!({ "outcome": "something_new" })).unwrap();
        assert_eq!((bought.outcome, bought.transaction), (Outcome::Error, None));
    }
}
