import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { FileSystem } from "@effect/platform"
import { BunFileSystem } from "@effect/platform-bun"
import { Schema } from "effect"
import { EventEnvelope } from "@rxweave/schema"
import { scanAndRecover } from "../src/Recovery.js"

const encode = Schema.encodeSync(Schema.parseJson(EventEnvelope))

const makeEnvelope = (id: string, type = "x.y", ts = 1): EventEnvelope =>
  new EventEnvelope({
    id: id as never,
    type,
    actor: "tester" as never,
    source: "cli",
    timestamp: ts,
    payload: {},
  })

describe("scanAndRecover", () => {
  it.effect("reads well-formed events", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* fs.makeTempFileScoped({ suffix: ".jsonl" })
      const lines = [
        encode(makeEnvelope("01HXC5QKZ8M9A0TN3P1Q2R4S5V")),
        encode(makeEnvelope("01HXC5QKZ8M9A0TN3P1Q2R4S5W")),
      ].join("\n") + "\n"
      yield* fs.writeFile(path, new TextEncoder().encode(lines))
      const result = yield* scanAndRecover(path)
      expect(result.events.length).toBe(2)
      expect(result.skipped).toBe(0)
      expect(result.truncatedBytes).toBe(0)
    }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)),
  )

  it.effect("truncates a torn last line", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* fs.makeTempFileScoped({ suffix: ".jsonl" })
      const good = encode(makeEnvelope("01HXC5QKZ8M9A0TN3P1Q2R4S5V"))
      const torn = `${good}\n{"id":"trunc`
      yield* fs.writeFile(path, new TextEncoder().encode(torn))
      const result = yield* scanAndRecover(path)
      expect(result.events.length).toBe(1)
      expect(result.truncatedBytes).toBeGreaterThan(0)
      expect(result.validBytes).toBe(good.length + 1)
    }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)),
  )

  it.effect("skips an interior corrupted line but keeps the rest", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* fs.makeTempFileScoped({ suffix: ".jsonl" })
      const first = encode(makeEnvelope("01HXC5QKZ8M9A0TN3P1Q2R4S5V"))
      const third = encode(makeEnvelope("01HXC5QKZ8M9A0TN3P1Q2R4S5W"))
      const body = `${first}\n{not json}\n${third}\n`
      yield* fs.writeFile(path, new TextEncoder().encode(body))
      const result = yield* scanAndRecover(path)
      expect(result.events.length).toBe(2)
      expect(result.skipped).toBe(1)
      expect(result.truncatedBytes).toBe(0)
    }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)),
  )
})
