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
  /**
   * Exclusive-cursor pagination primitive.
   *
   * Returns up to `limit` events strictly after `cursor` (cursor itself is
   * never included), respecting `filter`. Semantics:
   *   - `cursor === "earliest"` behaves like "from the beginning" — the same
   *     window `query(filter, limit)` would return.
   *   - `cursor === "latest"` returns `[]` (nothing is strictly after the
   *     most recent event).
   *   - otherwise (branded `EventId`): returns events whose id is `>` cursor
   *     in lexicographic / ULID time order.
   *
   * This is the index-scoped pagination method backends should implement
   * against a `.gt("eventId", cursor)` predicate (or the in-memory
   * equivalent). The point is to push the cursor through to the underlying
   * index instead of scanning from the beginning every page, which is what
   * silently stalled a subscriber whose cursor lived past page 1.
   */
  readonly queryAfter: (
    cursor: Cursor,
    filter: Filter,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<EventEnvelope>, QueryError>
  readonly latestCursor: Effect.Effect<Cursor>
}

export class EventStore extends Context.Tag("rxweave/EventStore")<
  EventStore,
  EventStoreShape
>() {}
