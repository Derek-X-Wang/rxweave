import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Stream, TestClock } from "effect"
import { EventEnvelope } from "@rxweave/schema"
import { whereType, byActor, withinWindow } from "../src/helpers.js"

const envelope = (overrides: Partial<EventEnvelope> = {}): EventEnvelope =>
  new EventEnvelope({
    id: "01HXC5QKZ8M9A0TN3P1Q2R4S5V" as never,
    type: "canvas.node.created",
    actor: "tester" as never,
    source: "cli",
    timestamp: 0,
    payload: {},
    ...overrides,
  })

describe("reactive helpers", () => {
  it.effect("whereType filters by glob", () =>
    Effect.gen(function* () {
      const stream = Stream.fromIterable([
        envelope({ type: "canvas.node.created" }),
        envelope({ type: "system.tick" }),
      ])
      const result = yield* stream.pipe(whereType("canvas.*"), Stream.runCollect)
      expect(Array.from(result).length).toBe(1)
    }),
  )

  it.effect("byActor filters by actor id", () =>
    Effect.gen(function* () {
      const stream = Stream.fromIterable([
        envelope({ actor: "a" as never }),
        envelope({ actor: "b" as never }),
      ])
      const result = yield* stream.pipe(byActor("b" as never), Stream.runCollect)
      expect(Array.from(result)[0]!.actor).toBe("b")
    }),
  )

  it.effect("withinWindow respects TestClock", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1000)
      const stream = Stream.fromIterable([
        envelope({ timestamp: 100 }),
        envelope({ timestamp: 950 }),
      ])
      const result = yield* stream.pipe(withinWindow(100), Stream.runCollect)
      const arr = Array.from(result)
      expect(arr.length).toBe(1)
      expect(arr[0]!.timestamp).toBe(950)
    }),
  )
})
