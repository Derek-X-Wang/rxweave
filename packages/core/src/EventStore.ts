import { Context, Effect, Stream } from "effect"
import type {
  Cursor,
  EventEnvelope,
  EventId,
  EventInput,
  Filter,
} from "@rxweave/schema"
import type {
  AppendError,
  NotFound,
  QueryError,
  SubscribeError,
} from "./StoreErrors.js"

export interface EventStoreShape {
  readonly append: (
    events: ReadonlyArray<EventInput>,
  ) => Effect.Effect<ReadonlyArray<EventEnvelope>, AppendError>
  readonly subscribe: (opts: {
    readonly cursor: Cursor
    readonly filter?: Filter
  }) => Stream.Stream<EventEnvelope, SubscribeError>
  readonly getById: (id: EventId) => Effect.Effect<EventEnvelope, NotFound>
  readonly query: (
    filter: Filter,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<EventEnvelope>, QueryError>
  readonly latestCursor: Effect.Effect<Cursor>
}

export class EventStore extends Context.Tag("rxweave/EventStore")<
  EventStore,
  EventStoreShape
>() {}
