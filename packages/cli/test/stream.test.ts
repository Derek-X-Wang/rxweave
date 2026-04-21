import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Duration, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
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
const ShapeUpserted = defineEvent("canvas.shape.upserted", Schema.Unknown)
const ShapeDeleted = defineEvent("canvas.shape.deleted", Schema.Unknown)
const BindingUpserted = defineEvent("canvas.binding.upserted", Schema.Unknown)

// Helper — build the default opts object for the handler with all
// Option-typed flags as `None` and all boolean-defaults as `false`.
// Individual tests spread-override the fields they care about.
const defaultOpts = {
  types: Option.none<ReadonlyArray<string>>(),
  actors: Option.none<ReadonlyArray<string>>(),
  sources: Option.none<ReadonlyArray<string>>(),
  since: Option.none<number>(),
  fromCursor: Option.none<string>(),
  follow: false,
  count: false,
  last: Option.none<number>(),
  fold: Option.none<string>(),
} as const

const makeOut = (
  lines: Array<string>,
  errors: Array<string> = [],
) =>
  Layer.succeed(Output, {
    writeLine: (v) =>
      Effect.sync(() => {
        lines.push(typeof v === "string" ? v : JSON.stringify(v))
      }),
    writeError: (v) =>
      Effect.sync(() => {
        errors.push(typeof v === "string" ? v : JSON.stringify(v))
      }),
  })

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
      const out = makeOut(lines)

      const fiber = yield* Effect.forkDaemon(
        streamCommand.handler({ ...defaultOpts }).pipe(Effect.provide(out)),
      )
      yield* Effect.sleep(Duration.millis(100))
      yield* Fiber.interrupt(fiber)

      expect(lines.length).toBeGreaterThanOrEqual(1)
    }).pipe(Effect.provide(MemoryStore.Live), Effect.provide(EventRegistry.Live)),
  )

  // --- Task 15: --count --------------------------------------------------
  it.effect("--count emits one JSON object with the total and exits", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      yield* reg.register(Ping)
      const store = yield* EventStore
      yield* store.append([
        { type: "demo.ping", actor: "cli", source: "cli", payload: { n: 1 } },
        { type: "demo.ping", actor: "cli", source: "cli", payload: { n: 2 } },
        { type: "demo.ping", actor: "cli", source: "cli", payload: { n: 3 } },
      ])

      const lines: Array<string> = []
      const out = makeOut(lines)

      yield* streamCommand
        .handler({ ...defaultOpts, count: true })
        .pipe(Effect.provide(out))

      expect(lines.length).toBe(1)
      expect(JSON.parse(lines[0]!)).toEqual({ count: 3 })
    }).pipe(
      Effect.provide(MemoryStore.Live),
      Effect.provide(EventRegistry.Live),
    ),
  )

  it.effect("--count with no matches emits {\"count\": 0}", () =>
    Effect.gen(function* () {
      const lines: Array<string> = []
      const out = makeOut(lines)

      yield* streamCommand
        .handler({ ...defaultOpts, count: true })
        .pipe(Effect.provide(out))

      expect(lines.length).toBe(1)
      expect(JSON.parse(lines[0]!)).toEqual({ count: 0 })
    }).pipe(
      Effect.provide(MemoryStore.Live),
      Effect.provide(EventRegistry.Live),
    ),
  )

  // --- Task 16: --last N -------------------------------------------------
  it.effect("--last N emits the last N matching events in order", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      yield* reg.register(Ping)
      const store = yield* EventStore
      yield* store.append([
        { type: "demo.ping", actor: "cli", source: "cli", payload: { n: 1 } },
        { type: "demo.ping", actor: "cli", source: "cli", payload: { n: 2 } },
        { type: "demo.ping", actor: "cli", source: "cli", payload: { n: 3 } },
        { type: "demo.ping", actor: "cli", source: "cli", payload: { n: 4 } },
        { type: "demo.ping", actor: "cli", source: "cli", payload: { n: 5 } },
      ])

      const lines: Array<string> = []
      const out = makeOut(lines)

      yield* streamCommand
        .handler({ ...defaultOpts, last: Option.some(2) })
        .pipe(Effect.provide(out))

      expect(lines.length).toBe(2)
      const parsed = lines.map(
        (l) => (JSON.parse(l) as { payload: { n: number } }).payload.n,
      )
      // Last two events in append order are 4 and 5.
      expect(parsed).toEqual([4, 5])
    }).pipe(
      Effect.provide(MemoryStore.Live),
      Effect.provide(EventRegistry.Live),
    ),
  )

  // --- Task 17: --fold <name> --------------------------------------------
  it.effect("--fold canvas emits final {shapes, bindings} state", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      yield* reg.register(ShapeUpserted)
      yield* reg.register(ShapeDeleted)
      yield* reg.register(BindingUpserted)
      const store = yield* EventStore
      yield* store.append([
        {
          type: "canvas.shape.upserted",
          actor: "cli",
          source: "cli",
          payload: { record: { id: "s1", type: "geo" } },
        },
        {
          type: "canvas.shape.upserted",
          actor: "cli",
          source: "cli",
          payload: { record: { id: "s2", type: "arrow" } },
        },
        {
          type: "canvas.shape.deleted",
          actor: "cli",
          source: "cli",
          payload: { id: "s1" },
        },
        {
          type: "canvas.binding.upserted",
          actor: "cli",
          source: "cli",
          payload: { record: { id: "b1" } },
        },
      ])

      const lines: Array<string> = []
      const out = makeOut(lines)

      yield* streamCommand
        .handler({ ...defaultOpts, fold: Option.some("canvas") })
        .pipe(Effect.provide(out))

      expect(lines.length).toBe(1)
      const state = JSON.parse(lines[0]!) as {
        shapes: Record<string, { id: string; type: string }>
        bindings: Record<string, { id: string }>
      }
      expect(Object.keys(state.shapes)).toEqual(["s2"])
      expect(state.shapes["s2"]).toEqual({ id: "s2", type: "arrow" })
      expect(state.bindings["b1"]).toEqual({ id: "b1" })
    }).pipe(
      Effect.provide(MemoryStore.Live),
      Effect.provide(EventRegistry.Live),
    ),
  )

  it.effect("--fold <unknown> fails with a structured error", () =>
    Effect.gen(function* () {
      const lines: Array<string> = []
      const errors: Array<string> = []
      const out = makeOut(lines, errors)

      const result = yield* streamCommand
        .handler({ ...defaultOpts, fold: Option.some("no-such-fold") })
        .pipe(Effect.provide(out), Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      // Structured error on stderr identifies this as a bad fold name —
      // agents parse the _tag to decide whether to retry or abort.
      const combined = errors.join("\n")
      expect(combined).toMatch(/UnknownFold/)
      expect(combined).toMatch(/no-such-fold/)
    }).pipe(
      Effect.provide(MemoryStore.Live),
      Effect.provide(EventRegistry.Live),
    ),
  )

  // --- Mutual exclusion (3 representative combos) ------------------------
  it.effect("--follow + --count fails with mutual-exclusion error", () =>
    Effect.gen(function* () {
      const lines: Array<string> = []
      const errors: Array<string> = []
      const out = makeOut(lines, errors)

      const result = yield* streamCommand
        .handler({ ...defaultOpts, follow: true, count: true })
        .pipe(Effect.provide(out), Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      const combined = errors.join("\n")
      expect(combined).toMatch(/InvalidStreamOptions/)
      expect(combined).toMatch(/follow/)
      expect(combined).toMatch(/count/)
    }).pipe(
      Effect.provide(MemoryStore.Live),
      Effect.provide(EventRegistry.Live),
    ),
  )

  it.effect("--count + --last fails with mutual-exclusion error", () =>
    Effect.gen(function* () {
      const lines: Array<string> = []
      const errors: Array<string> = []
      const out = makeOut(lines, errors)

      const result = yield* streamCommand
        .handler({
          ...defaultOpts,
          count: true,
          last: Option.some(3),
        })
        .pipe(Effect.provide(out), Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      const combined = errors.join("\n")
      expect(combined).toMatch(/InvalidStreamOptions/)
    }).pipe(
      Effect.provide(MemoryStore.Live),
      Effect.provide(EventRegistry.Live),
    ),
  )

  it.effect("--last + --fold fails with mutual-exclusion error", () =>
    Effect.gen(function* () {
      const lines: Array<string> = []
      const errors: Array<string> = []
      const out = makeOut(lines, errors)

      const result = yield* streamCommand
        .handler({
          ...defaultOpts,
          last: Option.some(3),
          fold: Option.some("canvas"),
        })
        .pipe(Effect.provide(out), Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      const combined = errors.join("\n")
      expect(combined).toMatch(/InvalidStreamOptions/)
    }).pipe(
      Effect.provide(MemoryStore.Live),
      Effect.provide(EventRegistry.Live),
    ),
  )
})
