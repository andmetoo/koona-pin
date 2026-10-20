package app.koona.pin.play

import android.app.Activity
import android.util.Log
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClient.BillingResponseCode
import com.android.billingclient.api.BillingClient.ProductType
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import java.util.concurrent.ConcurrentHashMap

private const val TAG = "KoonaPlay"

/** The products the sheet shows, by Play's ids. */
@InvokeArg
class ProductsArgs {
  var subscriptions: Array<String> = arrayOf()
  var oneTime: Array<String> = arrayOf()
}

/** One purchase: a base plan of a subscription, or a one-time product (`basePlan` null). */
@InvokeArg
class BuyArgs {
  var product: String = ""
  var basePlan: String? = null
  /** SHA-256 hex of the app's purchase secret: how the server knows the purchase is this app's. */
  var accountId: String = ""
}

/**
 * Supporter through Google Play Billing (NP-154), for the app's Rust side (billing.rs), never the
 * page: the prices (`products`), a purchase (`buy`), what this Google account owns (`purchases`), and
 * the `purchases` event when Play reports a purchase outside `buy` (a slow payment that completed).
 * It never acknowledges or consumes: the server does both once it has verified the purchase, so a
 * purchase nobody claims is refunded by Play after three days.
 */
@TauriPlugin
class KoonaPlayPlugin(private val activity: Activity) : Plugin(activity), PurchasesUpdatedListener {
  private val client: BillingClient = BillingClient.newBuilder(activity)
    .setListener(this)
    .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
    .enableAutoServiceReconnection()
    .build()

  /**
   * Play's products by id, from this sheet's `products`: a purchase needs the object. Asked afresh
   * each time the sheet opens, as Google asks: a stale one can make the purchase fail.
   */
  private val details = ConcurrentHashMap<String, ProductDetails>()

  private val lock = Any()

  /** The `buy` waiting for Play's answer, one at a time, and the account id it was made with. */
  private var buying: Invoke? = null
  private var buyingAccount: String? = null

  /** What waits for the connection to Play. */
  private val waiting = Waiting<BillingResult>()

  /**
   * Runs `action` once connected to Play, with the setup's result; at once when connected. A setup
   * that fails or a connection that drops before it is set up fails what waited, so no call hangs.
   */
  private fun ready(action: (BillingResult) -> Unit) {
    if (client.isReady) return action(BillingResult.newBuilder().setResponseCode(BillingResponseCode.OK).build())
    if (!waiting.add(action)) return
    client.startConnection(object : BillingClientStateListener {
      override fun onBillingSetupFinished(result: BillingResult) {
        waiting.settle().forEach { it(result) }
      }

      // Later calls reconnect by themselves (enableAutoServiceReconnection); those waiting now fail.
      override fun onBillingServiceDisconnected() {
        val dropped = BillingResult.newBuilder()
          .setResponseCode(BillingResponseCode.SERVICE_DISCONNECTED)
          .setDebugMessage("The connection to Google Play dropped")
          .build()
        waiting.settle().forEach { it(dropped) }
      }
    })
  }

  private fun ok(result: BillingResult) = result.responseCode == BillingResponseCode.OK

  private fun reject(invoke: Invoke, result: BillingResult) {
    Log.w(TAG, "Play answered ${result.responseCode}: ${result.debugMessage}")
    invoke.reject(result.debugMessage.ifEmpty { "Google Play answered ${result.responseCode}" }, Catalog.failure(result.responseCode))
  }

  /** Play's products of one type; an empty list for no ids. */
  private fun query(ids: List<String>, type: String, done: (BillingResult, List<ProductDetails>) -> Unit) {
    if (ids.isEmpty()) {
      done(BillingResult.newBuilder().setResponseCode(BillingResponseCode.OK).build(), emptyList())
      return
    }
    val products = ids.map { QueryProductDetailsParams.Product.newBuilder().setProductId(it).setProductType(type).build() }
    client.queryProductDetailsAsync(QueryProductDetailsParams.newBuilder().setProductList(products).build()) { result, queried ->
      val list = queried.productDetailsList
      list.forEach { details[it.productId] = it }
      done(result, list)
    }
  }

  @Command
  fun products(invoke: Invoke) {
    val args = invoke.parseArgs(ProductsArgs::class.java)
    details.clear()
    ready { setup ->
      if (!ok(setup)) return@ready reject(invoke, setup)
      // One type per query: Play refuses a list that mixes them.
      query(args.subscriptions.toList(), ProductType.SUBS) { subsResult, subscriptions ->
        if (!ok(subsResult)) return@query reject(invoke, subsResult)
        query(args.oneTime.toList(), ProductType.INAPP) { oneTimeResult, oneTime ->
          if (!ok(oneTimeResult)) return@query reject(invoke, oneTimeResult)
          val prices = subscriptions.flatMap { Catalog.subscription(it.productId, offers(it)) } +
            oneTime.mapNotNull { Catalog.oneTime(it.productId, options(it)) }
          invoke.resolveObject(Products(prices))
        }
      }
    }
  }

