import { defineConfig } from "vitest/config"

/**
 * Vitest config for `@rxweave/server`.
 *
 * The package has two distinct test surfaces:
 *
 *   1. Bun-native tests (`*.test.ts`): Server / Auth / SessionToken
 *      integration tests that import from `bun:test` and drive
 *      `startServer` through its HTTP socket. These run under
 *      `bun test` because `BunHttpServer.layer` calls `Bun.serve()`
 *      directly — vitest under Node doesn't have that global.
 *
 *   2. Conformance harness (`*.vitest.ts`): the spec §11 convergence
 *      gate that runs the shared `runConformance` 10-case suite from
 *      `@rxweave/core/testing`. That harness is tightly coupled to
 *      vitest + `@effect/vitest` (uses `describe`, `it.effect`,
 *      `it.scopedLive`, `beforeEach`) and cannot be run under
 *      `bun test`'s non-vitest runner.
 *
 * The split via filename suffix (`.test.ts` vs `.vitest.ts`) keeps
 * each runner from tripping over the other:
 *
 *   - `bun test` matches `*{.test,.spec}.{ts,tsx,…}` — the
 *     `.vitest.ts` suffix is deliberately outside that glob, so
 *     conformance files stay invisible to `bun test`.
 *   - vitest's default include is `**\/*.{test,spec}.*` so we
 *     override `include` here to pick up `.vitest.ts` instead.
 *
 * The conformance script still needs Bun as the *runtime* (so
 * `Bun.serve` exists inside vitest's test modules). See the
 * `test:conformance` script in package.json for the launcher command.
 */
export default defineConfig({
  test: {
    globals: false,
    passWithNoTests: false,
    include: ["test/**/*.vitest.ts"],
    reporters: ["default"],
    // Server spin-up + HTTP round-trip per case adds a bit of latency
    // over the pure in-memory conformance run. 30s ceiling is still
    // well under the wall-clock of any real conformance case but gives
    // headroom on slow CI.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
