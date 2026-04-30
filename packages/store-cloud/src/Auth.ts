/**
 * Authentication helpers for `@rxweave/store-cloud`.
 *
 * The cloud requires a Bearer token on every RPC request. We accept any
 * provider that returns a string (sync or async) so callers can pull from
 * env vars, keychains, token-exchange flows, or rotating API keys without
 * the store having to care.
 */

import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import { AuthFailed } from "./Errors.js"

/**
 * Token provider contract: a nullary function returning a string,
 * `undefined`, or a promise of either. Called once per HTTP request so
 * the provider can refresh under the hood (e.g. exchange an expiring
 * token).
 *
 * `undefined` is how callers opt out of the Authorization header —
 * used by `@rxweave/server --no-auth` and the canvas app's embedded
 * local server, where the browser talks to `localhost` without a
 * bearer token. Existing cloud consumers always return a string and
 * are source-compatible with this widened type (§3.3).
 */
export type TokenProvider = () => string | undefined | Promise<string | undefined>

/**
 * Cached token provider: the same shape as `TokenProvider`, plus an
 * `invalidate()` method that clears the cache so the very next call
 * re-fetches from the underlying provider.
 *
 * The middleware wiring in `CloudStore.Live` holds a reference to this
 * object so it can invalidate on response-side signals (e.g. a 401 seen
 * by a `tap` on the HttpClient). Returns `string | undefined` to match
 * the widened `TokenProvider` — a provider that signals "no auth" is
 * still a valid input; the middleware checks for `undefined` downstream.
 */
export interface CachedTokenProvider {
  (): Promise<string | undefined>
  readonly invalidate: () => void
}

/**
 * Wrap a `TokenProvider` in a time-to-live cache.
 *
 * Rationale: without this, `HttpClient.mapRequestEffect` calls
 * `provider()` on every RPC request — which for callers that pull from
 * a file, a keychain, or a token-exchange flow can be measurable
 * overhead per call. In practice tokens are valid for minutes to hours,
 * so a 5-minute TTL is indistinguishable from "fetch on every request"
 * for freshness purposes but eliminates all but one lookup per TTL
 * window.
 *
 * Concurrency: if the TTL has expired and two requests race to refresh,
 * they both see an expired cache and both call the underlying provider.
 * That's tolerable — no correctness bug, just a small duplicate-fetch
 * window. Adding a lock would be the tidy fix but it's not worth the
 * complexity for a helper that's called ~once per N minutes.
 *
 * 401 invalidation: `@effect/platform`'s `HttpClient.tap` runs after a
 * successful request (i.e. the HTTP layer saw a 4xx/5xx as "success"
 * because the request completed; no network error). In `CloudStore.Live`
 * we compose a `HttpClient.tap` that inspects `response.status === 401`
 * and calls `invalidate()` — the FAILED request doesn't retry with a
 * fresh token automatically, but the NEXT request will fetch from the
 * provider rather than serve a stale value. Good-enough 401 handling
 * for the v0.2.1 scope; a full post-401-retry loop is a follow-up.
 */
export const cachedToken = (
  provider: TokenProvider,
  ttlMs = 300_000,
): CachedTokenProvider => {
  // `hasCached` is a separate flag rather than overloading the value
  // sentinel because `undefined` is now a valid cached result (token-
  // less mode). Before, `cached !== null` was enough; now we must
  // distinguish "cache empty" from "cache holds undefined".
  let hasCached = false
  let cached: string | undefined = undefined
  let expiresAt = 0

  const get = async (): Promise<string | undefined> => {
    const now = Date.now()
    if (hasCached && now < expiresAt) return cached
    const fresh = await provider()
    cached = fresh
    hasCached = true
    expiresAt = now + ttlMs
    return fresh
  }

  const wrapped = get as CachedTokenProvider
  ;(wrapped as { invalidate: () => void }).invalidate = () => {
    hasCached = false
    cached = undefined
    expiresAt = 0
  }
  return wrapped
}

/**
 * Resolve a TokenProvider to an Effect yielding the bearer string (or
 * `undefined` for token-less mode). Wraps the possibly-async call in
 * `Effect.promise` so failures surface as defects rather than typed
 * errors — auth failures will manifest as 401 from the cloud, not as
 * thrown exceptions here.
 */
export const resolveToken = (
  provider: TokenProvider,
): Effect.Effect<string | undefined> =>
  Effect.promise(async () => provider())

/**
 * Wrap an `HttpClient.HttpClient` so outgoing requests conditionally
 * carry an `Authorization: Bearer <token>` header — when, and only
 * when, the provider resolves to a defined string. Token is resolved
 * per-request via `provider()`, so rotating credentials work
 * transparently. For provider implementations with non-trivial cost
 * (file reads, keychain lookups, token exchange), wrap with
 * `cachedToken(...)` first — the signature accepts any `TokenProvider`.
 *
 * Token-less mode: when `provider()` returns (or resolves to)
 * `undefined`, the request passes through unmodified. This is how
 * `CloudStore.Live({ url })` (no `token` key) or an explicit
 * `token: () => undefined` speaks to `rxweave serve --no-auth` and the
 * canvas app's embedded local-auth-off server — one adapter, both
 * modes (spec §3.3).
 *
 * This is the middleware passed to `RpcClient.layerProtocolHttp`'s
 * `transformClient` option — its `<E, R>(c) => HttpClient.With<E, R>`
 * signature matches what `mapRequestEffect` produces.
 */
