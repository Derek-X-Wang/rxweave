import { Effect, Layer } from "effect"
import { EventRegistry } from "@rxweave/schema"
import { MemoryStore } from "@rxweave/store-memory"
import { CloudStore } from "@rxweave/store-cloud"
import { runConformance } from "@rxweave/core/testing"
import { startServer } from "../src/Server.js"

/**
 * Task 11 / spec §11 convergence gate.
 *
 * `@rxweave/server` must pass the same 10-case conformance harness that
 * `store-memory`, `store-file`, and `store-cloud` already pass. This proves
 * the shared handlers from `@rxweave/protocol/handlers` produce identical
 * `EventStore` semantics regardless of which backend the server wraps.
 *
 * Shape of the run:
 *   - Per case: spin up `@rxweave/server` on an OS-ephemeral port bound to
 *     loopback, backed by a *fresh* `MemoryStore.Live`.
 *   - Build a `CloudStore.Live` client pointed at `http://127.0.0.1:<port>
 *     /rxweave/rpc` with no bearer token (embedded no-auth mode — matches
 *     the `rxweave serve --no-auth` / canvas-embedded path).
 *   - Hand the resulting `EventStore` layer to `runConformance`. The
 *     harness drives the 10 semantic cases over real HTTP/NDJSON.
 *
 * The `fresh` factory creates a new server+client per case so state
 * doesn't leak across tests — equivalent to `store-memory`'s per-case
 * construction, just with an HTTP round-trip in the middle.
 *
 * ## Runner: vitest under Bun
 *
 * `runConformance` is tightly coupled to `vitest` + `@effect/vitest`
 * (uses `describe`, `it.effect`, `it.scopedLive`, `beforeEach`). The
 * harness is the authoritative convergence definition per the spec so
 * we don't fork it. `BunHttpServer.layer` in `startServer` calls
 * `Bun.serve()` which is undefined under Node's vitest — so this file
 * must run via `bun --bun vitest run` (see the server package's
 * `test:conformance` script) to have both `Bun.serve` *and* vitest's
 * runner context available simultaneously.
 *
 * The file is named `Conformance.vitest.ts` (not `.test.ts`) so
 * `bun test` — which drives the other `@rxweave/server` tests (Server,
 * Auth, AuthIntegration, SessionToken) — does NOT auto-discover it.
 * That keeps the default `bun test` invocation fast and avoids trying
 * to import `vitest` inside `bun test`'s harness. Running
 * `bun run test` in this package now runs BOTH: first `bun test` for
 * the bun-native tests, then `vitest run` (under Bun) for this file.
 */

const makeLayer = () =>
  Layer.unwrapScoped(
    Effect.gen(function* () {
      const handle = yield* startServer({
        store: MemoryStore.Live,
        registry: EventRegistry.Live,
        port: 0,
        host: "127.0.0.1",
      })
      // Client layer: no-auth (token omitted) because the server above
      // was started without `auth` — the embedded-mode handshake the
      // canvas app and `rxweave serve --no-auth` both use. Providing
      // `EventRegistry.Live` satisfies the registry dependency inside
      // `CloudStore.Live` (used to compute the registry digest on
      // every `append`).
      return CloudStore.Live({
        url: `http://127.0.0.1:${handle.port}/rxweave/rpc`,
      }).pipe(Layer.provide(EventRegistry.Live))
    }),
  )

runConformance({
  name: "@rxweave/server via CloudStore",
  // `layer`: the harness's default one-shot; `fresh` is the per-case
  // factory. For `MemoryStore`-backed servers we want every case to get
  // its own store (no cross-test state), so both point at `makeLayer`.
  layer: makeLayer(),
  fresh: makeLayer,
})
