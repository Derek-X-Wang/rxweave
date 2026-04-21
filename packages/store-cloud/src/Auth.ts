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
