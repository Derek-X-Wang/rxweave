import { describe, expect, it } from "bun:test"
import { FetchHttpClient } from "@effect/platform"
import { Effect, Fiber, Layer, Ref, Schema, Stream } from "effect"
import { EventStore } from "@rxweave/core"
import { EventRegistry, defineEvent } from "@rxweave/schema"
import { MemoryStore } from "@rxweave/store-memory"
import { CloudStore } from "@rxweave/store-cloud"
import { startServer } from "../src/Server.js"

/**
 * Fills a gap Phase F verification surfaced: the `Conformance.vitest.ts`
 * harness appends the full event set BEFORE subscribing (so its
 * ordering test reads out of the snapshot) and its flood case only
 * asserts `processed > 0`. Neither exercises the replay-then-live
 * transition through the actual HTTP/NDJSON transport.
 *
 * That transition is exactly what breaks in WebKit's `fetch` reader
 * (the `apps/web` bridge works around it with a two-phase drain). A
 * regression here would re-introduce the silent live-delivery failure
 * on any NON-browser client too, which is what this test locks down.
 *
 * Runner: `bun:test` because `BunHttpServer.layer` needs `Bun.serve`.
 */

const Ping = defineEvent(
  "test.subscribe.live",
  Schema.Struct({ n: Schema.Number }),
)

describe("subscribe live-delivery over HTTP", () => {
  it("delivers events appended AFTER the replay burst completes", async () => {
    await Effect.scoped(
      Effect.gen(function* () {
        // Build server-side store + registry instances in the outer
        // scope so we can both prepopulate them directly AND alias them
        // into `startServer` via `Layer.succeed` — identical to the
        // pattern `apps/web/server/server.ts` uses. Without the alias,
        // `startServer` would build a second (empty) store and the
        // client's subscribe would miss the prepopulated events.
        const serverStore = yield* EventStore
        const serverReg = yield* EventRegistry
        yield* serverReg.register(Ping)
        const prepopulated = yield* serverStore.append(
          Array.from({ length: 200 }, (_, i) => ({
            type: Ping.type,
            actor: "cli" as never,
            source: "cli" as never,
            payload: { n: i },
          })),
        )
        expect(prepopulated.length).toBe(200)

        const handle = yield* startServer({
          store: Layer.succeed(EventStore, serverStore),
          registry: Layer.succeed(EventRegistry, serverReg),
          port: 0,
          host: "127.0.0.1",
        })

        // Client: CloudStore over HTTP. `EventRegistry.Live` is its
        // own fresh instance on the client side — the client's
        // `Append` digest calc reads it, but Subscribe doesn't.
        const clientLayer = CloudStore.Live({
          url: `http://127.0.0.1:${handle.port}/rxweave/rpc`,
        }).pipe(
          Layer.provideMerge(EventRegistry.Live),
          Layer.provide(FetchHttpClient.layer),
        )

        const received = yield* Ref.make<Array<string>>([])
        const subFiber = yield* Effect.forkScoped(
          Effect.gen(function* () {
            const clientReg = yield* EventRegistry
            yield* clientReg.register(Ping)
            const clientStore = yield* EventStore
            yield* Stream.runForEach(
              clientStore.subscribe({ cursor: "earliest" }),
              (event) =>
                Ref.update(received, (arr) => [...arr, event.id]),
            )
          }).pipe(Effect.provide(clientLayer)),
        )

        // Wait for the replay burst to flush through the HTTP reader.
        // 1000ms is generous; on a warm process local replay lands in
        // the low tens of ms.
        yield* Effect.sleep("1 seconds")
        const afterReplay = yield* Ref.get(received)
        expect(afterReplay.length).toBe(200)
        expect(afterReplay[0]).toBe(prepopulated[0]!.id)
        expect(afterReplay[199]).toBe(prepopulated[199]!.id)

        // Append two more events AFTER the subscribe is mid-stream.
        // These are the events the Phase F WebKit buffer trap would
        // swallow; here we assert they do arrive through the
        // non-WebKit Bun client this test covers.
        const liveA = yield* serverStore.append([
          {
            type: Ping.type,
            actor: "cli" as never,
            source: "cli" as never,
            payload: { n: 1000 },
          },
        ])
        yield* Effect.sleep("500 millis")
        const afterFirstLive = yield* Ref.get(received)
        expect(afterFirstLive.length).toBe(201)
        expect(afterFirstLive[200]).toBe(liveA[0]!.id)

        const liveB = yield* serverStore.append([
          {
            type: Ping.type,
            actor: "cli" as never,
            source: "cli" as never,
            payload: { n: 1001 },
          },
        ])
        yield* Effect.sleep("500 millis")
        const afterSecondLive = yield* Ref.get(received)
        expect(afterSecondLive.length).toBe(202)
        expect(afterSecondLive[201]).toBe(liveB[0]!.id)

        yield* Fiber.interrupt(subFiber)
      }),
    ).pipe(
      Effect.provide(Layer.mergeAll(MemoryStore.Live, EventRegistry.Live)),
      Effect.runPromise,
    )
  }, 10_000)
})
