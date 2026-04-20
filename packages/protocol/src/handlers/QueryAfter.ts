import { Effect } from "effect"
import { EventStore } from "@rxweave/core"
import type { EventEnvelope, EventId, Filter } from "@rxweave/schema"
import { QueryWireError } from "../Errors.js"

/**
 * Pure-Effect `QueryAfter` handler shared by Cloud (convex) and
 * `@rxweave/server`.
 *
 * Delegates to `EventStore.queryAfter` (the exclusive-cursor pagination
 * primitive — see `EventStore.queryAfter` jsdoc), mapping `QueryError`
 * to `QueryWireError`. Matches the cloud handler contract in
 * `cloud/packages/backend/convex/rxweaveRpc.ts`.
 *
 * `filter` is optional on the wire; default to an empty filter when
 * omitted, mirroring `queryHandler`'s treatment.
 */
export const queryAfterHandler = (args: {
  readonly cursor: EventId
  readonly filter?: Filter
  readonly limit: number
}): Effect.Effect<ReadonlyArray<EventEnvelope>, QueryWireError, EventStore> =>
  EventStore.pipe(
    Effect.flatMap((store) => {
      const filter = args.filter ?? {}
      return store
        .queryAfter(args.cursor, filter, args.limit)
        .pipe(Effect.mapError((e) => new QueryWireError({ reason: e.reason })))
    }),
  )
