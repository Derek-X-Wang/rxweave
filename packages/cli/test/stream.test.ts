import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer, Option, Schema } from "effect"
import { MemoryStore } from "@rxweave/store-memory"
import { EventStore } from "@rxweave/core"
import { EventRegistry, defineEvent } from "@rxweave/schema"
import { Output } from "../src/Output.js"
import { streamCommand } from "../src/commands/stream.js"

// NOTE: Matches the pattern from emit.test.ts — @effect/cli@0.75.1's
// Command.parse doesn't exist; we test the handler directly with a
// constructed opts object matching Command.make's inferred shape.
//
// We use `it.live` rather than `it.effect` so `Effect.sleep(...)` below
// actually advances real time. `it.effect` injects `TestContext` (with a
// TestClock) — under a TestClock, a forked daemon waiting on PubSub never
// gets to tick before the parent test fiber's sleep resolves, which dead-
// locks. The stream handler is an infinite subscription by design; we
// fork it, sleep briefly on the real clock, and interrupt.

const Ping = defineEvent("demo.ping", Schema.Unknown)

describe("stream command", () => {
  it.live("prints events from earliest by default", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      yield* reg.register(Ping)
      const store = yield* EventStore
      yield* store.append([
        { type: "demo.ping", actor: "cli", source: "cli", payload: {} },
      ])

      const lines: Array<string> = []
      const out = Layer.succeed(Output, {
        writeLine: (v) => Effect.sync(() => { lines.push(JSON.stringify(v)) }),
        writeError: () => Effect.void,
      })

      const fiber = yield* Effect.forkDaemon(
        streamCommand.handler({
          types: Option.none(),
          actors: Option.none(),
          sources: Option.none(),
          since: Option.none(),
          fromCursor: Option.none(),
          follow: false,
        }).pipe(Effect.provide(out)),
      )
      yield* Effect.sleep(Duration.millis(100))
      yield* Fiber.interrupt(fiber)

      expect(lines.length).toBeGreaterThanOrEqual(1)
    }).pipe(Effect.provide(MemoryStore.Live), Effect.provide(EventRegistry.Live)),
  )
})
