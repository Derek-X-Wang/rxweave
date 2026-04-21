import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { EventRegistry, defineEvent } from "@rxweave/schema"
import { MemoryStore } from "@rxweave/store-memory"
import { appendHandler } from "../../src/handlers/Append.js"

describe("appendHandler", () => {
  it.effect("appends events and returns envelopes with ids", () =>
    Effect.gen(function* () {
      const Ping = defineEvent("demo.ping", Schema.Struct({ n: Schema.Number }))
      const reg = yield* EventRegistry
      yield* reg.register(Ping as never)

      const envelopes = yield* appendHandler({
        events: [{ type: "demo.ping", actor: "tester", source: "cli", payload: { n: 1 } }],
        registryDigest: yield* reg.digest,
      })
      expect(envelopes.length).toBe(1)
      expect(envelopes[0]!.id).toBeDefined()
      expect(typeof envelopes[0]!.id).toBe("string")
      expect(envelopes[0]!.type).toBe("demo.ping")
    }).pipe(
      Effect.provide(MemoryStore.Live),
      Effect.provide(EventRegistry.Live),
    ),
  )
})
