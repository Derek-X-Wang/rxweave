import {
  Clock,
  Effect,
  Layer,
  PubSub,
  Ref,
  Stream,
} from "effect"
import { FileSystem } from "@effect/platform"
import { BunFileSystem } from "@effect/platform-bun"
import { minimatch } from "minimatch"
import { Schema } from "effect"
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
import { makeWriter } from "./Writer.js"
import { scanAndRecover } from "./Recovery.js"

const encode = Schema.encodeSync(Schema.parseJson(EventEnvelope))

const matchFilter = (filter: Filter | undefined) => (event: EventEnvelope): boolean => {
  if (!filter) return true
  if (filter.types && !filter.types.some((g) => minimatch(event.type, g))) return false
  if (filter.actors && !filter.actors.includes(event.actor)) return false
  if (filter.sources && !filter.sources.includes(event.source)) return false
  if (filter.since !== undefined && event.timestamp < filter.since) return false
  return true
}

export const FileStore = {
  Live: (opts: { readonly path: string }) =>
    Layer.scoped(
      EventStore,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(opts.path.replace(/\/[^/]+$/, ""), { recursive: true })
        const exists = yield* fs.exists(opts.path)
        if (!exists) yield* fs.writeFile(opts.path, new Uint8Array())

        const recovered = yield* scanAndRecover(opts.path)
        const store = yield* Ref.make<ReadonlyArray<EventEnvelope>>(recovered.events)
        const writer = yield* makeWriter(opts.path)
        const pubsub = yield* PubSub.sliding<EventEnvelope>(1024)
        const ulid = yield* Ulid

        if (recovered.truncatedBytes > 0) {
          yield* writer.truncate(recovered.validBytes)
        }

        return EventStore.of({
          append: (events) =>
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
                  payload: input.payload,
                })
                envelopes.push(envelope)
              }
              yield* writer.appendLines(envelopes.map((e) => encode(e)))
              yield* Ref.update(store, (arr) => [...arr, ...envelopes])
              for (const env of envelopes) yield* pubsub.publish(env)
              return envelopes as ReadonlyArray<EventEnvelope>
            }).pipe(
              Effect.mapError(
                (cause) => new AppendError({ reason: "file-append", cause }),
              ),
            ),

          subscribe: ({ cursor, filter }) =>
            Stream.unwrapScoped(
              Effect.gen(function* () {
                const snapshot = yield* Ref.get(store)
                const subscriber = yield* pubsub.subscribe
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
                      matches(e) && (!snapshotMax || e.id > snapshotMax),
                  ),
                )

                return Stream.concat(replay, live)
              }),
            ).pipe(
              Stream.mapError(() => new SubscribeError({ reason: "file-subscribe" })),
            ),

          getById: (id) =>
            Ref.get(store).pipe(
              Effect.flatMap((arr) => {
                const found = arr.find((e) => e.id === id)
                return found ? Effect.succeed(found) : Effect.fail(new NotFound({ id }))
              }),
            ),

          query: (filter, limit) =>
            Ref.get(store).pipe(
              Effect.map((arr) => arr.filter(matchFilter(filter)).slice(0, limit)),
            ),

          latestCursor: Ref.get(store).pipe(
            Effect.map(
              (arr): Cursor => (arr.length ? arr[arr.length - 1]!.id : "earliest"),
            ),
          ),
        })
      }),
    ).pipe(Layer.provide(Ulid.Live), Layer.provide(BunFileSystem.layer)),
}
