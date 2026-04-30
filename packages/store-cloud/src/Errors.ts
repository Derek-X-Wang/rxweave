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

/**
 * Raised by `sessionTokenFetch` when two consecutive RPC calls return
 * 401 — even after invalidating the cached token and refetching a fresh
 * one. At this point the session cannot be recovered by retrying; the
 * application must re-bootstrap (e.g., reload the page or prompt the
 * user to log in again). Terminal — not classified as retryable.
 */
export class AuthFailed extends Schema.TaggedError<AuthFailed>()(
  "AuthFailed",
  { cause: Schema.String },
) {}
