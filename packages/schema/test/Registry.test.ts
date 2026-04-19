import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { defineEvent, EventRegistry } from "../src/Registry.js"

const NodeCreated = defineEvent(
  "canvas.node.created",
  Schema.Struct({ id: Schema.String }),
)

describe("EventRegistry", () => {
  it.effect("registers and looks up a type", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      yield* reg.register(NodeCreated)
      const found = yield* reg.lookup("canvas.node.created")
      expect(found.type).toBe("canvas.node.created")
    }).pipe(Effect.provide(EventRegistry.Live)),
  )

  it.effect("rejects duplicate registration", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      yield* reg.register(NodeCreated)
      const result = yield* Effect.flip(reg.register(NodeCreated))
      expect(result._tag).toBe("DuplicateEventType")
    }).pipe(Effect.provide(EventRegistry.Live)),
  )

  it.effect("returns tagged error for unknown type", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      const result = yield* Effect.flip(reg.lookup("nope"))
      expect(result._tag).toBe("UnknownEventType")
    }).pipe(Effect.provide(EventRegistry.Live)),
  )

  it.effect("produces a stable digest that changes when defs change", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      const emptyDigest = yield* reg.digest
      yield* reg.register(NodeCreated)
      const oneDigest = yield* reg.digest
      expect(emptyDigest).not.toBe(oneDigest)
    }).pipe(Effect.provide(EventRegistry.Live)),
  )

  it.effect("wire representation includes sha256 digest per def", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      yield* reg.register(NodeCreated)
      const wire = yield* reg.wire
      expect(wire.length).toBe(1)
      expect(wire[0]!.type).toBe("canvas.node.created")
      expect(wire[0]!.digest).toMatch(/^[0-9a-f]{64}$/)
    }).pipe(Effect.provide(EventRegistry.Live)),
  )
})
