import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { EventRegistry } from "@rxweave/schema"
import { MemoryStore } from "@rxweave/store-memory"
import { startServer } from "../src/Server.js"

/**
 * Task 10: `GET /rxweave/session-token` is the browser-side
 * bootstrap endpoint. The web adapter can't read the filesystem
 * (`.rxweave/serve.token`), and we refuse to bake tokens into the
 * Vite bundle — so the server hands the token to same-origin
 * loopback clients over HTTP as the one unauthenticated endpoint.
 *
 * Spec §3.3: the trust boundary already lives at "can you hit
 * 127.0.0.1?" — any process with that reach could read
 * `.rxweave/serve.token` from disk anyway. Echoing the same token
 * over HTTP to same-origin clients therefore doesn't widen the
 * attack surface.
 *
 * These tests pin three properties:
 *   1. When auth is configured, the endpoint returns the active token.
 *   2. When auth is NOT configured, the endpoint returns `{ token: null }`.
 *   3. The endpoint itself does NOT require an Authorization header
 *      (chicken-and-egg — the caller is fetching the token because
 *      they don't have it yet).
 */
describe("GET /rxweave/session-token", () => {
  it("returns the current bearer token when auth is on", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* startServer({
            store: MemoryStore.Live,
            registry: EventRegistry.Live,
            port: 0,
            auth: { bearer: ["rxk_test_session_abc"] },
          })
          const res = yield* Effect.promise(() =>
            fetch(`http://127.0.0.1:${handle.port}/rxweave/session-token`),
          )
          expect(res.status).toBe(200)
          const contentType = res.headers.get("content-type") ?? ""
          expect(contentType).toContain("application/json")
          const json = (yield* Effect.promise(() => res.json())) as {
            token: string | null
          }
          expect(json.token).toBe("rxk_test_session_abc")
        }),
      ),
    )
  })

  it("returns { token: null } when no auth is configured", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* startServer({
            store: MemoryStore.Live,
            registry: EventRegistry.Live,
            port: 0,
          })
          const res = yield* Effect.promise(() =>
            fetch(`http://127.0.0.1:${handle.port}/rxweave/session-token`),
          )
          expect(res.status).toBe(200)
          const json = (yield* Effect.promise(() => res.json())) as {
            token: string | null
          }
          expect(json.token).toBeNull()
        }),
      ),
    )
  })

  it("session-token endpoint itself does NOT require auth", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* startServer({
            store: MemoryStore.Live,
            registry: EventRegistry.Live,
            port: 0,
            auth: { bearer: ["rxk_test_session_abc"] },
          })
          // Intentionally NO Authorization header — the whole point
          // of this endpoint is to serve the token to clients that
          // don't have it yet.
          const res = yield* Effect.promise(() =>
            fetch(`http://127.0.0.1:${handle.port}/rxweave/session-token`),
          )
          // Critically: not 401. If this fails with 401 it means the
          // middleware's path-bypass didn't take effect and the
          // browser bootstrap is broken.
          expect(res.status).toBe(200)
        }),
      ),
    )
  })
})
