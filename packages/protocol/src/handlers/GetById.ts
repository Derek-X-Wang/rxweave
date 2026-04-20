import { Effect } from "effect"
import { EventStore } from "@rxweave/core"
import type { EventEnvelope, EventId } from "@rxweave/schema"
import { NotFoundWireError } from "../Errors.js"

/**
 * Pure-Effect `GetById` handler shared by Cloud (convex) and
 * `@rxweave/server`.
 *
 * Delegates straight to `EventStore.getById`. Any `NotFound` from the
 * backing store is mapped to the wire-level `NotFoundWireError` with the
 * requested id echoed back — matching the cloud handler in
 * `cloud/packages/backend/convex/rxweaveRpc.ts`.
 */
export const getByIdHandler = (args: {
  readonly id: EventId
}): Effect.Effect<EventEnvelope, NotFoundWireError, EventStore> =>
  EventStore.pipe(
    Effect.flatMap((store) =>
      store.getById(args.id).pipe(
        Effect.mapError(() => new NotFoundWireError({ id: args.id })),
      ),
    ),
  )
