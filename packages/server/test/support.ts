import { FetchHttpClient } from "@effect/platform"
import { Effect, Layer, Ref, Schedule } from "effect"
import { EventRegistry } from "@rxweave/schema"
import { CloudStore } from "@rxweave/store-cloud"

/**
 * Client layer pointed at an embedded server instance. Four test
 * sites (SubscribeLive, Reliability×3) built this block inline; the
 * shape is identical every time — a CloudStore with a fresh
 * EventRegistry and FetchHttpClient, no token (embedded no-auth
 * mode).
 */
export const testClientLayer = (port: number) =>
  CloudStore.Live({
    url: `http://127.0.0.1:${port}/rxweave/rpc`,
  }).pipe(
    Layer.provideMerge(EventRegistry.Live),
    Layer.provide(FetchHttpClient.layer),
  )

/**
 * Poll `ref` until the predicate passes or the timeout elapses.
 * Replaces fixed-duration `Effect.sleep` sync points in tests —
 * deterministic green-path (fires as soon as the condition holds)
 * and loud red-path (times out with a visible cause instead of a
 * silent length-mismatch assertion).
 */
export const waitUntil = <A>(
  ref: Ref.Ref<A>,
  predicate: (value: A) => boolean,
  opts?: { readonly timeoutMs?: number; readonly pollMs?: number },
) =>
  Ref.get(ref).pipe(
    Effect.flatMap((v) =>
      predicate(v) ? Effect.succeed(v) : Effect.fail("not-yet" as const),
    ),
    Effect.retry(
      Schedule.spaced(`${opts?.pollMs ?? 20} millis`).pipe(
        Schedule.upTo(`${opts?.timeoutMs ?? 3000} millis`),
      ),
    ),
  )
