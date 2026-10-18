package app.koona.pin.mobile

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * The open system Backs, by number (NP-151): each one is waiting for the page, claimed by it, or
 * given up on. The page claims from its JavaBridge thread ([claim]); the timer and the page's
 * answer settle it on the main thread ([Back.giveUp], [Back.answered]). Either of those forgets the
 * Back, so one the page never answers does not stay behind, and a claim after that is refused.
 */
internal class BackLedger {
  private val open = ConcurrentHashMap<Int, AtomicInteger>()
  private val next = AtomicInteger()

  /** A new Back, waiting for the page. */
  fun open(): Back {
    val back = Back(next.incrementAndGet(), AtomicInteger(WAITING))
    open[back.id] = back.state
    return back
  }

  /** The page's claim: true only for a Back still waiting, which then is the page's alone. */
  fun claim(id: Int): Boolean = open[id]?.compareAndSet(WAITING, CLAIMED) ?: false

  /** How many Backs are still open. */
  val size: Int get() = open.size

  inner class Back internal constructor(val id: Int, internal val state: AtomicInteger) {
    /** The page took too long: true when the app should go to the background now (unclaimed). */
    fun giveUp(): Boolean {
      open.remove(id)
      return state.compareAndSet(WAITING, GIVEN_UP)
    }

    /**
     * The page answered, [closed] or not: true when the app should go to the background now —
     * nothing closed, and the timer has not already sent it there.
     */
    fun answered(closed: Boolean): Boolean {
      open.remove(id)
      if (closed) return false
      return state.compareAndSet(WAITING, GIVEN_UP) || state.get() == CLAIMED
    }
  }

  private companion object {
    const val WAITING = 0
    const val CLAIMED = 1
    const val GIVEN_UP = 2
  }
}
