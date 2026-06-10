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
import { CloudStore, syncRegistry } from "@rxweave/store-cloud"
import { startServer } from "@rxweave/server"
import { Schema } from "effect"
import { resolveRoomConfig } from "../src/roomToken.js"
import { makeRegistryShim } from "../src/registryShim.js"

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

/**
 * Regression test for the registry-shim id format bug.
 *
 * The bridge's fetch-based RegistryRpcClient shim previously used non-numeric
 * ids ("rs-diff" / "rs-push") in its NDJSON request envelopes. @effect/rpc
 * decodes Request.id as a bigint (RequestId), so a real @rxweave/server throws
 * "Failed to parse String to BigInt" when it receives a non-numeric id, causing
 * the mount-time syncRegistry call to fail and both tabs to sit at "Waiting for
 * events… 0". Convex's hand-rolled bypass tolerated arbitrary string ids, which
 * masked the bug until the first live two-tab Chrome validation.
 *
 * This test exercises the shim's NDJSON envelope shape directly against a real
 * in-process @rxweave/server and asserts:
 *   - A shim with id "rs-diff" (non-numeric) → syncRegistry throws / rejects.
 *   - A shim with id "1" (numeric, the fix) → syncRegistry succeeds.
 *
 * The existing two-subscriber test above uses CloudStore's own @effect/rpc
 * client (which always uses numeric ids) — that's why it passed while the
 * bridge shim was broken. This test specifically targets the shim's envelope
 * path.
 */
test("registry shim: non-numeric rpc id rejects on real server (red→green regression)", async () => {
  await Effect.scoped(
    Effect.gen(function* () {
      // Start a server with an EMPTY registry (no pre-registered schemas).
      // This forces the shim to perform a real RegistrySyncDiff + RegistryPush
      // round-trip rather than getting an upToDate:true short-circuit.
      const handle = yield* startServer({
        store: MemoryStore.Live,
        port: 0,
        host: "127.0.0.1",
        auth: { bearer: [BEARER_TOKEN] },
      })
      const rpcUrl = `http://127.0.0.1:${handle.port}/rxweave/rpc/`
      const authHdr = { authorization: `Bearer ${BEARER_TOKEN}` }

      // Client registry with PingEvent pre-loaded so syncRegistry has
      // something to push when the server reports its registry is empty.
      const clientRegCtx = yield* Layer.build(EventRegistry.Live)
      const clientReg = Context.get(clientRegCtx, EventRegistry)
      yield* clientReg.register(PingEvent as never)

      // RED: shim using non-numeric id "rs-diff" — @effect/rpc's bigint
      // parse rejects it, syncRegistry must fail (Left).
      const brokenShim = {
        RegistrySyncDiff: ({ clientDigest }: { clientDigest: string }) =>
          Effect.tryPromise(async () => {
            const body =
              JSON.stringify({ _tag: "Request", id: "rs-diff", tag: "RegistrySyncDiff", payload: { clientDigest }, headers: [] }) + "\n"
            const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/ndjson", ...authHdr }, body })
            const text = await res.text()
            const msg = JSON.parse(text.trim().split("\n")[0]!) as { exit: { _tag: string; value?: unknown; cause?: unknown } }
            if (msg.exit._tag !== "Success") throw new Error(JSON.stringify(msg.exit))
            return msg.exit.value as { upToDate: boolean; missingOnClient: ReadonlyArray<never>; missingOnServer: ReadonlyArray<string> }
          }),
        RegistryPush: ({ defs }: { defs: ReadonlyArray<{ type: string; version: number; payloadSchema: unknown; digest: string }> }) =>
          Effect.tryPromise(async () => {
            const body =
              JSON.stringify({ _tag: "Request", id: "rs-push", tag: "RegistryPush", payload: { defs }, headers: [] }) + "\n"
            const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/ndjson", ...authHdr }, body })
            const text = await res.text()
            const msg = JSON.parse(text.trim().split("\n")[0]!) as { exit: { _tag: string; value?: unknown; cause?: unknown } }
            if (msg.exit._tag !== "Success") throw new Error(JSON.stringify(msg.exit))
          }).pipe(Effect.asVoid),
      }

      const redResult = yield* syncRegistry(brokenShim).pipe(
        Effect.provide(Layer.succeedContext(clientRegCtx)),
        Effect.either,
      )
      expect(redResult._tag).toBe("Left") // must fail — non-numeric id rejected

      // GREEN: shim using numeric id "1" (the fix in makeRegistryShim).
      // The same server, same registry state — syncRegistry must succeed.
      const fixedShim = makeRegistryShim(rpcUrl, authHdr)

      const greenResult = yield* syncRegistry(fixedShim).pipe(
        Effect.provide(Layer.succeedContext(clientRegCtx)),
        Effect.either,
      )
      expect(greenResult._tag).toBe("Right") // must succeed — numeric id accepted
      if (greenResult._tag === "Right") {
        // The server started with an empty registry, so after sync the diff
        // should have pushed PingEvent (pushed >= 1).
        expect(greenResult.right.pushed).toBeGreaterThanOrEqual(1)
      }
    }),
  ).pipe(Effect.runPromise)
}, 15_000)
