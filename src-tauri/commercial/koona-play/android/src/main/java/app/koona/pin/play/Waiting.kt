package app.koona.pin.play

/**
 * The calls waiting for the connection to Play. Each runs exactly once: with the setup's result, or
 * with a failure when the connection fails, drops, or gives no answer in time. Every connection
 * attempt has its number; only the attempt in progress settles the queue, so a callback that comes
 * after its attempt timed out is ignored, and the next call starts a new attempt.
 */
class Waiting<T> {
  private val actions = mutableListOf<(T) -> Unit>()
  private var attempt = 0
  private var connecting = false

  /** Queues `action`; the number of the attempt the caller is to start, or null when one runs. */
  @Synchronized
  fun add(action: (T) -> Unit): Int? {
    actions.add(action)
    if (connecting) return null
    connecting = true
    return ++attempt
  }

  /**
   * Attempt `number` is set up, failed, dropped or timed out: everything queued, to run once with
   * the result. Nothing when that attempt was settled already.
   */
  @Synchronized
  fun settle(number: Int): List<(T) -> Unit> {
    if (!connecting || number != attempt) return emptyList()
    connecting = false
    return actions.toList().also { actions.clear() }
  }
}
