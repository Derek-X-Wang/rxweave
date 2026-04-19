/**
 * `Live.Cloud` EventStore adapter — talks to the RxWeave cloud over
 * `@effect/rpc` with NDJSON serialization and a `fetch`-backed HTTP client.
 *
 * ## How the layer composes
 *
 *   EventStore (this layer)
 *     ← RpcClient.make(RxWeaveRpc)          ← produces typed client
 *       ← Protocol (RpcClient.layerProtocolHttp)
 *         ← HttpClient (FetchHttpClient.layer, wrapped with bearer-token middleware)
 *         ← RpcSerialization (layerNdjson — matches the cloud server)
 *     ← EventRegistry (consumer-provided)   ← used to compute registry digest
 *
 * We build the client *inside* the scoped layer so the underlying RPC
 * protocol's scope (mailboxes, sockets) is tied to the EventStore scope.
 *
 * ## Subscribe + reconnect
 *
 * `subscribe` returns a `Stream` that retries transient errors with
 * exponential backoff (500ms × 1.5, up to 10 retries). Because the RxWeave
 * cursor is *exclusive* (server only returns events with `id > cursor`),
 * reconnecting with the last-delivered cursor never duplicates nor loses
 * events — at-least-once delivery with client-side dedup via id ordering.
 *
 * ## Error narrowing
 *
 * RPC wire errors (`AppendWireError`, `SubscribeWireError`, etc.) are
 * re-mapped to the local-store error tags (`AppendError`, `SubscribeError`,
 * …) so `EventStore` consumers don't need to know whether they're talking
 * to memory, file, or cloud.
 */

import {
  Duration,
  Effect,
  Layer,
  Ref,
  Schedule,
  Stream,
} from "effect"
import { FetchHttpClient } from "@effect/platform"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { type Cursor, EventRegistry } from "@rxweave/schema"
import {
  AppendError,
  EventStore,
  NotFound,
  QueryError,
  SubscribeError,
} from "@rxweave/core"
import { RxWeaveRpc } from "@rxweave/protocol"

import { type TokenProvider, withBearerToken } from "./Auth.js"

export interface CloudStoreOpts {
  /** Base URL of the cloud's `/rxweave/rpc` endpoint. */
  readonly url: string
  /** Bearer token provider. Called once per HTTP request. */
  readonly token: TokenProvider
}

/**
 * `CloudStore.Live(opts)` — returns a `Layer` providing `EventStore` that
 * delegates every operation to the RxWeave cloud over HTTP/NDJSON.
 *
 * Requires `EventRegistry` from the ambient context — consumers should
 * compose with `EventRegistry.Live` (or their own implementation) before
 * running effects against the returned layer.
 */
export const CloudStore = {
  Live: (opts: CloudStoreOpts): Layer.Layer<EventStore, never, EventRegistry> => {
    // Protocol layer: HTTP over fetch with NDJSON. The bearer token is
    // attached via `transformClient` — `withBearerToken` applies
    // `HttpClient.mapRequestEffect` so each request resolves the token
    // lazily (supports rotating credentials).
    const ProtocolLayer = RpcClient.layerProtocolHttp({
      url: opts.url,
      transformClient: withBearerToken(opts.token),
    }).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(RpcSerialization.layerNdjson),
    )

    const StoreEffect = Effect.gen(function* () {
      const client = yield* RpcClient.make(RxWeaveRpc)
      const registry = yield* EventRegistry
      // Tracks the last event id delivered by `subscribe`, so reconnect
      // logic (when we add it, see below) can resume exclusive of it.
      // Today we expose it via `latestCursor` — which, per the adapter
      // contract, returns "the most recent event the store has seen". For
      // cloud that means "the most recent event delivered to this client";
      // if no stream has been subscribed, we fall back to "latest" (the
      // cloud server resolves that to its current tip).
      const lastDelivered = yield* Ref.make<Cursor>("latest")

      return EventStore.of({
        append: (events) =>
          Effect.gen(function* () {
            const digest = yield* registry.digest
            const result = yield* client.Append({ events, registryDigest: digest })
            return result
          }).pipe(
            Effect.mapError(
              (cause) => new AppendError({ reason: "cloud-append", cause }),
            ),
          ),

        subscribe: ({ cursor, filter }) => {
          // Each (re)connection re-reads `lastDelivered` so a reconnect
          // after some events were already delivered resumes from the
          // most recent one, not the original cursor. Only the
          // Stream.tap below writes to `lastDelivered` — seeding it
          // with `cursor` here would lie to `latestCursor`, which is
          // defined as "most recent event delivered" (not "initial seed").
          const connect = Effect.gen(function* () {
            const resumeFrom = yield* Ref.get(lastDelivered)
            const effectiveCursor =
              resumeFrom === "latest" ? cursor : resumeFrom
            return client
              .Subscribe(
                filter === undefined
                  ? { cursor: effectiveCursor }
                  : { cursor: effectiveCursor, filter },
              )
              .pipe(Stream.tap((e) => Ref.set(lastDelivered, e.id)))
          })

          return Stream.unwrap(connect).pipe(
            // Exponential backoff 500ms × 1.5, capped at 10 retries. On
            // retry, `connect` re-runs and picks up the latest delivered
            // cursor — exclusive cursor semantics mean no duplicates nor
            // losses across the reconnect boundary.
            Stream.retry(
              Schedule.exponential(Duration.millis(500), 1.5).pipe(
                Schedule.intersect(Schedule.recurs(10)),
              ),
            ),
            Stream.mapError(() => new SubscribeError({ reason: "cloud-subscribe" })),
          )
        },

        getById: (id) =>
          client.GetById({ id }).pipe(Effect.mapError(() => new NotFound({ id }))),

        query: (filter, limit) =>
          client
            .Query({ filter, limit })
            .pipe(Effect.mapError(() => new QueryError({ reason: "cloud-query" }))),

        // Client-side `queryAfter` — the v0.2.1 wire protocol does not (yet)
        // expose a dedicated `QueryAfter` RPC, so we fetch via `Query` and
        // filter by id locally. For the cloud adapter this is acceptable
        // because the server's Subscribe handler is the hot path for
        // cursor-paged streaming; `queryAfter` here is mostly a typecheck
        // obligation for CloudStore to conform to the EventStore tag.
        queryAfter: (cursor, filter, limit) =>
          cursor === "latest"
            ? Effect.succeed([])
            : client
                .Query({ filter, limit })
                .pipe(
                  Effect.map((rows) =>
                    cursor === "earliest"
                      ? rows
                      : rows.filter((e) => e.id > cursor),
                  ),
                  Effect.mapError(() => new QueryError({ reason: "cloud-query" })),
                ),

        latestCursor: Ref.get(lastDelivered),
      })
    })

    return Layer.scoped(EventStore, StoreEffect).pipe(Layer.provide(ProtocolLayer))
  },
}
