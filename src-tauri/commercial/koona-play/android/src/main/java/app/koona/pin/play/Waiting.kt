package app.koona.pin.play

/**
 * The calls waiting for the connection to Play. Each runs exactly once: with the setup's result, or
 * with a failure when the connection fails or drops before it is set up, so no call waits for good.
 */
class Waiting<T> {
  private val actions = mutableListOf<(T) -> Unit>()
  private var connecting = false

  /** Queues `action`; true when the caller is the one to start the connection. */
  @Synchronized
  fun add(action: (T) -> Unit): Boolean {
    actions.add(action)
    return (!connecting).also { connecting = true }
  }

  /** The connection is set up, failed or dropped: everything queued, to run once with the result. */
  @Synchronized
  fun settle(): List<(T) -> Unit> {
    connecting = false
    return actions.toList().also { actions.clear() }
  }
}
