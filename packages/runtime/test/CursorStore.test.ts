import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { FileSystem } from "@effect/platform"
import { BunFileSystem } from "@effect/platform-bun"
import { AgentCursorStore } from "../src/AgentCursorStore.js"

describe("AgentCursorStore.Memory", () => {
  it.effect("defaults unknown agents to 'latest'", () =>
    Effect.gen(function* () {
      const cursors = yield* AgentCursorStore
      const cursor = yield* cursors.get("unknown")
      expect(cursor).toBe("latest")
    }).pipe(Effect.provide(AgentCursorStore.Memory)),
  )

  it.effect("persists set → get round-trip", () =>
    Effect.gen(function* () {
      const cursors = yield* AgentCursorStore
      yield* cursors.set("a", "01HXC5QKZ8M9A0TN3P1Q2R4S5V" as never)
      const cursor = yield* cursors.get("a")
      expect(cursor).toBe("01HXC5QKZ8M9A0TN3P1Q2R4S5V")
    }).pipe(Effect.provide(AgentCursorStore.Memory)),
  )
})

describe("AgentCursorStore.File", () => {
  it.scoped("persists across restarts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* fs.makeTempFileScoped({ suffix: ".json" })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const cursors = yield* AgentCursorStore
          yield* cursors.set("persistent", "01HXC5QKZ8M9A0TN3P1Q2R4S5V" as never)
        }).pipe(Effect.provide(AgentCursorStore.File({ path }))),
      )

      const reread = yield* Effect.scoped(
        Effect.gen(function* () {
          const cursors = yield* AgentCursorStore
          return yield* cursors.get("persistent")
        }).pipe(Effect.provide(AgentCursorStore.File({ path }))),
      )

      expect(reread).toBe("01HXC5QKZ8M9A0TN3P1Q2R4S5V")
    }).pipe(Effect.provide(BunFileSystem.layer)),
  )
})
