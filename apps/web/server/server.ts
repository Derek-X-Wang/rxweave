import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Cause, Effect, Layer } from "effect"
import { EventStore } from "@rxweave/core"
import { FileStore } from "@rxweave/store-file"
import { EventRegistry, type EventDef } from "@rxweave/schema"
import { AgentCursorStore, supervise, type AgentDef } from "@rxweave/runtime"
import { generateAndPersistToken, startServer } from "@rxweave/server"
import {
  CanvasBindingDeleted,
  CanvasBindingUpserted,
  CanvasShapeDeleted,
  CanvasShapeUpserted,
} from "./schemas.js"

const PORT = 5301
const STORE_PATH = ".rxweave/canvas.jsonl"
const TOKEN_PATH = ".rxweave/serve.token"

// Widen each `defineEvent(...)` to `EventDef` to sidestep the
// `exactOptionalPropertyTypes` co/contravariance mismatch between
// narrow `EventDef<A, I>` and the `EventDef<unknown, unknown>` that
// `reg.register(def)` expects — same pattern as the CLI config loader.
const schemas: ReadonlyArray<EventDef> = [
  CanvasShapeUpserted as EventDef,
  CanvasShapeDeleted as EventDef,
  CanvasBindingUpserted as EventDef,
  CanvasBindingDeleted as EventDef,
]

// Opt-in LLM suggester agent. Gated on ANTHROPIC_API_KEY /
// OPENROUTER_API_KEY so the canvas works standalone. Dynamic import
// keeps `@ai-sdk/anthropic` out of the startup path when the keys are
// missing. SUGGESTER_DISABLED=1 forces the agent off even when keys
// are present — useful when a dev has OPENROUTER_API_KEY in .env for
// other tools but doesn't want to burn tokens on every shape edit
// during UI development.
const suggesterDisabled =
  process.env.SUGGESTER_DISABLED === "1" ||
  process.env.SUGGESTER_DISABLED === "true"
const hasKey =
  !!process.env.OPENROUTER_API_KEY || !!process.env.ANTHROPIC_API_KEY

// `generateAndPersistToken` uses `writeFileSync` and does NOT create
// parent directories. Create `.rxweave/` up front so the token write
// has somewhere to land (recursive: true is a no-op if it already
// exists). See `@rxweave/server` Auth.ts for the rationale on mode +
// chmod best-effort.
mkdirSync(dirname(TOKEN_PATH), { recursive: true })

// Base layer stack: this is where the single, shared EventStore +
// EventRegistry + AgentCursorStore instances get built. Both
// `startServer` (via `Layer.succeed(EventStore, …)`) and
// `supervise([...])` end up reading from these same instances, so
// canvas events posted via RPC reach the suggester's subscription and
// suggester-emitted events reach browser clients subscribing via RPC.
const AppLive = Layer.mergeAll(
  FileStore.Live({ path: STORE_PATH }),
  EventRegistry.Live,
  AgentCursorStore.Memory,
)

const program = Effect.gen(function* () {
  // Register canvas schemas on the SHARED EventRegistry. The browser
  // registers the identical set on its in-browser EventRegistry. Since
  // `digestOne` hashes `type|version|Schema.ast` deterministically and
  // `EventRegistry.digest` sorts the per-def digests before hashing,
  // both sides compute the same aggregate digest with no explicit
  // push — that's what allows browser → server Append RPCs to pass
  // the digest check without a separate RegistryPush round-trip.
  const reg = yield* EventRegistry
  for (const def of schemas) yield* reg.register(def)

  // Mint the token and kick off the suggester import in parallel —
  // the import resolves `@ai-sdk/anthropic` + the suggester module
  // from disk (~100-300ms cold) and has no dependency on the token,
  // so pushing it off the critical path brings the HTTP listener up
  // proportionally sooner when keys are present.
  const shouldLoadSuggester = !suggesterDisabled && hasKey
  const [token, suggesterMod] = yield* Effect.all(
    [
      generateAndPersistToken({ tokenFile: TOKEN_PATH }),
      shouldLoadSuggester
        ? Effect.promise(() => import("./agents/suggester.js"))
        : Effect.succeed(null),
    ],
    { concurrency: "unbounded" },
  )

  // Fork the suggester agent into the SAME scope as startServer below.
  // `Effect.forkScoped` ties the fiber's lifetime to the enclosing
  // scope — SIGINT/SIGTERM closing the scope interrupts the agent
  // fiber and then the HTTP listener in one clean cascade.
  if (suggesterDisabled) {
    console.log("[web] LLM suggester: disabled via SUGGESTER_DISABLED")
  } else if (suggesterMod) {
    const { suggesterAgent } = suggesterMod
    yield* Effect.forkScoped(
      supervise([suggesterAgent as unknown as AgentDef<any>]).pipe(
        Effect.tapErrorCause((cause) =>
          Effect.sync(() =>
            console.error("[web] supervise: DIED\n" + Cause.pretty(cause)),
          ),
        ),
      ),
    )
    const provider = process.env.OPENROUTER_API_KEY ? "openrouter" : "anthropic"
    console.log(`[web] LLM suggester agent forked (${provider})`)
  } else {
    console.log(
      "[web] LLM suggester: inactive (set OPENROUTER_API_KEY or ANTHROPIC_API_KEY to enable)",
    )
  }

  // Extract the live service instances and wrap as `Layer.succeed` so
  // `startServer`'s internal `Layer.provide(opts.store)` plumbing
  // ALIASES into the already-built singletons rather than building a
  // second FileStore / EventRegistry. The identical-instance sharing is
  // what makes the round trip (browser POST → server → suggester →
  // server → browser subscribe) work in one process — the same
  // `Ref`, the same `PubSub`.
  const store = yield* EventStore
  const registry = yield* EventRegistry

  const handle = yield* startServer({
    store: Layer.succeed(EventStore, store),
    registry: Layer.succeed(EventRegistry, registry),
    port: PORT,
    host: "127.0.0.1",
    auth: { bearer: [token] },
  })

  console.log(`[web] stream on http://${handle.host}:${handle.port}`)
  console.log(`[web] export RXWEAVE_URL=http://${handle.host}:${handle.port}`)
  console.log(`[web] export RXWEAVE_TOKEN=${token}`)
  console.log(`[web] events log: ${STORE_PATH}`)

  // Block forever; SIGINT/SIGTERM interrupts the enclosing scope, which
  // cascades through `Effect.forkScoped(supervise(...))` and
  // `startServer`'s scope-bound Bun listener to a clean shutdown.
  yield* Effect.never
})

Effect.runFork(
  Effect.scoped(program).pipe(
    Effect.provide(AppLive),
    Effect.tapErrorCause((cause) =>
      Effect.sync(() => console.error("[web] fatal:\n" + Cause.pretty(cause))),
    ),
  ) as Effect.Effect<never, unknown, never>,
)
