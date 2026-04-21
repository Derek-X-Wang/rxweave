/**
 * Unit tests for `withBearerToken` — the `HttpClient` middleware that
 * attaches `Authorization: Bearer <token>` when a token is available.
 *
 * Why these live here and not in `CloudStore.unit.test.ts`:
 * - `CloudStore.unit.test.ts` covers the layer-composition surface
 *   (Live returns a Layer, latestCursor semantics, retry classification,
 *   etc.). This file drills into the middleware's header behavior
 *   specifically — the contract that made `CloudStoreOpts.token` optional
 *   in the first place.
 *
 * The functional tests build a stub `HttpClient.HttpClient` via
 * `HttpClient.make` that records the request it received, so we can
 * assert on headers without standing up a real HTTP server.
 */
import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import { withBearerToken } from "../src/Auth.js"

/**
 * Build a stub HttpClient that records every incoming request into the
 * supplied array and returns a canned 200 OK response. The array is
 * mutated in-place by the Effect run, which is fine for single-threaded
 * test runs.
 */
const recordingClient = (sink: Array<HttpClientRequest.HttpClientRequest>) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      sink.push(request)
      return HttpClientResponse.fromWeb(
        request,
        new Response(null, { status: 200 }),
      )
    }),
  )

describe("withBearerToken", () => {
  it.effect("returns a middleware function", () =>
    Effect.sync(() => {
      const mw = withBearerToken(() => "rxk_test")
      expect(typeof mw).toBe("function")
    }),
  )

  it.effect("accepts a provider whose type includes undefined", () =>
    Effect.sync(() => {
      // Type-level contract: `() => string | undefined` must be a valid
      // TokenProvider. Pre-change the signature was `() => string`, so
      // this line would have been a compile error. Keeping the test
      // ensures we don't regress back to the stricter type.
      const mw = withBearerToken(() => undefined)
      expect(typeof mw).toBe("function")
    }),
  )

  it.effect("adds Authorization header when provider returns a string", () =>
    Effect.gen(function* () {
      const captured: Array<HttpClientRequest.HttpClientRequest> = []
      const client = withBearerToken(() => "rxk_test")(recordingClient(captured))
      yield* client.execute(HttpClientRequest.get("http://localhost/x"))
      expect(captured).toHaveLength(1)
      // `HttpClient.mapRequestEffect` uses lowercase-normalized header
      // keys (see `HttpClient/Headers`), so we read via `Headers.get`
      // which is case-insensitive.
      const auth = Headers.get(captured[0]!.headers, "authorization")
      expect(auth._tag).toBe("Some")
      if (auth._tag === "Some") expect(auth.value).toBe("Bearer rxk_test")
    }),
  )

  it.effect("adds Authorization header when provider returns a Promise<string>", () =>
    Effect.gen(function* () {
      const captured: Array<HttpClientRequest.HttpClientRequest> = []
      const client = withBearerToken(async () => "rxk_async")(
        recordingClient(captured),
      )
      yield* client.execute(HttpClientRequest.get("http://localhost/x"))
      const auth = Headers.get(captured[0]!.headers, "authorization")
      expect(auth._tag).toBe("Some")
      if (auth._tag === "Some") expect(auth.value).toBe("Bearer rxk_async")
    }),
  )

  it.effect("omits Authorization header when provider returns undefined", () =>
    Effect.gen(function* () {
      const captured: Array<HttpClientRequest.HttpClientRequest> = []
      const client = withBearerToken(() => undefined)(recordingClient(captured))
      yield* client.execute(HttpClientRequest.get("http://localhost/x"))
      expect(captured).toHaveLength(1)
      // The whole point of the task: no Authorization header when the
      // provider resolves undefined. Matches `rxweave serve --no-auth`.
      const auth = Headers.get(captured[0]!.headers, "authorization")
      expect(auth._tag).toBe("None")
    }),
  )

  it.effect("omits Authorization header when async provider resolves undefined", () =>
    Effect.gen(function* () {
      const captured: Array<HttpClientRequest.HttpClientRequest> = []
      const client = withBearerToken(async () => undefined)(
        recordingClient(captured),
      )
      yield* client.execute(HttpClientRequest.get("http://localhost/x"))
      const auth = Headers.get(captured[0]!.headers, "authorization")
      expect(auth._tag).toBe("None")
    }),
  )

  it.effect("preserves other request headers when token is present", () =>
    Effect.gen(function* () {
      const captured: Array<HttpClientRequest.HttpClientRequest> = []
      const client = withBearerToken(() => "rxk_test")(recordingClient(captured))
      yield* client.execute(
        HttpClientRequest.get("http://localhost/x").pipe(
          HttpClientRequest.setHeader("x-custom", "hello"),
        ),
      )
      const custom = Headers.get(captured[0]!.headers, "x-custom")
      expect(custom._tag).toBe("Some")
      if (custom._tag === "Some") expect(custom.value).toBe("hello")
    }),
  )

  it.effect("preserves other request headers when token is undefined", () =>
    Effect.gen(function* () {
      const captured: Array<HttpClientRequest.HttpClientRequest> = []
      const client = withBearerToken(() => undefined)(recordingClient(captured))
      yield* client.execute(
        HttpClientRequest.get("http://localhost/x").pipe(
          HttpClientRequest.setHeader("x-custom", "hello"),
        ),
      )
      const custom = Headers.get(captured[0]!.headers, "x-custom")
      expect(custom._tag).toBe("Some")
      if (custom._tag === "Some") expect(custom.value).toBe("hello")
    }),
  )
})
