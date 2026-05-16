/**
 * Heartbeat module — sentinel emit, clamp policy, and client-side
 * liveness watchdog as a single source of truth for the `Subscribe`
 * stream's keep-alive contract.
 *
 * Pre-v0.5.2 these concerns lived split across `handlers/Subscribe.ts`
 * (server emit + clamp) and `@rxweave/store-cloud/CloudStore.ts`
 * (client watchdog + filter), with their own private copies of the
 * clamp + idle-threshold rules. A drift between the two surfaced
 * as a false-watchdog reconnect storm on any sub-second heartbeat
 * request (the server clamped up to 1000 ms but the client computed
 * `idleThreshold = intervalMs * 3` from the unclamped request).
 *
 * ## Scope
 *
 * - Wire constants: `MIN_INTERVAL_MS`, `MAX_INTERVAL_MS`.
 * - `clampIntervalMs` — the canonical clamp the server applies to
 *   requested intervals. Exported so callers (and tests) can predict
 *   the effective interval; `makeHeartbeatStream` calls it internally
 *   so callers cannot forget.
 * - `makeHeartbeatStream(rawIntervalMs)` — server-side: emit
 *   `Heartbeat` sentinels at the *clamped* cadence. The clamp lives
 *   inside this function so a private cloud handler bypassing
 *   `@effect/rpc` cannot accidentally emit at a sub-minimum cadence.
 * - `heartbeatGuard(intervalMs)` — client-side stream combinator
 *   that taps each incoming item to arm an internal `lastHeartbeatAt`
 *   Ref, strips `Heartbeat` sentinels from the output stream, and
 *   merges in a never-emitting watchdog stream that fails with
 *   `WatchdogTimeout` once the idle threshold elapses post-arming.
 * - `WatchdogTimeout` — typed error surfaced by the watchdog. Lives
 *   here (not in `@rxweave/store-cloud`) because it is part of the
 *   heartbeat contract; any consumer of `heartbeatGuard` will catch
 *   it. `@rxweave/store-cloud` re-exports it for backward compat
 *   with pre-v0.5.2 callers.
 *
 * ## Watchdog contract
 *
 * - The watchdog is *armed* by the first observed `Heartbeat`. Before
 *   the first heartbeat, the watchdog never fires — this guards
 *   against old servers (e.g., cloud-v0.2) that ignore the heartbeat
 *   request and still keep the subscribe stream open.
 * - Once armed, the watchdog fails the stream with `WatchdogTimeout`
 *   if more than `clampIntervalMs(intervalMs) * 3` ms elapse without
 *   another `Heartbeat`. The clamp here matches the server's clamp,
 *   so a client requesting a sub-minimum interval still uses a
 *   threshold the server can realistically meet.
 * - Polling cadence is 1 Hz internally — fast enough that detection
 *   latency is bounded by the polling resolution, slow enough not
 *   to dominate the fiber's CPU budget.
 *
 * ## Stream completion semantics
 *
 * The watchdog stream is `Stream<never, WatchdogTimeout, never>` —
 * it never emits, only fails. `heartbeatGuard` composes it via
 * `Stream.merge`, which means *the merged stream will not complete
 * even if the source stream completes* — the watchdog runs forever
 * until interrupted. This is correct for the live-tail `Subscribe`
 * stream (which is itself unbounded) but would prevent finite
 * source streams from completing. **Use this combinator only on
 * live / infinite source streams.**
 */

import { Clock, Duration, Effect, Ref, Schedule, Schema, Stream } from "effect"

import { Heartbeat } from "./RxWeaveRpc.js"

/** Minimum heartbeat interval the server will honor (ms). */
export const MIN_INTERVAL_MS = 1000

/** Maximum heartbeat interval the server will honor (ms). */
export const MAX_INTERVAL_MS = 300_000

const IDLE_THRESHOLD_MULTIPLIER = 3

/**
 * Clamp a requested heartbeat interval into the supported wire
 * range. Out-of-range values (including `NaN` and negatives) are
 * silently clamped to `MIN_INTERVAL_MS`; values above
 * `MAX_INTERVAL_MS` are clamped down to the maximum.
 */
export const clampIntervalMs = (ms: number): number => {
  if (!Number.isFinite(ms) || ms < MIN_INTERVAL_MS) return MIN_INTERVAL_MS
  if (ms > MAX_INTERVAL_MS) return MAX_INTERVAL_MS
  return ms
}

/**
 * Server-side: emit `Heartbeat` sentinels forever at the (clamped)
 * `rawIntervalMs` cadence. The first heartbeat is emitted
 * immediately; subsequent heartbeats follow at the clamped interval.
 *
 * Self-clamps internally — callers pass the raw requested value and
 * cannot accidentally bypass the wire-range invariant.
 */
