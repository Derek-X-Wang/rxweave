import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { it as itEffect } from "@effect/vitest"
import { BunContext } from "@effect/platform-bun"
import { mkdtempSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Output } from "../src/Output.js"
import { initCommand } from "../src/commands/init.js"
import { templateFiles, templateDirs } from "../src/commands/init.js"

describe("templateFiles / templateDirs", () => {
  it("minimal scaffolds exactly one file: rxweave.config.ts", () => {
    const files = templateFiles("minimal")
    expect(files.map((f) => f.path)).toEqual(["./rxweave.config.ts"])
    expect(files[0].content).toContain("defineConfig")
    expect(files[0].content).toContain("schemas: []")
    expect(files[0].content).toContain("agents: []")
  })

  it("minimal scaffolds no extra directories", () => {
    expect(templateDirs("minimal")).toEqual([])
  })

  it("full scaffolds config + schemas + agent + readme", () => {
    const paths = templateFiles("full").map((f) => f.path)
    expect(paths).toEqual([
      "./rxweave.config.ts",
      "./schemas.ts",
      "./agents/bob-assistant.ts",
      "./README.md",
    ])
  })

  it("full config wires the request/response schemas + bob-assistant", () => {
    const byPath = Object.fromEntries(
      templateFiles("full").map((f) => [f.path, f.content]),
    )
    expect(byPath["./rxweave.config.ts"]).toContain("RequestPosted")
    expect(byPath["./rxweave.config.ts"]).toContain("ResponsePosted")
    expect(byPath["./rxweave.config.ts"]).toContain("bobAssistant")
    expect(byPath["./schemas.ts"]).toContain("defineEvent")
    expect(byPath["./schemas.ts"]).toContain('"request.posted"')
    expect(byPath["./schemas.ts"]).toContain('"response.posted"')
    expect(byPath["./agents/bob-assistant.ts"]).toContain('id: "bob-assistant"')
    expect(byPath["./agents/bob-assistant.ts"]).toContain("response.posted")
    expect(byPath["./README.md"]).toContain("collaboration stream skeleton")
    expect(byPath["./README.md"]).toContain("--actor alice")
  })

  it("full scaffolds the agents directory", () => {
    expect(templateDirs("full")).toEqual(["./agents"])
  })
})

const runInit = (template: "minimal" | "full", dir: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.cwd()
      process.chdir(dir)
      return prev
    }),
    () => initCommand.handler({ yes: true, template }),
    (prev) => Effect.sync(() => process.chdir(prev)),
  ).pipe(Effect.provide(Output.Live("json")), Effect.provide(BunContext.layer))

describe("init handler", () => {
  itEffect.effect("full writes config + schemas + agent + readme", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "rxw-init-full-"))
      yield* runInit("full", dir)
      expect(existsSync(join(dir, "rxweave.config.ts"))).toBe(true)
      expect(existsSync(join(dir, "schemas.ts"))).toBe(true)
      expect(existsSync(join(dir, "agents/bob-assistant.ts"))).toBe(true)
      expect(existsSync(join(dir, "README.md"))).toBe(true)
      expect(existsSync(join(dir, ".rxweave"))).toBe(true)
    }),
  )

  itEffect.effect("minimal writes only the config + .rxweave", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "rxw-init-min-"))
      yield* runInit("minimal", dir)
      expect(existsSync(join(dir, "rxweave.config.ts"))).toBe(true)
      expect(existsSync(join(dir, "schemas.ts"))).toBe(false)
      expect(existsSync(join(dir, "agents"))).toBe(false)
    }),
  )

  itEffect.effect("refuses if config already exists", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "rxw-init-dup-"))
      yield* runInit("minimal", dir)
      const result = yield* runInit("minimal", dir).pipe(Effect.either)
      expect(result._tag).toBe("Left")
    }),
  )
})
