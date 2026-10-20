package app.koona.pin.play

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WaitingTest {
  @Test
  fun theFirstCallStartsTheConnectionAndAllRunOnceWithItsResult() {
    val waiting = Waiting<String>()
    val seen = mutableListOf<String>()
    assertTrue(waiting.add { seen.add("a:$it") })
    assertFalse("one connection at a time", waiting.add { seen.add("b:$it") })
    waiting.settle().forEach { it("ok") }
    assertEquals(listOf("a:ok", "b:ok"), seen)
    assertTrue("settled: nothing runs twice", waiting.settle().isEmpty())
  }

  @Test
  fun aConnectionThatDropsFailsWhatWaitedAndTheNextCallConnectsAgain() {
    val waiting = Waiting<String>()
    val seen = mutableListOf<String>()
    waiting.add { seen.add(it) }
    // Dropped before setup finished: the queued call gets the failure, not silence.
    waiting.settle().forEach { it("disconnected") }
    assertEquals(listOf("disconnected"), seen)
    assertTrue(waiting.add { seen.add(it) })
  }

  @Test
  fun aCallOutOfTimeFailsAloneAndLaterCallsJoinTheAttemptInFlight() {
    val waiting = Waiting<String>()
    val seen = mutableListOf<String>()
    val first: (String) -> Unit = { seen.add("first:$it") }
    assertTrue(waiting.add(first))
    // No callback in time: the first call fails alone; the attempt is still in flight.
    assertTrue(waiting.expire(first))
    first("timed out")
    // A later call joins it: no second startConnection, which Play refuses while connecting.
    assertFalse(waiting.add { seen.add("second:$it") })
    // The callback comes at last: it settles the second call only, and the first one never twice.
    waiting.settle().forEach { it("ok") }
    assertEquals(listOf("first:timed out", "second:ok"), seen)
    assertFalse("an answered call does not time out", waiting.expire(first))
  }
}
