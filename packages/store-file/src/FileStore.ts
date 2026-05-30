import {
  Clock,
  Duration,
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
import * as Path from "node:path"
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
        const dir = Path.dirname(opts.path)
        if (dir && dir !== ".") {
          yield* fs.makeDirectory(dir, { recursive: true })
        }
        const exists = yield* fs.exists(opts.path)
        if (!exists) yield* fs.writeFile(opts.path, new Uint8Array())

        const recovered = yield* scanAndRecover(opts.path)
        const store = yield* Ref.make<ReadonlyArray<EventEnvelope>>(recovered.events)
        const writer = yield* makeWriter(opts.path)
        const pubsub = yield* PubSub.sliding<EventEnvelope>(1024)
        const lock = yield* Effect.makeSemaphore(1)
        const ulid = yield* Ulid

        if (recovered.truncatedBytes > 0) {
          yield* writer.truncate(recovered.validBytes)
        }

        // Track how many bytes have been read so far for file-tail polling.
        // Starts at `recovered.validBytes` so the next poll only reads new data.
        const readBytes = yield* Ref.make(recovered.validBytes)

        // Background fiber: poll the file every 200 ms for new lines written
        // by other processes. This enables cross-process event visibility —
        // `rxweave emit` in one shell triggers agents supervised by `rxweave dev`
        // in another. The fiber runs for the lifetime of the store's scope.
        const tailFiber = yield* Effect.forkScoped(
          Effect.forever(
            Effect.sleep(Duration.millis(200)).pipe(
              Effect.zipRight(
                Effect.gen(function* () {
                  const raw = yield* fs.readFile(opts.path)
                  const known = yield* Ref.get(readBytes)
                  if (raw.length <= known) return
                  const newBytes = raw.slice(known)
                  const text = new TextDecoder().decode(newBytes)
                  const lines = text.split("\n").filter((l) => l.length > 0)
                  const newEnvelopes: Array<EventEnvelope> = []
                  let consumed = known
                  for (const line of lines) {
                    const attempt = yield* Effect.either(
                      Effect.try(() =>
                        Schema.decodeUnknownSync(Schema.parseJson(EventEnvelope))(line),
                      ),
                    )
                    if (attempt._tag === "Right") {
                      newEnvelopes.push(attempt.right)
                      consumed += new TextEncoder().encode(line).length + 1
                    }
                  }
                  if (newEnvelopes.length === 0) return
                  yield* lock.withPermits(1)(
                    Effect.gen(function* () {
                      // Only ingest events not already in our in-memory store
                      // (guards against double-counting events this process appended).
                      const current = yield* Ref.get(store)
                      const currentIds = new Set(current.map((e) => e.id))
                      const fresh = newEnvelopes.filter((e) => !currentIds.has(e.id))
                      if (fresh.length === 0) return
                      yield* Ref.update(store, (arr) => [...arr, ...fresh])
                      for (const env of fresh) yield* pubsub.publish(env)
                      yield* Ref.set(readBytes, consumed)
                    }),
                  )
                }).pipe(Effect.catchAll(() => Effect.void)),
              ),
            ),
          ).pipe(Effect.catchAll(() => Effect.void)),
        )
        void tailFiber

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
                  causedBy: input.causedBy,
                  payload: input.payload,
                })
                envelopes.push(envelope)
              }
              const lines = envelopes.map((e) => encode(e))
              yield* writer.appendLines(lines)
              const appendedBytes = lines.reduce(
                (sum, l) => sum + new TextEncoder().encode(l).length + 1,
                0,
              )
              yield* lock.withPermits(1)(
                Effect.gen(function* () {
                  yield* Ref.update(store, (arr) => [...arr, ...envelopes])
                  for (const env of envelopes) yield* pubsub.publish(env)
                  // Advance readBytes so the tail fiber skips these lines.
                  yield* Ref.update(readBytes, (n) => n + appendedBytes)
                }),
              )
              return envelopes as ReadonlyArray<EventEnvelope>
            }).pipe(
              Effect.mapError(
                (cause) => new AppendError({ reason: "file-append", cause }),
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
            Effect.map(
              (arr): Cursor => (arr.length ? arr[arr.length - 1]!.id : "earliest"),
            ),
          ),
        })
      }),
    ).pipe(Layer.provide(Ulid.Live), Layer.provide(BunFileSystem.layer)),
}
