import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import { EventEnvelope } from "@rxweave/schema"
import { withIdempotence } from "../src/Dedupe.js"

const envelope = (id: string): EventEnvelope =>
  new EventEnvelope({
    id: id as never,
    type: "x.y",
    actor: "tester" as never,
    source: "cli",
    timestamp: 0,
    payload: {},
  })

describe("withIdempotence", () => {
  it.effect("runs handler once per unique key (local memory)", () =>
    Effect.gen(function* () {
      const counter = yield* Ref.make(0)
      const handler = withIdempotence(
        (e: EventEnvelope) => e.id,
        "local",
        (_e: EventEnvelope) => Ref.update(counter, (n) => n + 1),
      )
      const e = envelope("01HXC5QKZ8M9A0TN3P1Q2R4S5V")
      yield* handler(e)
      yield* handler(e)
      expect(yield* Ref.get(counter)).toBe(1)
    }),
  )
})
