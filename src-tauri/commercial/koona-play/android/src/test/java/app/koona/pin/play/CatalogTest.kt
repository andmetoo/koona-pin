package app.koona.pin.play

import com.android.billingclient.api.BillingClient.BillingResponseCode
import com.android.billingclient.api.ProductDetails.RecurrenceMode
import com.android.billingclient.api.Purchase.PurchaseState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CatalogTest {
  private fun monthly(price: String = "€2.00") = Phase(price, 2_000_000, "EUR", "P1M", RecurrenceMode.INFINITE_RECURRING)

  private val trial = Phase("Free", 0, "EUR", "P1W", RecurrenceMode.FINITE_RECURRING)

  private val offers = listOf(
    // A promotion on the monthly plan comes first in Play's list; it is never the one offered.
    Offer("monthly", "welcome", "token-welcome", listOf(trial, monthly())),
    Offer("monthly", null, "token-monthly", listOf(monthly())),
    Offer("yearly", null, "token-yearly", listOf(Phase("€20.00", 20_000_000, "EUR", "P1Y", RecurrenceMode.INFINITE_RECURRING))),
  )

  @Test
  fun aBasePlanIsBoughtThroughItsOwnOfferNotAPromotion() {
    assertEquals("token-monthly", Catalog.basePlanOffer(offers, "monthly")?.token)
    assertEquals("token-yearly", Catalog.basePlanOffer(offers, "yearly")?.token)
    assertNull(Catalog.basePlanOffer(offers, "weekly"))
    assertNull(Catalog.basePlanOffer(listOf(offers[0]), "monthly"))
  }

  @Test
  fun aSubscriptionShowsOnePricePerBasePlan() {
    assertEquals(
      listOf(
        Product("supporter", "monthly", "€2.00", "EUR", 2_000_000, "P1M"),
        Product("supporter", "yearly", "€20.00", "EUR", 20_000_000, "P1Y"),
      ),
      Catalog.subscription("supporter", offers),
    )
  }

  @Test
  fun thePriceIsTheOneThatRecurs() {
    assertEquals(monthly(), Catalog.recurring(listOf(trial, monthly())))
    assertEquals(trial, Catalog.recurring(listOf(trial)))
    assertNull(Catalog.recurring(emptyList()))
    assertEquals(emptyList<Product>(), Catalog.subscription("supporter", listOf(Offer("monthly", null, "t", emptyList()))))
  }

  @Test
  fun aOneTimeProductIsBoughtThroughItsOptionWithoutAnOffer() {
    val options = listOf(
      OneTimeOption("launch", "token-launch", "€40.00", 40_000_000, "EUR"),
      OneTimeOption(null, "token-buy", "€29.99", 29_990_000, "EUR"),
    )
    assertEquals("token-buy", Catalog.oneTimeOption(options)?.token)
    assertEquals(Product("supporter_lifetime", null, "€29.99", "EUR", 29_990_000, null), Catalog.oneTime("supporter_lifetime", options))
    assertEquals("token-launch", Catalog.oneTimeOption(options.take(1))?.token)
    assertNull(Catalog.oneTime("supporter_lifetime", emptyList()))
  }

  @Test
  fun aPurchaseIsReadAsTheAppNeedsIt() {
    val facts = PurchaseFacts("token", listOf("supporter"), PurchaseState.PENDING, false, false, "a".repeat(64))
    assertEquals(Bought("token", listOf("supporter"), "pending", false, false, "a".repeat(64)), Catalog.bought(facts))
    assertEquals("purchased", Catalog.state(PurchaseState.PURCHASED))
    assertEquals("unspecified", Catalog.state(PurchaseState.UNSPECIFIED_STATE))
    assertEquals("unspecified", Catalog.state(42))
  }

  @Test
  fun anUpdateAboutAnotherPurchaseIsNotTheAnswerOfTheOneWaiting() {
    val mine = PurchaseFacts("m", listOf("supporter"), PurchaseState.PURCHASED, false, false, "mine")
    val earlier = PurchaseFacts("e", listOf("supporter_lifetime"), PurchaseState.PURCHASED, false, false, "earlier")
    assertTrue(Catalog.answers(BillingResponseCode.OK, listOf(earlier, mine), "mine"))
    assertFalse("a slow payment completing while the sheet is open", Catalog.answers(BillingResponseCode.OK, listOf(earlier), "mine"))
    assertTrue("a failure answers the purchase", Catalog.answers(BillingResponseCode.USER_CANCELED, emptyList(), "mine"))
    assertTrue("so does an empty answer", Catalog.answers(BillingResponseCode.OK, emptyList(), "mine"))
  }

  @Test
  fun playsAnswerIsTheOutcomeOfThePurchase() {
    val paid = PurchaseFacts("p", listOf("supporter"), PurchaseState.PURCHASED, false, false, null)
    val slow = PurchaseFacts("s", listOf("supporter"), PurchaseState.PENDING, false, false, null)
    assertEquals("purchased", Catalog.outcome(BillingResponseCode.OK, listOf(slow, paid)))
    assertEquals("pending", Catalog.outcome(BillingResponseCode.OK, listOf(slow)))
    assertEquals("error", Catalog.outcome(BillingResponseCode.OK, emptyList()))
    assertEquals("canceled", Catalog.outcome(BillingResponseCode.USER_CANCELED, emptyList()))
    assertEquals("already_owned", Catalog.outcome(BillingResponseCode.ITEM_ALREADY_OWNED, emptyList()))
    for (code in listOf(BillingResponseCode.BILLING_UNAVAILABLE, BillingResponseCode.ITEM_UNAVAILABLE, BillingResponseCode.FEATURE_NOT_SUPPORTED)) {
      assertEquals("unavailable", Catalog.outcome(code, emptyList()))
    }
    for (code in listOf(BillingResponseCode.ERROR, BillingResponseCode.NETWORK_ERROR, BillingResponseCode.SERVICE_UNAVAILABLE, BillingResponseCode.DEVELOPER_ERROR)) {
      assertEquals("error", Catalog.outcome(code, listOf(paid)))
    }
    assertEquals("unavailable", Catalog.failure(BillingResponseCode.BILLING_UNAVAILABLE))
    assertEquals("error", Catalog.failure(BillingResponseCode.SERVICE_UNAVAILABLE))
  }
}
