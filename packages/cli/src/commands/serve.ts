import { Command, Options } from "@effect/cli"
import { Effect, Layer, Option } from "effect"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { EventStore } from "@rxweave/core"
import { EventRegistry } from "@rxweave/schema"
import { generateAndPersistToken, startServer } from "@rxweave/server"
import { FileStore } from "@rxweave/store-file"
import { MemoryStore } from "@rxweave/store-memory"
import { Output } from "../Output.js"

/**
 * `rxweave serve` — boots a local `@rxweave/server` instance. This is
 * the primitive, stable entry point for AI agents and third-party tools
 * that want to talk to the event stream without pulling the full
 * RxWeave runtime into their own process.
 *
 * The command intentionally advertises every knob the server exposes
 * (port, host, store kind, store path, auth mode) so callers can pipe
 * the stdout directly into `eval` or `jq`-style scripts and get back
 * both the URL and the token in one shot — that's what the
 * `[rxweave] export RXWEAVE_TOKEN=...` / `[rxweave] export
 * RXWEAVE_URL=...` lines are for.
 *
 * Safety: `--host 0.0.0.0` with `--no-auth` is a hard startup error
 * (spec §5.4). Binding loopback unauthenticated is fine for local dev;
 * binding to a routable interface unauthenticated is a foot-gun large
 * enough that we refuse to proceed rather than trust a warning to be
 * read.
 *
 * Token provisioning:
 *   - `--no-auth` ⇒ no token; server accepts anything. Emit a WARNING
 *     line on stdout (plan §Task 12 allows stdout-with-warn-prefix as
 *     an alternative to stderr; stdout keeps the advertised exports
 *     contiguous for agent-driven `eval` pipelines).
 *   - `--token <x>` ⇒ use the caller-supplied token; print the export
 *     line for convenience but do NOT persist it (they own it).
 *   - (default) ⇒ generate a 256-bit token, persist to
 *     `./.rxweave/serve.token` at 0600, print the export line.
 *
 * Lifetime: `yield* Effect.never` keeps the effect alive until SIGINT
 * / SIGTERM. `BunRuntime.runMain` (the entry point at bin/rxweave.ts)
 * translates those signals into scope close, which in turn interrupts
 * the Bun listener that `startServer` opened into the scope — the
 * classic "scope-bound resource" lifecycle. The `.pipe(Effect.scoped)`
 * at the bottom of the handler establishes that scope explicitly
 * because `Command.make`'s handler doesn't provide one by default.
 */

const portOpt = Options.integer("port").pipe(Options.withDefault(5300))
const hostOpt = Options.text("host").pipe(Options.withDefault("127.0.0.1"))
const storeKindOpt = Options.choice("store", ["file", "memory"] as const).pipe(
  Options.withDefault("file" as const),
)
const pathOpt = Options.text("path").pipe(
  Options.withDefault("./.rxweave/stream.jsonl"),
)
const noAuthOpt = Options.boolean("no-auth").pipe(Options.withDefault(false))
const fixedTokenOpt = Options.text("token").pipe(Options.optional)

export const serveCommand = Command.make(
  "serve",
  {
    port: portOpt,
    host: hostOpt,
    storeKind: storeKindOpt,
    path: pathOpt,
    noAuth: noAuthOpt,
    fixedToken: fixedTokenOpt,
  },
  ({ port, host, storeKind, path, noAuth, fixedToken }) =>
    Effect.gen(function* () {
      const out = yield* Output

      // Safety interlock per spec §5.4. Unauthenticated listening on
      // 0.0.0.0 exposes every event in the stream to anyone on the
      // LAN (or the open internet on a cloud VM with a public IP).
      // Fail-closed — callers who genuinely need this have to pass a
      // token explicitly.
      if (host === "0.0.0.0" && noAuth) {
        return yield* Effect.fail({
          _tag: "UnsafeServerConfig" as const,
          reason:
            "refusing to serve unauthenticated on 0.0.0.0 — pass --token or bind to 127.0.0.1",
        })
      }

      // Token provisioning. `bearer` is the list we hand to the
      // server's auth middleware; empty ⇒ `startServer` installs no
      // middleware at all (no-auth path).
      let bearer: ReadonlyArray<string> = []
      if (noAuth) {
        yield* out.writeLine(
          "[rxweave] WARNING: --no-auth enabled; server is unauthenticated",
        )
      } else if (Option.isSome(fixedToken)) {
        bearer = [fixedToken.value]
        yield* out.writeLine(`[rxweave] export RXWEAVE_TOKEN=${fixedToken.value}`)
      } else {
        // `generateAndPersistToken` uses `writeFileSync` which does
        // not create parent directories — `./.rxweave/` may not exist
        // when the user ran `serve` without `init` first, and it is
        // definitely absent under `--store memory`. Create it up front
        // (recursive: true is a no-op if it already exists) so the
        // token write has somewhere to land. The filename itself is a
        // fixed contract because embedded clients (spec §3.3) read
        // from the same path to avoid having to be told where the
        // token lives. See Auth.ts for the rationale on mode + chmod
        // best-effort.
        const tokenFile = "./.rxweave/serve.token"
        yield* Effect.sync(() =>
          mkdirSync(dirname(tokenFile), { recursive: true }),
        )
        const token = yield* generateAndPersistToken({ tokenFile })
        bearer = [token]
        yield* out.writeLine(`[rxweave] export RXWEAVE_TOKEN=${token}`)
      }

      // Store selection. MemoryStore.Live is a plain `Layer<EventStore>`
      // ready to use; FileStore.Live takes a path and internally provides
      // BunFileSystem. `FileStore.Live` has an error channel (disk I/O
      // during layer build can fail) but `startServer` expects
      // `Layer<EventStore>` with `never` errors — wrap with `Layer.orDie`
      // so any acquire-time failure becomes a defect rather than a typed
      // error. Same pattern as `Setup.ts` uses for config-declared stores.
      const store: Layer.Layer<EventStore> =
        storeKind === "memory"
          ? MemoryStore.Live
          : Layer.orDie(FileStore.Live({ path }))

      const handle = yield* startServer({
        store,
        registry: EventRegistry.Live,
        port,
        host,
        ...(bearer.length > 0 ? { auth: { bearer } } : {}),
      })

      yield* out.writeLine(
        `[rxweave] stream on http://${handle.host}:${handle.port}`,
      )
      yield* out.writeLine(
        `[rxweave] export RXWEAVE_URL=http://${handle.host}:${handle.port}`,
      )

      // Keep the process alive until SIGINT/SIGTERM closes the scope.
      // BunRuntime.runMain's default signal handling feeds the
      // interrupt through, which releases the scope and tears the
      // listener down.
      yield* Effect.never
    }).pipe(Effect.scoped),
)