export const makeHeartbeatStream = (
  rawIntervalMs: number,
): Stream.Stream<Heartbeat, never, never> => {
  const intervalMs = clampIntervalMs(rawIntervalMs)
  return Stream.repeatEffectWithSchedule(
    Effect.clockWith((clock) =>
      clock.currentTimeMillis.pipe(
        Effect.map((at): Heartbeat => ({ _tag: "Heartbeat", at })),
      ),
    ),
    Schedule.spaced(Duration.millis(intervalMs)),
  )
}

/**
 * Client-side liveness watchdog timeout — surfaced once the idle
 * threshold elapses post-first-heartbeat without a fresh sentinel.
 *
 * Classified retryable by `@rxweave/store-cloud`'s `isRetryable` so
 * the subscribe-stream retry policy can reconnect from the last
 * delivered cursor. Re-exported from `@rxweave/store-cloud` for
 * backward compat with consumers that imported it pre-v0.5.2.
 */
export class WatchdogTimeout extends Schema.TaggedError<WatchdogTimeout>()(
  "WatchdogTimeout",
  { idleMs: Schema.Number },
) {}

/**
 * Type-guard predicate: is the given item a `Heartbeat` sentinel?
 *
 * Exposed so callers building their own subscribe-decode pipelines
 * (e.g., `@rxweave/store-cloud` when not opting into the watchdog)
 * can drop heartbeats without re-implementing the structural check.
 * `heartbeatGuard` uses this same predicate internally.
 */
export const isHeartbeat = Schema.is(Heartbeat)

/**
 * Client-side stream combinator: filter `Heartbeat` sentinels out
 * of the source stream and fail the merged result with
 * `WatchdogTimeout` if no `Heartbeat` arrives within
 * `clampIntervalMs(intervalMs) * 3` ms after the first one is
 * observed.
 *
 * **Intended for live/infinite source streams.** The internal
 * watchdog is a never-emitting stream merged with the source; with
 * `Stream.merge` default semantics this will block completion of
 * finite sources. For batch / one-shot streams, run the underlying
 * subscription directly without the guard.
 *
 * The watchdog `Ref` (`lastHeartbeatAt`) is per-invocation and
 * lives inside the combinator's scope — no caller orchestration
 * required, no risk of cross-subscriber state sharing.
 */
export const heartbeatGuard =
  (intervalMs: number) =>
  <A, E, R>(
    stream: Stream.Stream<A | Heartbeat, E, R>,
  ): Stream.Stream<A, E | WatchdogTimeout, R> =>
    Stream.unwrapScoped(
      Effect.gen(function* () {
        // `undefined` until the first heartbeat arrives. The
        // watchdog only fires once this transitions to a number, so
        // old servers that ignore the heartbeat field never trigger
        // a false-fire.
        const lastHeartbeatAt = yield* Ref.make<number | undefined>(undefined)

        const armOnHeartbeat = (item: A | Heartbeat): Effect.Effect<void> =>
          isHeartbeat(item)
            ? Clock.currentTimeMillis.pipe(
                Effect.flatMap((now) => Ref.set(lastHeartbeatAt, now)),
              )
            : Effect.void

        // Clamp here matches the server's clamp policy — a client
        // requesting a sub-minimum interval still uses a threshold
        // the server can realistically meet (pre-v0.5.2 bug fix).
        const idleThreshold =
          clampIntervalMs(intervalMs) * IDLE_THRESHOLD_MULTIPLIER

        // Single watchdog tick: read the Ref, compare against the
        // current clock, fail if the post-arming gap exceeds the
        // threshold.
        const checkOnce: Effect.Effect<void, WatchdogTimeout> =
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              Ref.get(lastHeartbeatAt).pipe(
                Effect.flatMap((at) =>
                  at !== undefined && now - at > idleThreshold
                    ? Effect.fail(new WatchdogTimeout({ idleMs: now - at }))
                    : Effect.void,
                ),
              ),
            ),
          )

        // `Effect.repeat(_, Schedule.spaced(1s))` runs `checkOnce`
        // on an infinite 1Hz schedule and only stops when the
        // effect fails. `Effect.flatMap(() => Effect.never)` after
        // the repeat keeps the success channel as `never` — it is
        // never reached. `Stream.fromEffect` wraps the result so
        // the stream emits zero items and only fails when the
        // watchdog fires.
        const watchdogStream: Stream.Stream<never, WatchdogTimeout, never> =
          Stream.fromEffect(
            Effect.repeat(checkOnce, Schedule.spaced(Duration.seconds(1))).pipe(
              Effect.flatMap(
                () => Effect.never as Effect.Effect<never, WatchdogTimeout>,
              ),
            ),
          )

        const envelopes: Stream.Stream<A, E, R> = stream.pipe(
          Stream.tap(armOnHeartbeat),
          // Filter heartbeats out of the user-facing stream. The
          // `isHeartbeat` type guard narrows `item` to the non-
          // heartbeat branch on the else side.
          Stream.flatMap((item) =>
            isHeartbeat(item) ? Stream.empty : Stream.make(item),
          ),
        )

        return Stream.merge(envelopes, watchdogStream) as Stream.Stream<
          A,
          E | WatchdogTimeout,
          R
        >
      }),
    )
