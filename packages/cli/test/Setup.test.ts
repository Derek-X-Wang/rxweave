import { describe, expect, it as vitestIt } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { fileURLToPath } from "node:url"
import * as Path from "node:path"
import { BunFileSystem } from "@effect/platform-bun"
import { EventRegistry } from "@rxweave/schema"
import { readConfigPathFromArgv, resolveStoreLayer } from "../src/Setup.js"
import { Output } from "../src/Output.js"
import { emitCommand } from "../src/commands/emit.js"

const FIXTURE_CONFIG = Path.resolve(
  Path.dirname(fileURLToPath(import.meta.url)),
  "./fixtures/test-config.ts",
)

describe("readConfigPathFromArgv", () => {
  vitestIt("returns null when no --config flag", () => {
    expect(readConfigPathFromArgv(["bun", "rxweave", "emit"])).toBeNull()
  })
  vitestIt("reads --config <path>", () => {
    expect(readConfigPathFromArgv(["bun", "rxweave", "--config", "./foo.ts"])).toBe("./foo.ts")
  })
  vitestIt("reads -c <path>", () => {
    expect(readConfigPathFromArgv(["bun", "rxweave", "-c", "./bar.ts"])).toBe("./bar.ts")
  })
  vitestIt("reads --config=<path>", () => {
    expect(readConfigPathFromArgv(["bun", "rxweave", "--config=./baz.ts"])).toBe("./baz.ts")
  })
})

describe("resolveStoreLayer", () => {
  it.effect("registers schemas from a real config and emit succeeds outside dev", () =>
    Effect.gen(function* () {
      const storeLayer = yield* resolveStoreLayer(FIXTURE_CONFIG)

      const lines: Array<string> = []
      const errors: Array<string> = []
      const out = Layer.succeed(Output, {
        writeLine: (v) => Effect.sync(() => lines.push(JSON.stringify(v))),
        writeError: (v) => Effect.sync(() => errors.push(JSON.stringify(v))),
      })

      yield* emitCommand.handler({
        type: "test.widget.created",
        payload: Option.some(JSON.stringify({ id: "w1" })),
        payloadFile: Option.none(),
        actor: "cli",
        source: "cli" as const,
        batch: false,
      }).pipe(Effect.provide(out), Effect.provide(storeLayer))

      expect(errors).toEqual([])
      expect(lines.length).toBe(1)
      const parsed = JSON.parse(lines[0]!) as { type: string }
      expect(parsed.type).toBe("test.widget.created")
    }).pipe(
      Effect.provide(EventRegistry.Live),
      Effect.provide(BunFileSystem.layer),
    ),
  )
})

