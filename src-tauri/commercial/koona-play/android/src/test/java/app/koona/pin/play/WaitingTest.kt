package app.koona.pin.play

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WaitingTest {
  @Test
  fun theFirstCallStartsTheConnectionAndAllRunOnceWithItsResult() {
    val waiting = Waiting<String>()
    val seen = mutableListOf<String>()
    val attempt = waiting.add { seen.add("a:$it") }
    assertEquals(1, attempt)
    assertNull("one connection at a time", waiting.add { seen.add("b:$it") })
    waiting.settle(attempt!!).forEach { it("ok") }
    assertEquals(listOf("a:ok", "b:ok"), seen)
    assertTrue("settled: nothing runs twice", waiting.settle(attempt).isEmpty())
  }

  @Test
  fun aConnectionThatDropsFailsWhatWaitedAndTheNextCallConnectsAgain() {
    val waiting = Waiting<String>()
    val seen = mutableListOf<String>()
    val attempt = waiting.add { seen.add(it) }!!
    // Dropped before setup finished: the queued call gets the failure, not silence.
    waiting.settle(attempt).forEach { it("disconnected") }
    assertEquals(listOf("disconnected"), seen)
    assertEquals(2, waiting.add { seen.add(it) })
  }

  @Test
  fun anAttemptWithoutAnAnswerTimesOutAndItsLateCallbackIsIgnored() {
    val waiting = Waiting<String>()
    val seen = mutableListOf<String>()
    val first = waiting.add { seen.add("first:$it") }!!
    // No callback in time: the timer settles the attempt with a failure.
    waiting.settle(first).forEach { it("timed out") }
    assertEquals(listOf("first:timed out"), seen)
    // The next call starts a new attempt; the first one's late callback changes nothing.
    val second = waiting.add { seen.add("second:$it") }!!
    assertEquals(2, second)
    assertTrue(waiting.settle(first).isEmpty())
    waiting.settle(second).forEach { it("ok") }
    assertEquals(listOf("first:timed out", "second:ok"), seen)
  }
}
