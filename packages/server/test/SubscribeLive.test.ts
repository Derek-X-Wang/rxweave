import { describe, expect, it } from "bun:test"
import { Effect, Fiber, Layer, Ref, Schema, Stream } from "effect"
import { EventStore } from "@rxweave/core"
import { EventRegistry, defineEvent } from "@rxweave/schema"
import { MemoryStore } from "@rxweave/store-memory"
import { startServer } from "../src/Server.js"
import { testClientLayer, waitUntil } from "./support.js"

// Covers the replay→live transition through HTTP/NDJSON that the
// Conformance harness skips: its ordering test appends BEFORE
// subscribing (reads out of the snapshot) and its flood case only
// asserts `processed > 0`. A regression here would silently
// re-break live delivery after a non-trivial replay burst.
//
// Runner: `bun:test` — `BunHttpServer.layer` needs `Bun.serve`.

const Ping = defineEvent(
  "test.subscribe.live",
  Schema.Struct({ n: Schema.Number }),
)
const ping = (n: number) => ({
  type: Ping.type,
  payload: { n },
})

describe("subscribe live-delivery over HTTP", () => {
  it("delivers events appended AFTER the replay burst completes", async () => {
    await Effect.scoped(
      Effect.gen(function* () {
        // Shared server-side instances so direct appends and the
        // RPC-mounted handlers read from the same singletons.
        // Without the `Layer.succeed` alias, `startServer` builds a
        // shadow empty store and the client's replay sees nothing.
        const serverStore = yield* EventStore
        const serverReg = yield* EventRegistry
        yield* serverReg.register(Ping)
        const prepopulated = yield* serverStore.append(
          Array.from({ length: 200 }, (_, i) => ping(i)),
        )
        expect(prepopulated.length).toBe(200)

        const handle = yield* startServer({
          store: Layer.succeed(EventStore, serverStore),
          registry: Layer.succeed(EventRegistry, serverReg),
          port: 0,
          host: "127.0.0.1",
        })

        const received = yield* Ref.make<Array<string>>([])
        const subFiber = yield* Effect.forkScoped(
          Effect.gen(function* () {
            const clientReg = yield* EventRegistry
            yield* clientReg.register(Ping)
            const clientStore = yield* EventStore
            yield* Stream.runForEach(
              clientStore.subscribe({ cursor: "earliest" }),
              (event) => Ref.update(received, (arr) => [...arr, event.id]),
            )
          }).pipe(Effect.provide(testClientLayer(handle.port))),
        )

        const afterReplay = yield* waitUntil(
          received,
          (arr) => arr.length >= 200,
        )
        expect(afterReplay.length).toBe(200)
        expect(afterReplay[0]).toBe(prepopulated[0]!.id)
        expect(afterReplay[199]).toBe(prepopulated[199]!.id)

        const liveA = yield* serverStore.append([ping(1000)])
        const afterFirstLive = yield* waitUntil(
          received,
          (arr) => arr.length >= 201,
        )
        expect(afterFirstLive[200]).toBe(liveA[0]!.id)

        const liveB = yield* serverStore.append([ping(1001)])
        const afterSecondLive = yield* waitUntil(
          received,
          (arr) => arr.length >= 202,
        )
        expect(afterSecondLive[201]).toBe(liveB[0]!.id)

        yield* Fiber.interrupt(subFiber)
      }),
    ).pipe(
      Effect.provide(Layer.mergeAll(MemoryStore.Live, EventRegistry.Live)),
      Effect.runPromise,
    )
  }, 10_000)
})
