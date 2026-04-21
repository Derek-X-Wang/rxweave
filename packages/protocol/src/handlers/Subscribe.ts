import { Effect, Stream } from "effect"
import { EventStore } from "@rxweave/core"
import type { Cursor, EventEnvelope, Filter } from "@rxweave/schema"
import { SubscribeWireError } from "../Errors.js"

/**
 * Pure-Effect subscribe handler shared by Cloud and `@rxweave/server`.
 *
 * Delegates to the underlying `EventStore.subscribe` — whatever cursor
 * semantics + filter pushdown the store implements flow through
 * unchanged. The Convex-backed Subscribe handler in
 * `cloud/packages/backend/convex/rxweaveRpc.ts` is a polling-loop
 * specialisation that predates the `EventStore.subscribe` stream
 * primitive; both map their source error channel to
 * `SubscribeWireError.reason`.
 *
 * NOTE: `SubscribeWireError` carries an optional `lagged` flag as part
 * of the wire contract (the cloud retry policy in
 * `@rxweave/store-cloud` reads it to decide whether to reconnect). Core
 * `SubscribeError` has no such field today, so nothing to pass through
 * — the wire-level `lagged` channel stays reserved for future store
 * implementations that signal lagged subscribers explicitly.
 */
export const subscribeHandler = (args: {
  readonly cursor: Cursor
  readonly filter?: Filter
}): Stream.Stream<EventEnvelope, SubscribeWireError, EventStore> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const store = yield* EventStore
      return store
        .subscribe(
          args.filter === undefined
            ? { cursor: args.cursor }
            : { cursor: args.cursor, filter: args.filter },
        )
        .pipe(
          Stream.mapError(
            (e) => new SubscribeWireError({ reason: e.reason }),
          ),
        )
    }),
  )
