package app.koona.pin.play

/**
 * The calls waiting for the connection to Play. One connection attempt runs at a time and is never
 * started twice: Play's BillingClient refuses startConnection while it is still connecting, and one
 * whose endConnection was called can never connect again. So a call that comes while an attempt is
 * in flight joins it, and each call has its own time limit: one that runs out fails alone (`expire`),
 * the attempt goes on for the others, and when its callback comes at last it settles whoever waits.
 */
class Waiting<T> {
  private val actions = mutableListOf<(T) -> Unit>()
  private var connecting = false

  /** Queues `action`; true when the caller is to start the connection (none is in flight). */
  @Synchronized
  fun add(action: (T) -> Unit): Boolean {
    actions.add(action)
    return (!connecting).also { connecting = true }
  }

  /** The attempt answered (set up, failed or dropped): everything queued, to run once with it. */
  @Synchronized
  fun settle(): List<(T) -> Unit> {
    connecting = false
    return actions.toList().also { actions.clear() }
  }

  /** `action` ran out of time: true when it still waited (it is taken out, to fail alone). */
  @Synchronized
  fun expire(action: (T) -> Unit): Boolean = actions.remove(action)
}
