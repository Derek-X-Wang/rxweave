import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { EventRegistry } from "@rxweave/schema"
import { MemoryStore } from "@rxweave/store-memory"
import { startServer } from "../src/Server.js"

/**
 * End-to-end auth integration. These fire real HTTP requests at a
 * server bound on an ephemeral port, so they confirm that the
 * middleware is wired upstream of the RPC handler (a missing/invalid
 * token must short-circuit before NDJSON parsing runs — otherwise an
 * attacker could reach the handler's error path and leak information).
 *
 * We don't try to make a well-formed RPC call; any "not 401" response
 * proves auth passed. The Server smoke test already covers that a
 * successful GET/POST round-trips through Bun.
 */
describe("Server auth", () => {
  it("rejects unauthenticated POSTs with 401 when token configured", async () => {
    await Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* startServer({
          store: MemoryStore.Live,
          registry: EventRegistry.Live,
          port: 0,
          auth: { bearer: ["rxk_test_token"] },
        })
        const res = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${handle.port}/rxweave/rpc/`, {
            method: "POST",
            body: "{}\n",
          }),
        )
        expect(res.status).toBe(401)
      }),
    ).pipe(Effect.runPromise)
  })

  it("rejects invalid Bearer tokens with 401", async () => {
    await Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* startServer({
          store: MemoryStore.Live,
          registry: EventRegistry.Live,
          port: 0,
          auth: { bearer: ["rxk_test_token"] },
        })
        const res = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${handle.port}/rxweave/rpc/`, {
            method: "POST",
            headers: { Authorization: "Bearer wrong_token" },
            body: "{}\n",
          }),
        )
        expect(res.status).toBe(401)
      }),
    ).pipe(Effect.runPromise)
  })

  it("accepts matching Bearer token (not 401)", async () => {
    await Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* startServer({
          store: MemoryStore.Live,
          registry: EventRegistry.Live,
          port: 0,
          auth: { bearer: ["rxk_test_token"] },
        })
        const res = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${handle.port}/rxweave/rpc/`, {
            method: "POST",
            headers: { Authorization: "Bearer rxk_test_token" },
            body: "{}\n",
          }),
        )
        // Even if the RPC body is malformed (which `{}\n` is), we
        // should get PAST auth — any status other than 401 confirms
        // that. The handler will typically respond 4xx or 2xx-with-error
        // once it gets the request; what matters is the middleware
        // let the request through.
        expect(res.status).not.toBe(401)
      }),
    ).pipe(Effect.runPromise)
  })

  it("no-auth mode accepts requests without Authorization header", async () => {
    await Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* startServer({
          store: MemoryStore.Live,
          registry: EventRegistry.Live,
          port: 0,
          // no `auth` field -> middleware is not installed at all.
        })
        const res = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${handle.port}/rxweave/rpc/`, {
            method: "POST",
            body: "{}\n",
          }),
        )
        expect(res.status).not.toBe(401)
      }),
    ).pipe(Effect.runPromise)
  })
})
