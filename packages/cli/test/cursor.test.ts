import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { MemoryStore } from "@rxweave/store-memory"
import { EventStore } from "@rxweave/core"
import { EventRegistry } from "@rxweave/schema"
import { cursorCommand } from "../src/commands/cursor.js"

// NOTE: Matches the pattern from emit.test.ts — we test the handler
// directly. Unlike emit/stream/import which go through the `Output`
// service, `cursor` emits a bare token via `Console.log` so agents can
// do `cursor=$(rxweave cursor)` without JSON quoting. We capture that
// by spying on the native `console.log`, which Effect's default
// Console delegates to verbatim (see `internal/defaultServices/console`).

describe("cursor command", () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  it.effect("prints empty string for an empty store", () =>
    Effect.gen(function* () {
      yield* cursorCommand.handler({})

      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(logSpy).toHaveBeenCalledWith("")
    }).pipe(
      Effect.provide(MemoryStore.Live),
      Effect.provide(EventRegistry.Live),
    ),
  )

  it.effect("prints the event id after one append", () =>
    Effect.gen(function* () {
      const store = yield* EventStore
      const appended = yield* store.append([
        { type: "demo.ping", actor: "cli", source: "cli", payload: { n: 1 } },
      ])

      yield* cursorCommand.handler({})

      expect(logSpy).toHaveBeenCalledTimes(1)
      const logged = logSpy.mock.calls[0]![0] as string
      // ULID: 26 chars of Crockford base32, uppercase letters + digits.
      expect(logged).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
      expect(logged).toBe(appended[0]!.id)
    }).pipe(
      Effect.provide(MemoryStore.Live),
      Effect.provide(EventRegistry.Live),
    ),
  )

  it.effect("prints the latest event id after multiple appends", () =>
    Effect.gen(function* () {
      const store = yield* EventStore
      const appended = yield* store.append([
        { type: "demo.ping", actor: "cli", source: "cli", payload: { n: 1 } },
        { type: "demo.ping", actor: "cli", source: "cli", payload: { n: 2 } },
        { type: "demo.ping", actor: "cli", source: "cli", payload: { n: 3 } },
      ])

      yield* cursorCommand.handler({})

      expect(logSpy).toHaveBeenCalledTimes(1)
      const logged = logSpy.mock.calls[0]![0] as string
      expect(logged).toBe(appended[appended.length - 1]!.id)
    }).pipe(
      Effect.provide(MemoryStore.Live),
      Effect.provide(EventRegistry.Live),
    ),
  )
})
