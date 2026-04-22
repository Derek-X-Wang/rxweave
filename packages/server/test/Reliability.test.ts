import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { FetchHttpClient } from "@effect/platform"
import { Effect, Fiber, Layer, Ref, Schema, Stream } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventStore } from "@rxweave/core"
import { EventRegistry, defineEvent } from "@rxweave/schema"
import { MemoryStore } from "@rxweave/store-memory"
import { FileStore } from "@rxweave/store-file"
import { CloudStore } from "@rxweave/store-cloud"
import { startServer } from "../src/Server.js"

/**
 * Spec §11 reliability gates. Two scenarios:
 *
 *   1. Client crash + resume: first client emits N events, snapshots
 *      the cursor, "crashes" (tears down its managed runtime). A
 *      second client connects with `--from-cursor <snapshot>` after
 *      additional events landed in between, and receives EXACTLY the
 *      new events — no gaps, no duplicates, no dropped first-event
 *      off-by-one.
 *
 *   2. Server restart with same on-disk log: FileStore server takes N
 *      events, the server's scope closes, a fresh server boots against
 *      the same `.jsonl` path, query returns the same N events in the
 *      same order.
 *
 * Runner: `bun:test`. `startServer` needs `Bun.serve`, which vitest
 * under Node doesn't have.
 */

const Ping = defineEvent(
  "test.reliability",
  Schema.Struct({ n: Schema.Number }),
)

describe("reliability — client crash + resume", () => {
  it("resumes from saved cursor with no gaps or duplicates", async () => {
    await Effect.scoped(
      Effect.gen(function* () {
        // Shared server-side EventStore + EventRegistry instances so
        // direct appends in the test body and the RPC handlers
        // mounted by startServer both hit the same singletons.
        const serverStore = yield* EventStore
        const serverReg = yield* EventRegistry
        yield* serverReg.register(Ping)

        const handle = yield* startServer({
          store: Layer.succeed(EventStore, serverStore),
          registry: Layer.succeed(EventRegistry, serverReg),
          port: 0,
          host: "127.0.0.1",
        })

        const clientLayer = (scopeTag: string) =>
          CloudStore.Live({
            url: `http://127.0.0.1:${handle.port}/rxweave/rpc`,
          }).pipe(
            Layer.provideMerge(EventRegistry.Live),
            Layer.provide(FetchHttpClient.layer),
            // Scope tag only surfaces in Effect spans — makes test
            // traces distinguishable when debugging.
            Layer.annotateLogs("client", scopeTag),
          )

        // Client A: emits 3 events, reads latestCursor, disconnects.
        const phase1 = yield* Effect.scoped(
          Effect.gen(function* () {
            const clientReg = yield* EventRegistry
            yield* clientReg.register(Ping)
            const clientStore = yield* EventStore
            yield* clientStore.append([
              {
                type: Ping.type,
                actor: "cli" as never,
                source: "cli" as never,
                payload: { n: 1 },
              },
              {
                type: Ping.type,
                actor: "cli" as never,
                source: "cli" as never,
                payload: { n: 2 },
              },
              {
                type: Ping.type,
                actor: "cli" as never,
                source: "cli" as never,
                payload: { n: 3 },
              },
            ])
            const savedCursor = yield* clientStore.latestCursor
            return { savedCursor }
          }).pipe(Effect.provide(clientLayer("A"))),
        )
        expect(phase1.savedCursor).not.toBe("earliest")

        // Between A's crash and B's reconnect, more events land. These
        // are what B must receive — STRICTLY AFTER the saved cursor.
        const interimAppends = yield* serverStore.append([
          {
            type: Ping.type,
            actor: "cli" as never,
            source: "cli" as never,
            payload: { n: 4 },
          },
          {
            type: Ping.type,
            actor: "cli" as never,
            source: "cli" as never,
            payload: { n: 5 },
          },
        ])

        // Client B: subscribes --from-cursor <savedCursor>. Must
        // receive events 4, 5 — NOT 1, 2, 3 (those are before the
        // cursor) and NOT duplicates of either.
        const received = yield* Ref.make<Array<number>>([])
        const subFiber = yield* Effect.forkScoped(
          Effect.gen(function* () {
            const clientReg = yield* EventRegistry
            yield* clientReg.register(Ping)
            const clientStore = yield* EventStore
            yield* Stream.runForEach(
              clientStore.subscribe({ cursor: phase1.savedCursor }),
              (event) =>
                Effect.sync(() => {
                  const payload = event.payload as { n: number }
                  return Ref.update(received, (arr) => [...arr, payload.n])
                }).pipe(Effect.flatten),
            )
          }).pipe(Effect.provide(clientLayer("B"))),
        )

        yield* Effect.sleep("800 millis")
        const after = yield* Ref.get(received)
        expect(after).toEqual([4, 5])
        expect(interimAppends[0]!.payload).toEqual({ n: 4 })
        expect(interimAppends[1]!.payload).toEqual({ n: 5 })

        yield* Fiber.interrupt(subFiber)
      }),
    ).pipe(
      Effect.provide(Layer.mergeAll(MemoryStore.Live, EventRegistry.Live)),
      Effect.runPromise,
    )
  }, 10_000)
})

