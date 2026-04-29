import { Schema } from "effect"

/**
 * Surfaced when the heartbeat-driven liveness watchdog observes
 * `> 3 × intervalMs` since the last `Heartbeat` arrival. Classified
 * retryable by `Retry.isRetryable` so the existing Stream.retry
 * schedule reconnects from the last-delivered cursor.
 *
 * Only armed once the first heartbeat is observed — see `makeLive`
 * subscribe pipeline. Old servers (cloud-v0.2) that ignore the
 * heartbeat field never arm the watchdog, so this error never
 * fires against them.
 */
export class WatchdogTimeout extends Schema.TaggedError<WatchdogTimeout>()(
  "WatchdogTimeout",
  { idleMs: Schema.Number },
) {}
