import { Duration, Effect, Layer, Ref, Schedule } from "effect"
import { EventRegistry } from "@rxweave/schema"
import { CloudStore } from "@rxweave/store-cloud"

/** Client layer for an embedded no-auth server. */
export const testClientLayer = (port: number) =>
  CloudStore.Live({
    url: `http://127.0.0.1:${port}/rxweave/rpc`,
  }).pipe(Layer.provideMerge(EventRegistry.Live))

/** Poll `ref` until predicate holds; fails after ~3s. */
export const waitUntil = <A>(
  ref: Ref.Ref<A>,
  predicate: (value: A) => boolean,
) =>
  Ref.get(ref).pipe(
    Effect.flatMap((v) =>
      predicate(v) ? Effect.succeed(v) : Effect.fail("not-yet" as const),
    ),
    Effect.retry(
      Schedule.spaced(Duration.millis(10)).pipe(
        Schedule.upTo(Duration.millis(3000)),
      ),
    ),
  )