  @Command
  fun buy(invoke: Invoke) {
    val args = invoke.parseArgs(BuyArgs::class.java)
    val stale = synchronized(lock) {
      buyingAccount = args.accountId
      buying.also { buying = invoke }
    }
    // A purchase whose answer never came (the sheet lost with its activity): this one replaces it.
    stale?.resolveObject(BuyResult("error", emptyList()))
    val type = if (args.basePlan == null) ProductType.INAPP else ProductType.SUBS
    ready { setup ->
      if (!ok(setup)) return@ready finish(invoke, Catalog.outcome(setup.responseCode, emptyList()), emptyList())
      val known = details[args.product]
      if (known != null) launch(invoke, args, known)
      else query(listOf(args.product), type) { result, found ->
        val product = found.firstOrNull()
        when {
          !ok(result) -> finish(invoke, Catalog.outcome(result.responseCode, emptyList()), emptyList())
          product == null -> finish(invoke, "unavailable", emptyList())
          else -> launch(invoke, args, product)
        }
      }
    }
  }

  /** Play's purchase sheet for this product: its base plan's offer, or its one-time option. */
  private fun launch(invoke: Invoke, args: BuyArgs, product: ProductDetails) {
    val params = BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(product)
    val basePlan = args.basePlan
    if (basePlan != null) {
      val offer = Catalog.basePlanOffer(offers(product), basePlan) ?: return finish(invoke, "unavailable", emptyList())
      params.setOfferToken(offer.token)
    } else {
      Catalog.oneTimeOption(options(product))?.token?.let { params.setOfferToken(it) }
    }
    val flow = BillingFlowParams.newBuilder()
      .setProductDetailsParamsList(listOf(params.build()))
      .setObfuscatedAccountId(args.accountId)
      .build()
    activity.runOnUiThread {
      val result = client.launchBillingFlow(activity, flow)
      // Otherwise the answer comes in onPurchasesUpdated.
      if (!ok(result)) {
        Log.w(TAG, "The purchase did not start: ${result.responseCode} ${result.debugMessage}")
        answer(invoke, result.responseCode, emptyList())
      }
    }
  }

  /** The answer to `buy`, once; a purchase owned already comes with what this account owns. */
  private fun answer(invoke: Invoke, code: Int, purchases: List<PurchaseFacts>) {
    if (code == BillingResponseCode.ITEM_ALREADY_OWNED) {
      owned { _, owned -> finish(invoke, "already_owned", owned) }
    } else {
      finish(invoke, Catalog.outcome(code, purchases), purchases)
    }
  }

  private fun finish(invoke: Invoke, outcome: String, purchases: List<PurchaseFacts>) {
    val current = synchronized(lock) {
      (buying === invoke).also {
        if (it) {
          buying = null
          buyingAccount = null
        }
      }
    }
    if (current) invoke.resolveObject(BuyResult(outcome, purchases.map(Catalog::bought)))
  }

  override fun onPurchasesUpdated(result: BillingResult, purchases: MutableList<Purchase>?) {
    val facts = purchases.orEmpty().map(::facts)
    val (invoke, account) = synchronized(lock) { buying to buyingAccount }
    // While a purchase waits, an update about another one (a slow payment completing) is not its
    // answer: that goes to the app as an event, and the sheet keeps waiting for its own.
    if (invoke != null && Catalog.answers(result.responseCode, facts, account)) {
      answer(invoke, result.responseCode, facts)
    } else if (facts.isNotEmpty()) {
      // A slow payment that completed, or a purchase made while no sheet waited: the app verifies it.
      triggerObject("purchases", BuyResult(Catalog.outcome(result.responseCode, facts), facts.map(Catalog::bought)))
    }
  }

  /** Subscriptions, suspended ones too, then one-time products; acknowledged or not. */
  @Command
  fun purchases(invoke: Invoke) {
    owned { result, owned ->
      if (result != null) reject(invoke, result) else invoke.resolveObject(Purchases(owned.map(Catalog::bought)))
    }
  }

  /** What this Google account owns; the failed query's result, if one failed. */
  private fun owned(done: (BillingResult?, List<PurchaseFacts>) -> Unit) {
    ready { setup ->
      if (!ok(setup)) return@ready done(setup, emptyList())
      val subs = QueryPurchasesParams.newBuilder().setProductType(ProductType.SUBS).includeSuspendedSubscriptions(true).build()
      client.queryPurchasesAsync(subs) { subsResult, subscriptions ->
        if (!ok(subsResult)) return@queryPurchasesAsync done(subsResult, emptyList())
        val oneTime = QueryPurchasesParams.newBuilder().setProductType(ProductType.INAPP).build()
        client.queryPurchasesAsync(oneTime) { oneTimeResult, products ->
          if (!ok(oneTimeResult)) return@queryPurchasesAsync done(oneTimeResult, emptyList())
          done(null, (subscriptions + products).map(::facts))
        }
      }
    }
  }

  private fun facts(purchase: Purchase) = PurchaseFacts(
    token = purchase.purchaseToken,
    products = purchase.products,
    state = purchase.purchaseState,
    acknowledged = purchase.isAcknowledged,
    suspended = purchase.isSuspended,
    accountId = purchase.accountIdentifiers?.obfuscatedAccountId,
  )

  private fun offers(product: ProductDetails): List<Offer> =
    product.subscriptionOfferDetails.orEmpty().map { offer ->
      Offer(
        basePlan = offer.basePlanId,
        offerId = offer.offerId,
        token = offer.offerToken,
        phases = offer.pricingPhases.pricingPhaseList.map {
          Phase(it.formattedPrice, it.priceAmountMicros, it.priceCurrencyCode, it.billingPeriod, it.recurrenceMode)
        },
      )
    }

  private fun options(product: ProductDetails): List<OneTimeOption> =
    product.oneTimePurchaseOfferDetailsList.orEmpty().map {
      OneTimeOption(it.offerId, it.offerToken, it.formattedPrice, it.priceAmountMicros, it.priceCurrencyCode)
    }
}
