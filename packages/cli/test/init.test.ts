import { describe, expect, it } from "vitest"
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