describe("reliability — server restart recovery", () => {
  // Each test case gets its own tempdir so concurrent runs can't share
  // a .jsonl file. rmSync with force: true tolerates the cleanup
  // racing a lingering handle on slow CI.
  let tmpDir: string
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rxweave-reliability-"))
  })
  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("replays the same event set from a fresh server on the same .jsonl", async () => {
    const storePath = join(tmpDir, "stream.jsonl")
    const FileStoreLive = FileStore.Live({ path: storePath }).pipe(Layer.orDie)

    // Boot 1: emit 3 events via a fresh server + client, then let the
    // scope close (which tears down the Bun listener AND the FileStore
    // writer — the .jsonl file must be flushed + closed before boot 2
    // opens it, otherwise the scan-on-recover sees a truncated tail).
    const ids1 = await Effect.scoped(
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
        const clientLayer = CloudStore.Live({
          url: `http://127.0.0.1:${handle.port}/rxweave/rpc`,
        }).pipe(
          Layer.provideMerge(EventRegistry.Live),
          Layer.provide(FetchHttpClient.layer),
        )
        const appended = yield* Effect.gen(function* () {
          const clientReg = yield* EventRegistry
          yield* clientReg.register(Ping)
          const clientStore = yield* EventStore
          return yield* clientStore.append([
            {
              type: Ping.type,
              actor: "cli" as never,
              source: "cli" as never,
              payload: { n: 1 },
            },
            {
              type: Ping.type,
              actor: "cli" as never,
              source: "cli" as never,
              payload: { n: 2 },
            },
            {
              type: Ping.type,
              actor: "cli" as never,
              source: "cli" as never,
              payload: { n: 3 },
            },
          ])
        }).pipe(Effect.provide(clientLayer))
        return appended.map((e) => e.id)
      }),
    ).pipe(
      Effect.provide(Layer.mergeAll(FileStoreLive, EventRegistry.Live)),
      Effect.runPromise,
    )
    expect(ids1.length).toBe(3)

    // Boot 2: brand-new server instance (fresh port, fresh scope) on
    // the same .jsonl. Query returns the same 3 events in the same
    // order — proves FileStore's scan-on-recover parses the append-
    // only log faithfully.
    const queried = await Effect.scoped(
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
        const clientLayer = CloudStore.Live({
          url: `http://127.0.0.1:${handle.port}/rxweave/rpc`,
        }).pipe(
          Layer.provideMerge(EventRegistry.Live),
          Layer.provide(FetchHttpClient.layer),
        )
        return yield* Effect.gen(function* () {
          const clientReg = yield* EventRegistry
          yield* clientReg.register(Ping)
          const clientStore = yield* EventStore
          return yield* clientStore.query({}, 100)
        }).pipe(Effect.provide(clientLayer))
      }),
    ).pipe(
      Effect.provide(Layer.mergeAll(FileStoreLive, EventRegistry.Live)),
      Effect.runPromise,
    )
    expect(queried.length).toBe(3)
    expect(queried.map((e) => e.id)).toEqual(ids1)
    expect(queried.map((e) => (e.payload as { n: number }).n)).toEqual([
      1, 2, 3,
    ])
  }, 15_000)
})
