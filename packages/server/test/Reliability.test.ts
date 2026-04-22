import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Chunk, Effect, Layer, Schema, Stream } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventStore } from "@rxweave/core"
import { EventRegistry, defineEvent } from "@rxweave/schema"
import { MemoryStore } from "@rxweave/store-memory"
import { FileStore } from "@rxweave/store-file"
import { startServer } from "../src/Server.js"
import { testClientLayer } from "./support.js"

// Spec §11 reliability gates: client-crash + resume, server-restart
// recovery. `bun:test` — `startServer` needs `Bun.serve`.

const Ping = defineEvent(
  "test.reliability",
  Schema.Struct({ n: Schema.Number }),
)
const ping = (n: number) => ({
  type: Ping.type,
  payload: { n },
})

describe("reliability — client crash + resume", () => {
  it("delivers strictly-after-cursor events on reconnect", async () => {
    await Effect.scoped(
      Effect.gen(function* () {
        const serverStore = yield* EventStore
        const serverReg = yield* EventRegistry
        yield* serverReg.register(Ping)

        const handle = yield* startServer({
          store: Layer.succeed(EventStore, serverStore),
          registry: Layer.succeed(EventRegistry, serverReg),
          port: 0,
          host: "127.0.0.1",
        })

        // Client A: emits 3 events, snapshots its latestCursor, then
        // its scope closes (simulated crash — the managed runtime
        // teardown matches what a SIGKILL'd client leaves behind).
        const phase1 = yield* Effect.scoped(
          Effect.gen(function* () {
            const clientReg = yield* EventRegistry
            yield* clientReg.register(Ping)
            const clientStore = yield* EventStore
            yield* clientStore.append([ping(1), ping(2), ping(3)])
            return { savedCursor: yield* clientStore.latestCursor }
          }).pipe(Effect.provide(testClientLayer(handle.port))),
        )
        expect(phase1.savedCursor).not.toBe("earliest")

        // Interim appends — these are what client B must receive.
        const interim = yield* serverStore.append([ping(4), ping(5)])

        // Client B: subscribes from the saved cursor and takes exactly
        // 2 events. `Stream.take(2)` terminates the stream as soon as
        // the second event arrives, so the whole assertion resolves
        // deterministically without an explicit fiber/timeout dance.
        const collected = yield* Effect.gen(function* () {
          const clientReg = yield* EventRegistry
          yield* clientReg.register(Ping)
          const clientStore = yield* EventStore
          return yield* clientStore
            .subscribe({ cursor: phase1.savedCursor })
            .pipe(Stream.take(2), Stream.runCollect)
        }).pipe(Effect.provide(testClientLayer(handle.port)))

        const payloads = Array.from(
          Chunk.toReadonlyArray(collected),
          (e) => (e.payload as { n: number }).n,
        )
        expect(payloads).toEqual([4, 5])
        expect(interim[0]!.payload).toEqual({ n: 4 })
        expect(interim[1]!.payload).toEqual({ n: 5 })
      }),
    ).pipe(
      Effect.provide(Layer.mergeAll(MemoryStore.Live, EventRegistry.Live)),
      Effect.runPromise,
    )
  }, 10_000)
})

describe("reliability — server restart recovery", () => {
  let tmpDir: string
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rxweave-reliability-"))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("replays the same event set from a fresh server on the same .jsonl", async () => {
    const storePath = join(tmpDir, "stream.jsonl")
    const FileStoreLive = FileStore.Live({ path: storePath }).pipe(Layer.orDie)

    // Boot N: spin up server + client, run `body`, tear down. Returned
    // Effect is scoped so the Bun listener AND FileStore writer close
    // before the caller moves on — critical for boot-1 → boot-2
    // ordering, otherwise boot-2's scan-on-recover may see a
    // half-flushed tail.
    const boot = <A>(
      body: (store: EventStore["Type"]) => Effect.Effect<
        A,
        unknown,
        EventStore | EventRegistry
      >,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* EventStore
          const reg = yield* EventRegistry
          yield* reg.register(Ping)
          const handle = yield* startServer({
            store: Layer.succeed(EventStore, store),
            registry: Layer.succeed(EventRegistry, reg),
            port: 0,
            host: "127.0.0.1",
          })
          return yield* Effect.gen(function* () {
            const clientReg = yield* EventRegistry
            yield* clientReg.register(Ping)
            const clientStore = yield* EventStore
            return yield* body(clientStore)
          }).pipe(Effect.provide(testClientLayer(handle.port)))
        }),
      ).pipe(
        Effect.provide(Layer.mergeAll(FileStoreLive, EventRegistry.Live)),
        Effect.runPromise,
      )

    const appended = await boot((store) =>
      store.append([ping(1), ping(2), ping(3)]),
    )
    const ids1 = appended.map((e) => e.id)
    expect(ids1.length).toBe(3)

    // Fresh server instance (new port, new scope) on the same path.
    // Proves FileStore's scan-on-recover parses the append-only log
    // faithfully across a process boundary.
    const queried = await boot((store) => store.query({}, ids1.length))
    expect(queried.length).toBe(3)
    expect(queried.map((e) => e.id)).toEqual(ids1)
    expect(queried.map((e) => (e.payload as { n: number }).n)).toEqual([
      1, 2, 3,
    ])
  }, 15_000)
})
