import {
  Chunk,
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

const TAIL_POLL_INTERVAL = Duration.millis(200)

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

        // Background fiber: poll the file every TAIL_POLL_INTERVAL for new
        // lines written by other processes. This enables cross-process event
        // visibility — `rxweave emit` in one shell triggers agents supervised
        // by `rxweave dev` in another. The fiber runs for the lifetime of the
        // store's scope.
        //
        // Performance: we stat first and early-return (no read) when the file
        // hasn't grown. When it has, we read only [readBytes, fileSize) via
        // fs.stream offset+bytesToRead — O(new bytes), not O(file size).
        //
        // Partial-line safety: the new bytes may end mid-line if another
        // process is mid-write. We only consume complete newline-terminated
        // lines. Any partial trailing bytes are left for the next poll by
        // advancing readBytes only by the byte-length of consumed complete
        // lines (including their trailing '\n').
        const tailFiber = yield* Effect.forkScoped(
          Effect.forever(
            Effect.sleep(TAIL_POLL_INTERVAL).pipe(
              Effect.zipRight(
                Effect.gen(function* () {
                  const known = yield* Ref.get(readBytes)

                  // Stat-only fast path: skip the read entirely when the file
                  // hasn't grown. Size is a bigint-branded Size type; coerce
                  // to number for comparison with the JS-number `known`.
                  const info = yield* fs.stat(opts.path)
                  const fileSize = Number(info.size)
                  if (fileSize <= known) return

                  // Read only the new tail bytes [known, fileSize).
                  const newByteCount = fileSize - known
                  const chunks = yield* Stream.runCollect(
                    fs.stream(opts.path, {
                      offset: known,
                      bytesToRead: newByteCount,
                    }),
                  )
                  // Concatenate Uint8Array chunks into one buffer.
                  const chunkArray = Chunk.toReadonlyArray(chunks)
                  const totalLen = chunkArray.reduce((s, c) => s + c.length, 0)
                  const newBytes = new Uint8Array(totalLen)
                  let pos = 0
                  for (const c of chunkArray) {
                    newBytes.set(c, pos)
                    pos += c.length
                  }

                  // Only consume complete newline-terminated lines.
                  // If the tail ends with a partial line, leave those bytes
                  // for the next poll by not advancing readBytes past them.
                  //
                  // text.split("\n") always produces at least one segment.
                  // - If newBytes ends with '\n': the last segment is "" (empty,
                  //   from the trailing newline) — drop it; all preceding
                  //   segments are complete lines.
                  // - If newBytes does NOT end with '\n': the last segment is a
                  //   partial line — drop it too; we'll pick it up next poll
                  //   once the writer has finished it.
                  // In both cases: slice off the last segment.
                  const text = new TextDecoder().decode(newBytes)
                  const completeLines = text.split("\n").slice(0, -1)

                  const newEnvelopes: Array<EventEnvelope> = []
                  let consumed = 0
                  for (const line of completeLines) {
                    const lineBytes = new TextEncoder().encode(line).length
                    const attempt = yield* Effect.either(
                      Effect.try(() =>
                        Schema.decodeUnknownSync(Schema.parseJson(EventEnvelope))(line),
                      ),
                    )
                    if (attempt._tag === "Right") {
                      newEnvelopes.push(attempt.right)
                    }
                    // Always advance past complete lines (valid or corrupt)
                    // so corrupt lines don't block future tail reads.
                    consumed += lineBytes + 1 // +1 for the '\n'
                  }

                  if (newEnvelopes.length === 0 && consumed === 0) return
                  yield* lock.withPermits(1)(
                    Effect.gen(function* () {
                      // Only ingest events not already in our in-memory store
                      // (guards against double-counting events this process appended).
                      if (newEnvelopes.length > 0) {
                        const current = yield* Ref.get(store)
                        const currentIds = new Set(current.map((e) => e.id))
                        const fresh = newEnvelopes.filter((e) => !currentIds.has(e.id))
                        if (fresh.length > 0) {
                          yield* Ref.update(store, (arr) => [...arr, ...fresh])
                          for (const env of fresh) yield* pubsub.publish(env)
                        }
                      }
                      // Advance readBytes by exactly the complete-line bytes consumed,
                      // leaving any partial trailing line for the next poll.
                      yield* Ref.update(readBytes, (n) => n + consumed)
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
