import { Effect } from "effect"
import { EventStore } from "@rxweave/core"
import type { EventEnvelope, EventId, Filter } from "@rxweave/schema"
import { QueryWireError } from "../Errors.js"

/**
 * Pure-Effect `QueryAfter` handler — matches the `RxWeaveRpc.QueryAfter`
 * wire contract (`filter` is required). Delegates to
 * `EventStore.queryAfter` (the exclusive-cursor pagination primitive),
 * mapping `QueryError` to `QueryWireError`.
 */
export const queryAfterHandler = (args: {
  readonly cursor: EventId
  readonly filter: Filter
  readonly limit: number
}): Effect.Effect<ReadonlyArray<EventEnvelope>, QueryWireError, EventStore> =>
  EventStore.pipe(
    Effect.flatMap((store) =>
      store
        .queryAfter(args.cursor, args.filter, args.limit)
        .pipe(Effect.mapError((e) => new QueryWireError({ reason: e.reason }))),
    ),
  )
