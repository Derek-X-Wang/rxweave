import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, TestClock, TestContext } from "effect"
import { Ulid } from "../src/Ulid.js"

describe("Ulid", () => {
  it.effect("yields monotonically increasing ids at the same timestamp", () =>
    Effect.gen(function* () {
      const factory = yield* Ulid
      const a = yield* factory.next
      const b = yield* factory.next
      expect(a < b).toBe(true)
    }).pipe(Effect.provide(Ulid.Live), Effect.provide(TestContext.TestContext)),
  )

  it.effect("clamps forward when Clock moves backward", () =>
    Effect.gen(function* () {
      const factory = yield* Ulid
      yield* TestClock.setTime(2000)
      const a = yield* factory.next
      yield* TestClock.setTime(1000)
      const b = yield* factory.next
      expect(b > a).toBe(true)
    }).pipe(Effect.provide(Ulid.Live), Effect.provide(TestContext.TestContext)),
  )

  it.effect("produces 26-char Crockford Base32 output", () =>
    Effect.gen(function* () {
      const factory = yield* Ulid
      const id = yield* factory.next
      expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    }).pipe(Effect.provide(Ulid.Live), Effect.provide(TestContext.TestContext)),
  )
})
