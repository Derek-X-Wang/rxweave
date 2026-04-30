import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { defineEvent, EventRegistry } from "../src/Registry.js"
import { DuplicateEventType } from "../src/Errors.js"

const NodeCreated = defineEvent(
  "canvas.node.created",
  Schema.Struct({ id: Schema.String }),
)

const NodeDeleted = defineEvent(
  "canvas.node.deleted",
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

  // Memoization: digest is recomputed on register, reused otherwise.
  // Guards against the hot-path O(N log N) rebuild on every
  // CloudStore.append that motivated the cache in the first place.
  it.effect("digest is memoized between register calls", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      yield* reg.register(NodeCreated)
      const first = yield* reg.digest
      const second = yield* reg.digest
      const third = yield* reg.digest
      // Two sequential reads with no mutation between should be
      // byte-identical (cache hit every time).
      expect(second).toBe(first)
      expect(third).toBe(first)
      // Registering a new def invalidates the cache; the next read
      // must reflect the new registry contents.
      yield* reg.register(NodeDeleted)
      const afterRegister = yield* reg.digest
      expect(afterRegister).not.toBe(first)
      // And caches again until the next register.
      const afterRegisterSecondRead = yield* reg.digest
      expect(afterRegisterSecondRead).toBe(afterRegister)
    }).pipe(Effect.provide(EventRegistry.Live)),
  )
})

describe("EventRegistry.registerAll", () => {
  it.effect("registers a fresh batch", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      const A = defineEvent("a", Schema.Struct({ x: Schema.Number }))
      const B = defineEvent("b", Schema.Struct({ y: Schema.String }))
      yield* reg.registerAll([A, B])
      const all = yield* reg.all
      expect(all.map((d) => d.type).sort()).toEqual(["a", "b"])
    }).pipe(Effect.provide(EventRegistry.Live)),
  )

  it.effect("with swallowDuplicates: identical re-registration is a no-op", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      const A = defineEvent("a", Schema.Struct({ x: Schema.Number }))
      yield* reg.register(A)
      yield* reg.registerAll([A], { swallowDuplicates: true })
      const all = yield* reg.all
      expect(all.length).toBe(1)
    }).pipe(Effect.provide(EventRegistry.Live)),
  )

  it.effect("with swallowDuplicates: conflicting redefinition still errors", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      const A1 = defineEvent("a", Schema.Struct({ x: Schema.Number }))
      const A2 = defineEvent("a", Schema.Struct({ x: Schema.String }))
      yield* reg.register(A1)
      const result = yield* reg
        .registerAll([A2], { swallowDuplicates: true })
        .pipe(Effect.either)
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(DuplicateEventType)
      }
    }).pipe(Effect.provide(EventRegistry.Live)),
  )
})
