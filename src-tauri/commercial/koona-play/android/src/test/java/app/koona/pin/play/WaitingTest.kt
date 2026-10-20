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
}
