import { Effect } from "effect"
import { EventStore } from "@rxweave/core"
import type { Cursor, EventEnvelope, Filter } from "@rxweave/schema"
import { QueryWireError } from "../Errors.js"

/**
 * Pure-Effect `QueryAfter` handler — matches the `RxWeaveRpc.QueryAfter`
 * wire contract. Delegates to `EventStore.queryAfter` (the
 * exclusive-cursor pagination primitive, which accepts the full
 * `Cursor = EventId | "earliest" | "latest"` range), mapping
 * `QueryError` to `QueryWireError`.
 */
export const queryAfterHandler = (args: {
  readonly cursor: Cursor
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
