import { Schema } from "effect"

/**
 * `WatchdogTimeout` is the typed error surfaced when the heartbeat-
 * driven liveness watchdog observes > 3 × clamped-intervalMs since
 * the last `Heartbeat` arrival. As of v0.5.2 the class itself lives
 * in `@rxweave/protocol/Heartbeat.ts` so it can be shared with the
 * Convex-hosted Subscribe handler in the private cloud repo. We re-
 * export it from this module so pre-v0.5.2 consumers
 * (`@rxweave/store-cloud` re-exports from index.ts, plus `apps/web`
 * + conformance tests that import it directly) keep working with no
 * import-path change. Single class identity preserved — `instanceof`
 * still works for anyone catching it on the user-facing side.
 */
export { WatchdogTimeout } from "@rxweave/protocol"

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
