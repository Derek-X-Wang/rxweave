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
})