export const withBearerToken =
  (provider: TokenProvider) =>
  <E, R>(client: HttpClient.HttpClient.With<E, R>): HttpClient.HttpClient.With<E, R> =>
    HttpClient.mapRequestEffect(client, (req) =>
      resolveToken(provider).pipe(
        Effect.map((token) =>
          token === undefined
            ? req
            : HttpClientRequest.setHeader(req, "authorization", `Bearer ${token}`),
        ),
      ),
    )

/**
 * Middleware: on a 401 response, invalidate the cached token so the
 * next request re-fetches from the underlying provider. Composes with
 * `withBearerToken(token)` — apply this one second so the `tap` sees
 * the response from the full middleware stack.
 *
 * Does NOT retry the failed request (that's the retry-schedule's job);
 * this only guarantees the next attempt uses a fresh token.
 */
export const withRefreshOn401 =
  (token: CachedTokenProvider) =>
  <E, R>(client: HttpClient.HttpClient.With<E, R>): HttpClient.HttpClient.With<E, R> =>
    HttpClient.tap(client, (response) =>
      response.status === 401
        ? Effect.sync(() => token.invalidate())
        : Effect.void,
    )

// Re-export AuthFailed so callers can import it from Auth.ts
export { AuthFailed } from "./Errors.js"

/**
 * Browser auth strategy: bootstrap a bearer token via fetch to a
 * server-provided endpoint (typically `/rxweave/session-token`),
 * cache it (TTL via cachedToken), and on 401 invalidate-AND-retry the
 * failed request once. After a second 401, the request fails with an
 * AuthFailed *defect* — caught at the application boundary via
 * `Effect.catchAllDefect` or surfaced as an unhandled error via the
 * runtime's defect handler.
 *
 * Using `Effect.die` (defect) rather than `Effect.fail` (typed error)
 * keeps the return type as `HttpClient.With<E, R>` — same error channel
 * as the input — satisfying `RpcClient.layerProtocolHttp`'s
 * `transformClient` constraint `<E, R>(c) => HttpClient.With<E, R>`.
 * AuthFailed is still a `Schema.TaggedError`, so its typed structure is
 * preserved through the Cause for callers that use `catchAllDefect`.
 *
 * Composition relies on `withBearerToken(cached)` to attach the header
 * via mapRequestEffect — that wrapper re-resolves the cache on every
 * request, so calling `cached.invalidate()` then re-issuing through
 * the same wrapped client is sufficient to send a fresh token.
 *
 * The retry layer uses `HttpClient.transform` (available in
 * @effect/platform ^0.96) which wraps the existing client's execute
 * effect — on 401 we invalidate the cache and re-execute the same
 * request through `withAuth` so the second send gets a fresh token via
 * `mapRequestEffect`. Retry budget is exactly one extra send per
 * request — no exponential schedule, no backoff.
 */
export const sessionTokenFetch = (opts: {
  readonly origin: string
  readonly tokenPath: string
}): {
  readonly transformClient: <E, R>(
    c: HttpClient.HttpClient.With<E, R>,
  ) => HttpClient.HttpClient.With<E, R>
} => {
  const tokenUrl = `${opts.origin}${opts.tokenPath}`

  const provider: TokenProvider = async () => {
    const r = await fetch(tokenUrl)
    if (!r.ok) {
      throw new Error(`session-token fetch failed: ${r.status}`)
    }
    // The endpoint defined by `@rxweave/server`'s `sessionTokenRouteLayer`
    // returns `{ token: string | null }` — JSON, not a plain string. Parse
    // and extract `.token`. `null` means the server is in no-auth mode;
    // we surface it as `undefined` so `withBearerToken` skips the header
    // (matching the existing token-less mode in `CloudStoreOpts`).
    const body = await r.text()
    try {
      const parsed = JSON.parse(body) as { readonly token?: string | null }
      return parsed.token ?? undefined
    } catch {
      throw new Error(`session-token response was not JSON: ${body.slice(0, 80)}`)
    }
  }
  const cached = cachedToken(provider)

  return {
    transformClient: <E, R>(
      client: HttpClient.HttpClient.With<E, R>,
    ): HttpClient.HttpClient.With<E, R> => {
      const withAuth = withBearerToken(cached)(client)
      // HttpClient.transform wraps the client's execute: it receives
      // (firstEffect, request) where firstEffect is the Effect that
      // will execute the first request. We flatMap it — on 401 we
      // invalidate the cache and call withAuth.execute(request) again
      // so the second send resolves a fresh token via mapRequestEffect.
      return HttpClient.transform(
        withAuth,
        (firstEffect, request) =>
          Effect.flatMap(firstEffect, (first) => {
            if (first.status !== 401) return Effect.succeed(first)
            cached.invalidate()
            return Effect.flatMap(withAuth.execute(request), (second) => {
              if (second.status === 401) {
                return Effect.die(
                  new AuthFailed({ cause: "401 after token refresh" }),
                )
              }
              return Effect.succeed(second)
            })
          }),
      )
    },
  }
}
