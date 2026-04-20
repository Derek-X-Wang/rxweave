import { Effect } from "effect"
import { EventStore } from "@rxweave/core"
import type { EventEnvelope, Filter } from "@rxweave/schema"
import { QueryWireError } from "../Errors.js"

/**
 * Pure-Effect `Query` handler shared by Cloud (convex) and
 * `@rxweave/server`.
 *
 * Delegates to `EventStore.query`, mapping `QueryError` to
 * `QueryWireError` — same wire contract as the cloud handler in
 * `cloud/packages/backend/convex/rxweaveRpc.ts`.
 *
 * `filter` is optional on the wire; default to an empty filter when
 * omitted. We conditionally pass it so TS `exactOptionalPropertyTypes`
 * never routes an explicit `undefined` down to the store.
 */
export const queryHandler = (args: {
  readonly filter?: Filter
  readonly limit: number
}): Effect.Effect<ReadonlyArray<EventEnvelope>, QueryWireError, EventStore> =>
  EventStore.pipe(
    Effect.flatMap((store) => {
      const filter = args.filter ?? {}
      return store
        .query(filter, args.limit)
        .pipe(Effect.mapError((e) => new QueryWireError({ reason: e.reason })))
    }),
  )
