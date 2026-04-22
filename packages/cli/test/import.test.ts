import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import { MemoryStore } from "@rxweave/store-memory"
import { EventStore } from "@rxweave/core"
import { EventRegistry, defineEvent } from "@rxweave/schema"
import { Output } from "../src/Output.js"
import { importCommand } from "../src/commands/import.js"

// NOTE: Matches the pattern from emit.test.ts — @effect/cli@0.75.1's
// top-level `Command.parse(cmd, argv)` doesn't exist, so we invoke
// `importCommand.handler({...opts})` directly with the option shape
// `Command.make(name, cfg, handler)` produces.

// Every import test uses demo.* types — register them with Schema.Unknown
// so the handler's payload-validation pass accepts any payload shape
// (tests vary between `{n}` and `{}`). The Phase E review enforced that
// import now validates like emit --batch, so each type must be known.
const registerDemoSchemas = Effect.gen(function* () {
  const reg = yield* EventRegistry
  for (const t of ["demo.ping", "demo.pong", "demo.pang"] as const) {
    const def = defineEvent(t, Schema.Unknown as unknown as Schema.Schema<unknown, unknown>)
    yield* reg.register(def as never).pipe(Effect.orElseSucceed(() => undefined))
  }
})

describe("import command", () => {
  it.effect("dry-run prints event types without appending", () =>
    Effect.gen(function* () {
      yield* registerDemoSchemas
      const dir = mkdtempSync(join(tmpdir(), "rxweave-import-"))
      const file = join(dir, "seed.jsonl")
      writeFileSync(
        file,
        [
          JSON.stringify({ type: "demo.ping", payload: { n: 1 } }),
          JSON.stringify({ type: "demo.pong", payload: { n: 2 } }),
        ].join("\n") + "\n",
        "utf8",
      )

      const lines: Array<string> = []
      const errors: Array<string> = []
      const out = Layer.succeed(Output, {
        writeLine: (v) =>
          Effect.sync(() => {
            lines.push(typeof v === "string" ? v : JSON.stringify(v))
          }),
        writeError: (v) =>
          Effect.sync(() => {
            errors.push(typeof v === "string" ? v : JSON.stringify(v))
          }),
      })

      yield* importCommand
        .handler({
          file,
          dryRun: true,
          actor: Option.none(),
        })
        .pipe(Effect.provide(out))

      expect(errors.length).toBe(0)
      const combined = lines.join("\n")
      expect(combined).toMatch(/\[import\] dry-run: 2 events from /)
      expect(combined).toMatch(/demo\.ping/)
      expect(combined).toMatch(/demo\.pong/)

      // Nothing should have been written to the store.
      const store = yield* EventStore
      const all = yield* store.query({}, 100)
      expect(all.length).toBe(0)
    }).pipe(
      Effect.provide(MemoryStore.Live),
      Effect.provide(EventRegistry.Live),
    ),
  )

  it.effect("appends events from NDJSON file", () =>
    Effect.gen(function* () {
      yield* registerDemoSchemas
      const dir = mkdtempSync(join(tmpdir(), "rxweave-import-"))
      const file = join(dir, "seed.jsonl")
      writeFileSync(
        file,
        [
          JSON.stringify({ type: "demo.ping", payload: { n: 1 } }),
          JSON.stringify({ type: "demo.pong", payload: { n: 2 } }),
        ].join("\n") + "\n",
        "utf8",
      )

      const lines: Array<string> = []
      const out = Layer.succeed(Output, {
        writeLine: (v) =>
          Effect.sync(() => {
            lines.push(typeof v === "string" ? v : JSON.stringify(v))
          }),
        writeError: () => Effect.void,
      })

      yield* importCommand
        .handler({
          file,
          dryRun: false,
          actor: Option.none(),
        })
        .pipe(Effect.provide(out))

      const combined = lines.join("\n")
      expect(combined).toMatch(/\[import\] appended 2 events from /)

      const store = yield* EventStore
      const all = yield* store.query({}, 100)
      expect(all.length).toBe(2)
      const types = all.map((e) => e.type).sort()
      expect(types).toEqual(["demo.ping", "demo.pong"])
      // Default actor/source when unset in file. Source is a closed
      // literal union (canvas/agent/system/voice/cli/cloud) — import.ts
      // defaults to "cli" when a wire entry omits source.
      for (const e of all) {
        expect(e.actor).toBe("cli")
        expect(e.source).toBe("cli")
      }
    }).pipe(
      Effect.provide(MemoryStore.Live),
      Effect.provide(EventRegistry.Live),
    ),
  )

  it.effect("appends events from JSON-array file", () =>
    Effect.gen(function* () {
      yield* registerDemoSchemas
      const dir = mkdtempSync(join(tmpdir(), "rxweave-import-"))
      const file = join(dir, "seed.json")
      writeFileSync(
        file,
        JSON.stringify([
          { type: "demo.ping", payload: { n: 1 } },
          { type: "demo.pong", payload: { n: 2 } },
          { type: "demo.pang", payload: { n: 3 } },
        ]),
        "utf8",
      )

      const lines: Array<string> = []
      const out = Layer.succeed(Output, {
        writeLine: (v) =>
          Effect.sync(() => {
            lines.push(typeof v === "string" ? v : JSON.stringify(v))
          }),
        writeError: () => Effect.void,
      })

      yield* importCommand
        .handler({
          file,
          dryRun: false,
          actor: Option.none(),
        })
        .pipe(Effect.provide(out))

      const combined = lines.join("\n")
      expect(combined).toMatch(/\[import\] appended 3 events from /)

      const store = yield* EventStore
      const all = yield* store.query({}, 100)
      expect(all.length).toBe(3)
    }).pipe(
      Effect.provide(MemoryStore.Live),
      Effect.provide(EventRegistry.Live),
    ),
  )

  it.effect("--actor overrides actor on every event", () =>
    Effect.gen(function* () {
      yield* registerDemoSchemas
      const dir = mkdtempSync(join(tmpdir(), "rxweave-import-"))
      const file = join(dir, "seed.jsonl")
      writeFileSync(
        file,
        [
          JSON.stringify({ type: "demo.ping", payload: {}, actor: "original" }),
          JSON.stringify({ type: "demo.pong", payload: {} }),
        ].join("\n"),
        "utf8",
      )

      const out = Layer.succeed(Output, {
        writeLine: () => Effect.void,
        writeError: () => Effect.void,
      })

      yield* importCommand
        .handler({
          file,
          dryRun: false,
          actor: Option.some("migrator"),
        })
        .pipe(Effect.provide(out))

      const store = yield* EventStore
      const all = yield* store.query({}, 100)
      expect(all.length).toBe(2)
      for (const e of all) {
        expect(e.actor).toBe("migrator")
      }
    }).pipe(
      Effect.provide(MemoryStore.Live),
      Effect.provide(EventRegistry.Live),
    ),
  )
})
