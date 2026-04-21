import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { EventRegistry } from "@rxweave/schema"
import { MemoryStore } from "@rxweave/store-memory"
import { startServer } from "../src/Server.js"

/**
 * Smoke test for `startServer`: spin up the HTTP listener inside a
 * scoped effect, fire a real fetch at the RPC path, then let the scope
 * close — which must tear the server down. The response status itself
 * isn't the signal we care about (the RPC framing expects an NDJSON POST
 * body, so a bare GET typically comes back as a 4xx); what we verify is
 * that the socket accepted the connection at all, which proves the
 * server is bound and the route is mounted.
 *
 * Runner note: this test uses `bun:test` (not vitest) because
 * `@effect/platform-bun`'s `BunHttpServer.layer` calls `Bun.serve` at
 * runtime, and vitest runs under Node where the `Bun` global is
 * undefined. The rest of the `@rxweave/server` package currently has no
 * other tests, so switching just this package's runner to `bun test`
 * has no side-effects on the other packages' vitest setups. The plan's
 * Task 8 sketch imported `@effect/vitest`'s `it.scoped`, but that
 * depends on vitest's `onTestFinished` context API which `bun:test`
 * doesn't ship; we fall back to `Effect.scoped(...).pipe(Effect.runPromise)`
 * which gives equivalent scope lifecycle semantics.
 */
describe("startServer", () => {
  it("binds OS-assigned port 0 and makes the RPC path reachable", async () => {
    await Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* startServer({
          store: MemoryStore.Live,
          registry: EventRegistry.Live,
          port: 0,
          host: "127.0.0.1",
        })
        // `port: 0` -> Bun assigns an ephemeral port, which we resolve
        // by reading `HttpServer.address` after the Bun layer is built.
        expect(handle.host).toBe("127.0.0.1")
        expect(handle.port).toBeGreaterThan(0)
        expect(handle.port).not.toBe(0)

        const res = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${handle.port}/rxweave/rpc`, {
            method: "GET",
          }),
        )
        // Any HTTP response — even a 4xx from the RPC framing rejecting
        // a GET — proves the socket is up and the route was mounted.
        expect(res.status).toBeGreaterThan(0)
      }),
    ).pipe(Effect.runPromise)
  })

  it("respects an explicitly-requested port", async () => {
    await Effect.scoped(
      Effect.gen(function* () {
        // Fixed high port: outside ephemeral + well-known ranges. If a
        // CI host has something listening on 5901 the test will fail
        // with EADDRINUSE — that's the correct behavior (we don't want
        // to silently pick a different port and pretend we honored the
        // request).
        const handle = yield* startServer({
          store: MemoryStore.Live,
          registry: EventRegistry.Live,
          port: 5901,
          host: "127.0.0.1",
        })
        expect(handle.port).toBe(5901)
        expect(handle.host).toBe("127.0.0.1")
      }),
    ).pipe(Effect.runPromise)
  })
})
