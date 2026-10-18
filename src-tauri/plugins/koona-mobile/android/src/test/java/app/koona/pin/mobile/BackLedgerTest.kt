package app.koona.pin.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BackLedgerTest {
  @Test
  fun aClaimedBackThatClosedSomethingStaysInTheApp() {
    val ledger = BackLedger()
    val back = ledger.open()
    assertTrue(ledger.claim(back.id))
    assertFalse(back.answered(closed = true))
    assertEquals(0, ledger.size)
  }

  @Test
  fun anUnclaimedBackWithNothingToCloseGoesToTheBackground() {
    val ledger = BackLedger()
    val back = ledger.open()
    assertTrue(back.answered(closed = false))
    assertEquals(0, ledger.size)
  }

  @Test
  fun aBackClaimedTwiceIsClaimedOnce() {
    val ledger = BackLedger()
    val back = ledger.open()
    assertTrue(ledger.claim(back.id))
    assertFalse(ledger.claim(back.id))
  }

  @Test
  fun givingUpForgetsTheBackAndRefusesALateClaim() {
    val ledger = BackLedger()
    val back = ledger.open()
    assertTrue(back.giveUp())
    assertEquals(0, ledger.size)
    assertFalse(ledger.claim(back.id))
    // The late answer closed nothing, and the app is already in the background.
    assertFalse(back.answered(closed = false))
  }

  @Test
  fun aBackThePageNeverAnswersDoesNotStayBehind() {
    val ledger = BackLedger()
    repeat(5) { ledger.open().giveUp() }
    assertEquals(0, ledger.size)
  }

  @Test
  fun theTimerLeavesAClaimedBackToThePage() {
    val ledger = BackLedger()
    val back = ledger.open()
    assertTrue(ledger.claim(back.id))
    assertFalse(back.giveUp())
    assertEquals(0, ledger.size)
  }

  @Test
  fun aClaimedBackThatClosedNothingStillGoesToTheBackground() {
    val ledger = BackLedger()
    val back = ledger.open()
    assertTrue(ledger.claim(back.id))
    assertTrue(back.answered(closed = false))
  }

  @Test
  fun unknownNumbersAreRefused() {
    assertFalse(BackLedger().claim(42))
  }

  @Test
  fun claimAndGiveUpRacingHaveOneWinner() {
    repeat(2000) {
      val ledger = BackLedger()
      val back = ledger.open()
      var claimed = false
      val page = Thread { claimed = ledger.claim(back.id) }
      page.start()
      val gaveUp = back.giveUp()
      page.join()
      assertTrue("exactly one outcome", claimed != gaveUp)
    }
  }
}
