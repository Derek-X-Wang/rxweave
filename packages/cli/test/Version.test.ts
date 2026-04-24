import { describe, expect, test } from "vitest"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as Path from "node:path"

// NOTE: spawns the source entry via `bun run bin/rxweave.ts --version`
// instead of testing a helper, because the bug class this guards is
// "the version string in bin/rxweave.ts drifts from package.json." A
// unit test of an intermediate constant would pass by construction
// even if a future refactor hardcoded the banner again. This runs
// end-to-end against the meta-invocation path in Setup.ts, which
// skips config loading, so it stays cheap (~500ms).

const packageDir = Path.resolve(
  Path.dirname(fileURLToPath(import.meta.url)),
  "..",
)

describe("rxweave --version", () => {
  test("prints the package.json version", () => {
    const pkg = JSON.parse(
      readFileSync(Path.join(packageDir, "package.json"), "utf8"),
    ) as { version: string }

    const result = spawnSync(
      "bun",
      ["run", Path.join(packageDir, "bin/rxweave.ts"), "--version"],
      { encoding: "utf8", cwd: packageDir },
    )

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(pkg.version)
  })
})
