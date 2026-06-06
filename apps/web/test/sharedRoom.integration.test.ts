/**
 * Shared-room integration test — two-subscriber round-trip.
 *
 * Exercises the full hash→token→CloudStore append/subscribe round-trip
 * against an in-process @rxweave/server backed by MemoryStore. Two
 * CloudStore instances subscribe before an append; both must see the
 * appended event, proving the shared-room model works.
 *
 * This test runs under `bun test` (not vitest) because @rxweave/server
 * uses BunHttpServer.layer which calls Bun.serve at runtime — a Bun-only
 * API. The vitest worker runs under Node where Bun is undefined.
 *
 * Two-tab visual check: for the human proof, see the "Shared Room — local
 * two-tab check" section in apps/web/README.md.
 */

import { test, expect } from "bun:test"
import { Chunk, Context, Effect, Fiber, Layer, Stream } from "effect"
import { EventRegistry, defineEvent } from "@rxweave/schema"
import { EventStore } from "@rxweave/core"
import { MemoryStore } from "@rxweave/store-memory"
import { CloudStore } from "@rxweave/store-cloud"
import { startServer } from "@rxweave/server"
import { Schema } from "effect"
import { resolveRoomConfig } from "../src/roomToken.js"

const BEARER_TOKEN = "rxk_integration_test_token"

const PingEvent = defineEvent("shared.ping", Schema.Struct({ seq: Schema.Number }))

test("two CloudStore subscribers both receive one append", async () => {
  await Effect.scoped(
    Effect.gen(function* () {
      // Build a shared server-side EventRegistry so all three CloudStore
      // instances agree on the schema digest. We pre-register PingEvent
      // here before starting the server so the first append passes the
      // digest gate without a separate RegistryPush round-trip.
      const serverRegLayer = EventRegistry.Live
      const serverRegCtx = yield* Layer.build(serverRegLayer)
      const serverReg = Context.get(serverRegCtx, EventRegistry)
      yield* serverReg.register(PingEvent as never)

      // Start in-process server: MemoryStore + shared registry + bearer auth.
      const handle = yield* startServer({
        store: MemoryStore.Live,
        registry: Layer.succeedContext(serverRegCtx),
        port: 0,
        host: "127.0.0.1",
        auth: { bearer: [BEARER_TOKEN] },
      })
      const url = `http://127.0.0.1:${handle.port}/rxweave/rpc/`

      // Build three independent CloudStore client contexts (simulating
      // separate browser tabs / processes). Each gets its own in-memory
      // EventRegistry pre-loaded with PingEvent.
      const makeClientLayer = () =>
        CloudStore.Live({
          url,
          token: () => BEARER_TOKEN,
          heartbeat: { intervalMs: 1000 },
        }).pipe(Layer.provideMerge(EventRegistry.Live))

      const ctxA = yield* Layer.build(makeClientLayer())
      const ctxB = yield* Layer.build(makeClientLayer())
      const ctxAppend = yield* Layer.build(makeClientLayer())

      // Register PingEvent on each client registry.
      yield* Context.get(ctxA, EventRegistry).register(PingEvent as never)
      yield* Context.get(ctxB, EventRegistry).register(PingEvent as never)
      yield* Context.get(ctxAppend, EventRegistry).register(PingEvent as never)

      const storeA = Context.get(ctxA, EventStore)
      const storeB = Context.get(ctxB, EventStore)
      const storeApp = Context.get(ctxAppend, EventStore)

      // Subscribe on both stores — take just 1 event each.
      const fiberA = yield* Effect.fork(
        Stream.runCollect(storeA.subscribe({ cursor: "earliest" }).pipe(Stream.take(1))),
      )
      const fiberB = yield* Effect.fork(
        Stream.runCollect(storeB.subscribe({ cursor: "earliest" }).pipe(Stream.take(1))),
      )

      // Small delay to let subscribe streams open and poll before append.
      yield* Effect.sleep("300 millis")

      // Append one ping event via the appender store.
      yield* storeApp.append([
        {
          type: PingEvent.type,
          actor: "test-agent" as never,
          source: "system" as never,
          payload: { seq: 1 },
        },
      ])

      // Both subscribers must receive the ping event (within the test timeout).
      const resultA = yield* Fiber.join(fiberA)
      const resultB = yield* Fiber.join(fiberB)

      const eventsA = Chunk.toArray(resultA)
      const eventsB = Chunk.toArray(resultB)

      expect(eventsA.length).toBe(1)
      expect(eventsB.length).toBe(1)
      expect(eventsA[0]!.type).toBe(PingEvent.type)
      expect(eventsB[0]!.type).toBe(PingEvent.type)
      // Both subscribers see the same event id — same shared stream.
      expect(eventsA[0]!.id).toBe(eventsB[0]!.id)
    }),
  ).pipe(Effect.runPromise)
}, 15_000)

test("resolveRoomConfig: hash token is used over env token in the bridge", () => {
  const config = resolveRoomConfig("#room=hash-tok", "env-tok", undefined, "http://localhost:5173")
  expect(config.token).toBe("hash-tok")
  expect(config.fromHash).toBe(true)
})
