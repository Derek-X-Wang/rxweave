import {
  Effect,
  Layer,
  PubSub,
  Ref,
  Stream,
  Clock,
} from "effect"
import { minimatch } from "minimatch"
import {
  type Cursor,
  EventEnvelope,
  type Filter,
  Ulid,
} from "@rxweave/schema"
import {
  AppendError,
  EventStore,
  NotFound,
  SubscribeError,
} from "@rxweave/core"

const matchFilter = (filter: Filter | undefined) => (event: EventEnvelope): boolean => {
  if (!filter) return true
  if (filter.types && !filter.types.some((g) => minimatch(event.type, g))) return false
  if (filter.actors && !filter.actors.includes(event.actor)) return false
  if (filter.sources && !filter.sources.includes(event.source)) return false
  if (filter.since !== undefined && event.timestamp < filter.since) return false
  return true
}

export const MemoryStore = {
  Live: Layer.effect(
    EventStore,
    Effect.gen(function* () {
      const store = yield* Ref.make<ReadonlyArray<EventEnvelope>>([])
      const pubsub = yield* PubSub.sliding<EventEnvelope>(1024)
      const lock = yield* Effect.makeSemaphore(1)
      const ulid = yield* Ulid

      return EventStore.of({
        append: (events) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const envelopes: Array<EventEnvelope> = []
              for (const input of events) {
                const id = yield* ulid.next
                const timestamp = yield* Clock.currentTimeMillis
                const envelope = new EventEnvelope({
                  id,
                  type: input.type,
                  actor: input.actor ?? ("system" as never),
                  source: input.source ?? "cli",
                  timestamp,
                  causedBy: input.causedBy,
                  payload: input.payload,
                })
                envelopes.push(envelope)
              }
              yield* Ref.update(store, (arr) => [...arr, ...envelopes])
              for (const env of envelopes) {
                yield* pubsub.publish(env)
              }
              return envelopes as ReadonlyArray<EventEnvelope>
            }),
          ).pipe(
            Effect.mapError(
              (cause) => new AppendError({ reason: "memory-append", cause }),
            ),
          ),

        subscribe: ({ cursor, filter }) =>
          Stream.unwrapScoped(
            Effect.gen(function* () {
              const [snapshot, subscriber] = yield* lock.withPermits(1)(
                Effect.gen(function* () {
                  const arr = yield* Ref.get(store)
                  const sub = yield* pubsub.subscribe
                  return [arr, sub] as const
                }),
              )

              const snapshotMax = snapshot.at(-1)?.id
              const matches = matchFilter(filter)

              const replay =
                cursor === "latest"
                  ? Stream.empty
                  : Stream.fromIterable(
                      snapshot.filter((e) =>
                        cursor === "earliest"
                          ? matches(e)
                          : e.id > cursor && matches(e),
                      ),
                    )

              const live = Stream.fromQueue(subscriber).pipe(
                Stream.filter(
                  (e) =>
                    matches(e) &&
                    (!snapshotMax || e.id > snapshotMax),
                ),
              )

              return Stream.concat(replay, live)
            }),
          ).pipe(
            Stream.mapError(
              () => new SubscribeError({ reason: "memory-subscribe" }),
            ),
          ),

        getById: (id) =>
          Ref.get(store).pipe(
            Effect.flatMap((arr) => {
              const match = arr.find((e) => e.id === id)
              return match ? Effect.succeed(match) : Effect.fail(new NotFound({ id }))
            }),
          ),

        query: (filter, limit) =>
          Ref.get(store).pipe(
            Effect.map(
              (arr) => arr.filter(matchFilter(filter)).slice(0, limit),
            ),
          ),

        queryAfter: (cursor, filter, limit) =>
          Ref.get(store).pipe(
            Effect.map((arr) => {
              if (cursor === "latest") return [] as ReadonlyArray<EventEnvelope>
              const matches = matchFilter(filter)
              const afterCursor =
                cursor === "earliest" ? arr : arr.filter((e) => e.id > cursor)
              return afterCursor.filter(matches).slice(0, limit)
            }),
          ),

        latestCursor: Ref.get(store).pipe(
          Effect.map((arr): Cursor => (arr.length ? arr[arr.length - 1]!.id : "earliest")),
        ),
      })
    }),
  ).pipe(Layer.provide(Ulid.Live)),
}
