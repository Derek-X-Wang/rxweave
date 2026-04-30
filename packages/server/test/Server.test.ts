import { describe, expect, it, test } from "bun:test"
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
/**
 * Wire-format test: Subscribe with heartbeat emits a Heartbeat sentinel
 * inside an @effect/rpc `ResponseChunkEncoded` frame on the NDJSON stream.
 *
 * Wire format (RpcSerialization.layerNdjson, includesFraming: true):
 *   - Request body: two NDJSON lines sent as one POST body
 *       1. `{ "_tag": "Request", "id": "1", "tag": "Subscribe", "payload": {...}, "headers": [] }`
 *       2. `{ "_tag": "Eof" }`
 *   - Response stream: one JSON object per line, each a `FromServerEncoded`
 *       - Chunks: `{ "_tag": "Chunk", "requestId": "1", "values": [...] }`
 *       - Each Heartbeat value: `{ "_tag": "Heartbeat", "at": <unix-ms> }`
 *
 * The test does NOT use the @effect/rpc typed client — it inspects the raw
 * bytes off response.body so we observe the actual on-the-wire encoding.
 */
// bun:test default timeout is 5s; this test waits up to 2.5s for heartbeats
// plus server-startup overhead, so we extend to 10s via the 3rd argument.
test("Subscribe with heartbeat: server emits Heartbeat sentinel as Chunk frame on the wire", async () => {
  await Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* startServer({
        store: MemoryStore.Live,
        registry: EventRegistry.Live,
        port: 0,
        host: "127.0.0.1",
      })
      const url = `http://127.0.0.1:${handle.port}/rxweave/rpc`

      // Build the NDJSON request body: a single Request frame, newline-
      // terminated.  The server (makeProtocolWithHttpApp) appends Eof
      // automatically after it has decoded the full request body — clients
      // do NOT need to send an explicit Eof (the RpcClient.makeProtocolHttp
      // implementation confirms this: it encodes only the Request, never Eof).
      //
      // The `id` field is a string (RequestId is encoded as BigInt→string on
      // the wire per RpcMessage.RequestEncoded).  `cursor: "earliest"` matches
      // the Cursor union literal so the store streams from the beginning
      // (MemoryStore is empty — we only care about heartbeat frames, not event
      // envelopes).
      const body =
        JSON.stringify({
          _tag: "Request",
          id: "1",
          tag: "Subscribe",
          payload: {
            cursor: "earliest",
            heartbeat: { intervalMs: 1000 },
          },
          headers: [],
        }) + "\n"

      // Content-Length is required so Bun's server-side request.text() knows
      // when the body is fully received. Without it, request.text() blocks
      // indefinitely waiting for EOF on the chunked-transfer body stream.
      const bodyBytes = new TextEncoder().encode(body)
      const response = yield* Effect.promise(() =>
        fetch(url, {
          method: "POST",
          body,
          headers: {
            "Content-Type": "application/ndjson",
            "Content-Length": String(bodyBytes.length),
          },
        }),
      )

      expect(response.ok).toBe(true)
      expect(response.body).not.toBeNull()

      // Read NDJSON frames for ~2.5 seconds. We request heartbeats every
      // 1 000 ms, so we expect at least one Heartbeat in that window.
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      const frames: Array<unknown> = []
      let lineBuffer = ""
      const deadline = Date.now() + 2500

      outer: while (Date.now() < deadline) {
        const { done, value } = yield* Effect.promise(() => reader.read())
        if (done) break
        lineBuffer += decoder.decode(value, { stream: true })
        // NDJSON: each complete JSON object is terminated by "\n"
        const lines = lineBuffer.split("\n")
        // The last element is either "" or a partial line — keep it in buffer
        lineBuffer = lines.pop() ?? ""
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed.length === 0) continue
          let parsed: unknown
          try {
            parsed = JSON.parse(trimmed)
          } catch {
            throw new Error(`NDJSON frame was not valid JSON: ${trimmed}`)
          }
          frames.push(parsed)
          // Short-circuit as soon as we find what we're looking for
          const lastFrame = frames[frames.length - 1] as {
            _tag?: string
            values?: ReadonlyArray<{ _tag?: string }>
          }
          if (
            lastFrame._tag === "Chunk" &&
            Array.isArray(lastFrame.values) &&
            lastFrame.values.some((v) => v._tag === "Heartbeat")
          ) {
            break outer
          }
        }
      }

      yield* Effect.promise(() => reader.cancel())

      // Assert: at least one Chunk frame carries a Heartbeat sentinel.
      const sawHeartbeat = frames.some((frame) => {
        const f = frame as {
          _tag?: string
          values?: ReadonlyArray<{ _tag?: string }>
        }
        return (
          f._tag === "Chunk" &&
          Array.isArray(f.values) &&
          f.values.some((v) => v._tag === "Heartbeat")
        )
      })

      expect(sawHeartbeat).toBe(true)
    }),
  ).pipe(Effect.runPromise)
}, 10_000)

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
