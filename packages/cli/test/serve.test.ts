import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer, Option } from "effect"
import { Output } from "../src/Output.js"
import { serveCommand } from "../src/commands/serve.js"

// NOTE: matches emit.test.ts / stream.test.ts — @effect/cli@0.75.1's
// `Command.parse(cmd, argv)` top-level helper doesn't exist, so we
// invoke `serveCommand.handler({...opts})` directly with the option
// shape `Command.make(name, cfg, handler)` produces.
//
// IMPORTANT: these tests exercise only the CLI-layer logic that runs
// *before* `startServer` returns — token provisioning, the no-auth
// warning, the safety interlock. They deliberately do NOT try to
// observe the `stream on http://...` line that's printed after
// `startServer` binds: that line requires `BunHttpServer.layer` which
// calls `Bun.serve`, and this package's vitest runner runs under Node
// where the `Bun` global is undefined. The bind-and-respond path is
// covered in `@rxweave/server`'s own `Server.test.ts` (which runs under
// `bun:test`). A future end-to-end smoke test that spawns the compiled
// CLI via `bun <dist/bin/rxweave.js> serve ...` would close the gap at
// the CLI layer, but for unit tests we pick surface-area over spinup.
//
// We fork the handler and interrupt it before the bind step can fail;
// what we assert is that the *pre-bind* output matches the contract.

describe("serve command", () => {
  it.live("prints the no-auth warning before attempting to bind", () =>
    Effect.gen(function* () {
      const lines: Array<string> = []
      const errors: Array<string> = []
      const out = Layer.succeed(Output, {
        writeLine: (v) =>
          Effect.sync(() => {
            lines.push(typeof v === "string" ? v : JSON.stringify(v))
          }),
        writeError: (v) =>
          Effect.sync(() => {
            errors.push(typeof v === "string" ? v : JSON.stringify(v))
          }),
      })

      const fiber = yield* Effect.forkDaemon(
        serveCommand
          .handler({
            port: 0,
            host: "127.0.0.1",
            storeKind: "memory" as const,
            path: "./.rxweave/stream.jsonl",
            noAuth: true,
            fixedToken: Option.none(),
          })
          .pipe(Effect.provide(out)),
      )
      // `it.live` gives us the real clock. A short sleep is plenty:
      // the warning is printed synchronously before `startServer`
      // even runs, so it's on stdout by the first microtask tick.
      yield* Effect.sleep(Duration.millis(100))
      yield* Fiber.interrupt(fiber)

      const combined = [...lines, ...errors].join("\n")
      expect(combined).toMatch(/\[rxweave\] WARNING: --no-auth enabled/)
    }),
  )

  it.live("rejects --host 0.0.0.0 with --no-auth", () =>
    Effect.gen(function* () {
      const lines: Array<string> = []
      const errors: Array<string> = []
      const out = Layer.succeed(Output, {
        writeLine: (v) =>
          Effect.sync(() => {
            lines.push(typeof v === "string" ? v : JSON.stringify(v))
          }),
        writeError: (v) =>
          Effect.sync(() => {
            errors.push(typeof v === "string" ? v : JSON.stringify(v))
          }),
      })

      const result = yield* Effect.either(
        serveCommand
          .handler({
            port: 0,
            host: "0.0.0.0",
            storeKind: "memory" as const,
            path: "./.rxweave/stream.jsonl",
            noAuth: true,
            fixedToken: Option.none(),
          })
          .pipe(Effect.provide(out)),
      )

      expect(result._tag).toBe("Left")
      // The refusal message goes to stderr (writeError).
      const combined = [...lines, ...errors].join("\n")
      expect(combined).toMatch(
        /refusing to serve unauthenticated on 0\.0\.0\.0/,
      )
    }),
  )

  it.live("prints RXWEAVE_TOKEN export for a caller-supplied --token", () =>
    Effect.gen(function* () {
      const lines: Array<string> = []
      const errors: Array<string> = []
      const out = Layer.succeed(Output, {
        writeLine: (v) =>
          Effect.sync(() => {
            lines.push(typeof v === "string" ? v : JSON.stringify(v))
          }),
        writeError: (v) =>
          Effect.sync(() => {
            errors.push(typeof v === "string" ? v : JSON.stringify(v))
          }),
      })

      const fiber = yield* Effect.forkDaemon(
        serveCommand
          .handler({
            port: 0,
            host: "127.0.0.1",
            storeKind: "memory" as const,
            path: "./.rxweave/stream.jsonl",
            noAuth: false,
            fixedToken: Option.some("rxk_test_fixed_token_value_0123456789abcdef"),
          })
          .pipe(Effect.provide(out)),
      )
      yield* Effect.sleep(Duration.millis(100))
      yield* Fiber.interrupt(fiber)

      const combined = [...lines, ...errors].join("\n")
      expect(combined).toMatch(
        /\[rxweave\] export RXWEAVE_TOKEN=rxk_test_fixed_token_value_0123456789abcdef/,
      )
    }),
  )
})
