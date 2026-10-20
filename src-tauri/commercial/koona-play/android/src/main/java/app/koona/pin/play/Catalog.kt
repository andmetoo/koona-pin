package app.koona.pin.play

import com.android.billingclient.api.BillingClient.BillingResponseCode
import com.android.billingclient.api.ProductDetails.RecurrenceMode
import com.android.billingclient.api.Purchase.PurchaseState

/** A pricing phase of a subscription offer, as Play gives it. */
data class Phase(val price: String, val micros: Long, val currency: String, val period: String, val recurrence: Int)

/** A subscription offer: a base plan's own (`offerId` null) or a promotion on it. */
data class Offer(val basePlan: String, val offerId: String?, val token: String, val phases: List<Phase>)

/** A way to buy a one-time product; `token` is null for a product with the single legacy option. */
data class OneTimeOption(val offerId: String?, val token: String?, val price: String, val micros: Long, val currency: String)

/** A price the sheet shows: one per base plan of a subscription, one per one-time product. */
data class Product(
  val product: String,
  val basePlan: String?,
  val price: String,
  val currency: String,
  val micros: Long,
  /** ISO 8601 (`P1M`, `P1Y`) for a subscription; null for a one-time product. */
  val period: String?,
)

/** A purchase as Play reports it, read from `com.android.billingclient.api.Purchase`. */
data class PurchaseFacts(
  val token: String,
  val products: List<String>,
  val state: Int,
  val acknowledged: Boolean,
  val suspended: Boolean,
  val accountId: String?,
)

/** A purchase as the app's Rust side reads it. */
data class Bought(
  val token: String,
  val products: List<String>,
  /** `purchased`, `pending` or `unspecified`. */
  val state: String,
  val acknowledged: Boolean,
  val suspended: Boolean,
  val accountId: String?,
)

/** The answer of `buy` and of the `purchases` event. */
data class BuyResult(val outcome: String, val purchases: List<Bought>)

/** The answer of `products`. */
data class Products(val products: List<Product>)

/** The answer of `purchases`. */
data class Purchases(val purchases: List<Bought>)

/**
 * What the plugin answers, from Play's objects read into plain facts: kept apart from the Play Store
 * so the choices are tested on the JVM (NP-154). The plugin never acknowledges or consumes; the
 * server does, once it has verified the purchase.
 */
object Catalog {
  /** The base plan's own offer: no promotion, the price people pay every period. */
  fun basePlanOffer(offers: List<Offer>, basePlan: String): Offer? =
    offers.firstOrNull { it.offerId == null && it.basePlan == basePlan }

  /** The phase that recurs for good; a base plan's offer has only that one. */
  fun recurring(phases: List<Phase>): Phase? =
    phases.lastOrNull { it.recurrence == RecurrenceMode.INFINITE_RECURRING } ?: phases.lastOrNull()

  /** One price per base plan of a subscription; promotions are not offered. */
  fun subscription(product: String, offers: List<Offer>): List<Product> =
    offers.filter { it.offerId == null }.mapNotNull { offer ->
      recurring(offer.phases)?.let { Product(product, offer.basePlan, it.price, it.currency, it.micros, it.period) }
    }

  /** The purchase option bought: the one without an offer, else the first. */
  fun oneTimeOption(options: List<OneTimeOption>): OneTimeOption? =
    options.firstOrNull { it.offerId == null } ?: options.firstOrNull()

  fun oneTime(product: String, options: List<OneTimeOption>): Product? =
    oneTimeOption(options)?.let { Product(product, null, it.price, it.currency, it.micros, null) }

  fun state(purchaseState: Int): String = when (purchaseState) {
    PurchaseState.PURCHASED -> "purchased"
    PurchaseState.PENDING -> "pending"
    else -> "unspecified"
  }

  fun bought(facts: PurchaseFacts): Bought =
    Bought(facts.token, facts.products, state(facts.state), facts.acknowledged, facts.suspended, facts.accountId)

  /**
   * What a purchase came to, by Play's answer: paid, waiting for a slow payment, cancelled, owned
   * already (by this Google account, maybe for another Koona Pin account), not possible here (no
   * Play Store, a blocked one, a product not on sale), or anything else.
   */
  fun outcome(code: Int, purchases: List<PurchaseFacts>): String = when (code) {
    BillingResponseCode.OK -> when {
      purchases.any { it.state == PurchaseState.PURCHASED } -> "purchased"
      purchases.any { it.state == PurchaseState.PENDING } -> "pending"
      else -> "error"
    }
    BillingResponseCode.USER_CANCELED -> "canceled"
    BillingResponseCode.ITEM_ALREADY_OWNED -> "already_owned"
    BillingResponseCode.BILLING_UNAVAILABLE,
    BillingResponseCode.ITEM_UNAVAILABLE,
    BillingResponseCode.FEATURE_NOT_SUPPORTED -> "unavailable"
    else -> "error"
  }

  /** A query that failed: Play is not there (`unavailable`) or did not answer (`error`). */
  fun failure(code: Int): String = when (code) {
    BillingResponseCode.BILLING_UNAVAILABLE,
    BillingResponseCode.FEATURE_NOT_SUPPORTED -> "unavailable"
    else -> "error"
  }
}
