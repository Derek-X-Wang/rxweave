import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Chunk, Effect, Stream } from "effect"
import { EventStore } from "@rxweave/core"
import { MemoryStore } from "@rxweave/store-memory"
import { subscribeHandler } from "../../src/handlers/Subscribe.js"

describe("subscribeHandler", () => {
  it.scoped("streams events matching the filter from the cursor", () =>
    Effect.gen(function* () {
      const store = yield* EventStore
      yield* store.append([
        { type: "demo.ping", actor: "tester", source: "cli", payload: {} },
        { type: "demo.pong", actor: "tester", source: "cli", payload: {} },
      ])

      const stream = subscribeHandler({ cursor: "earliest", filter: { types: ["demo.ping"] } })
      const collected = yield* Stream.runCollect(
        stream.pipe(Stream.take(1)),
      )
      const arr = Chunk.toReadonlyArray(collected)
      expect(arr.length).toBe(1)
      expect(arr[0]!.type).toBe("demo.ping")
    }).pipe(Effect.provide(MemoryStore.Live)),
  )
})
