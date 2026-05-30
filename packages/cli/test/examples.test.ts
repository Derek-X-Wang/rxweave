import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { templateFiles } from "../src/commands/init.js"

// The committed `examples/collaboration-stream/` is the verbatim output of
// `rxweave init --template full`. This guards it against silent drift: if the
// template changes, regenerate the example (see PR/cookbook) or this fails.
const exampleDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../examples/collaboration-stream",
)

describe("examples/collaboration-stream matches init --template full", () => {
  for (const f of templateFiles("full")) {
    const rel = f.path.replace(/^\.\//, "")
    it(`${rel} is in sync with the template`, () => {
      const onDisk = readFileSync(join(exampleDir, rel), "utf8")
      expect(onDisk).toBe(f.content)
    })
  }
})
