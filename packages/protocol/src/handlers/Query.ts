import { Effect } from "effect"
import { EventStore } from "@rxweave/core"
import type { EventEnvelope, Filter } from "@rxweave/schema"
import { QueryWireError } from "../Errors.js"

/**
 * Pure-Effect `Query` handler — matches the `RxWeaveRpc.Query` wire
 * contract (`filter` is required). Delegates to `EventStore.query`,
 * mapping `QueryError` to `QueryWireError`.
 */
export const queryHandler = (args: {
  readonly filter: Filter
  readonly limit: number
}): Effect.Effect<ReadonlyArray<EventEnvelope>, QueryWireError, EventStore> =>
  EventStore.pipe(
    Effect.flatMap((store) =>
      store
        .query(args.filter, args.limit)
        .pipe(Effect.mapError((e) => new QueryWireError({ reason: e.reason }))),
    ),
  )
