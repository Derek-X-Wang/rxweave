import { defineConfig } from "vitest/config"

/**
 * Vitest config for apps/web.
 *
 * The app has two test surfaces (same split as packages/server):
 *
 *   1. Bun-native tests (`*.test.ts`): integration tests that start
 *      @rxweave/server via BunHttpServer — must run under `bun test`.
 *
 *   2. Unit tests (`*.vitest.ts`): pure-logic tests for roomToken parsing
 *      and EventLog accumulation that use @effect/vitest. These don't
 *      need Bun and run fine under Node/vitest.
 *
 * The filename suffix split keeps the two runners from tripping over
 * each other (bun test doesn't pick up `.vitest.ts`; vitest ignores
 * the default `.test.ts` glob and only picks up `.vitest.ts` here).
 */
export default defineConfig({
  test: {
    globals: false,
    passWithNoTests: false,
    include: ["test/**/*.vitest.ts"],
    reporters: ["default"],
  },
})
