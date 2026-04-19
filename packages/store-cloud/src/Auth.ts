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
 * Token provider contract: a nullary function returning a string or a
 * promise of a string. Called once per HTTP request so the provider can
 * refresh under the hood (e.g. exchange an expiring token).
 */
export type TokenProvider = () => string | Promise<string>

/**
 * Resolve a TokenProvider to an Effect yielding the bearer string.
 * Wraps the possibly-async call in `Effect.promise` so failures surface
 * as defects rather than typed errors — auth failures will manifest as
 * 401 from the cloud, not as thrown exceptions here.
 */
export const resolveToken = (provider: TokenProvider): Effect.Effect<string> =>
  Effect.promise(async () => provider())

/**
 * Wrap an `HttpClient.HttpClient` so every outgoing request carries an
 * `Authorization: Bearer <token>` header. Token is resolved per-request
 * via `provider()`, so rotating credentials work transparently.
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
          HttpClientRequest.setHeader(req, "authorization", `Bearer ${token}`),
        ),
      ),
    )
