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
 * `subscribe` returns a `Stream` that retries *transient* errors with
 * exponential backoff (500ms × 1.5, up to 10 retries). Permanent errors
 * (NotFound, RegistryWireError, unknown shapes) short-circuit to
 * `Stream.fail` so we don't burn the retry budget on a schema mismatch.
 * Because the RxWeave cursor is *exclusive* (server only returns events
 * with `id > cursor`), reconnecting with the last-delivered cursor never
 * duplicates nor loses events — at-least-once delivery with client-side
 * dedup via id ordering.
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
import { FetchHttpClient, type HttpClient } from "@effect/platform"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { type Cursor, EventRegistry, type EventEnvelope, type EventInput, type Filter, type EventId } from "@rxweave/schema"
import {
  AppendError,
  EventStore,
  type EventStoreShape,
  NotFound,
  QueryError,
  SubscribeError,
} from "@rxweave/core"
import { RxWeaveRpc } from "@rxweave/protocol"

import {
  cachedToken,
  type TokenProvider,
  withBearerToken,
  withRefreshOn401,
} from "./Auth.js"
import { isRetryable } from "./Retry.js"

export interface CloudStoreOpts {
  /** Base URL of the cloud's `/rxweave/rpc` endpoint. */
  readonly url: string
  /** Bearer token provider. Called once per HTTP request. */
  readonly token: TokenProvider
}

/**
 * Structural subset of `RpcClient.make(RxWeaveRpc)` that the store consumes.
 *
 * Exposed (and typed structurally) so tests can stub the client without
 * standing up the HTTP/NDJSON protocol layer. Kept internal to this
 * module — the public surface is `CloudStore.Live` and the re-exports
 * from `index.ts`.
 */
export interface CloudRpcClient {
  readonly Append: (
    input: { readonly events: ReadonlyArray<EventInput>; readonly registryDigest: string },
  ) => Effect.Effect<ReadonlyArray<EventEnvelope>, unknown, never>
  readonly Subscribe: (
    input: { readonly cursor: Cursor; readonly filter?: Filter },
  ) => Stream.Stream<EventEnvelope, unknown, never>
  readonly GetById: (input: { readonly id: EventId }) => Effect.Effect<EventEnvelope, unknown, never>
  readonly Query: (
    input: { readonly filter: Filter; readonly limit: number },
  ) => Effect.Effect<ReadonlyArray<EventEnvelope>, unknown, never>
}

/**
 * Build the EventStore surface from an already-constructed RPC client.
 *
 * Exported (internally) so unit tests can exercise the append/subscribe
 * bookkeeping — `latestCursor` updates, retry classification — without
 * needing to round-trip through HTTP/NDJSON. The live path wraps this
 * in `Layer.scoped` with the real RPC client below.
 */
export const makeCloudEventStore = (
  client: CloudRpcClient,
  registry: EventRegistry["Type"],
): Effect.Effect<EventStoreShape, never, never> =>
  Effect.gen(function* () {
    // Tracks the last event id delivered by `subscribe`. Used by the
    // reconnect path so `connect` resumes exclusive of the most
    // recent delivered id — the cloud cursor is exclusive, so this
    // guarantees no duplicates nor losses across a reconnect.
    const lastDelivered = yield* Ref.make<Cursor>("latest")
    // Tracks the id of the most recently *appended* envelope. Per the
    // EventStore §5 contract, `latestCursor` is append-scoped ("id of
    // most recent append, or 'earliest' if empty") — distinct from
    // `lastDelivered`, which is subscribe-scoped.
    const lastAppended = yield* Ref.make<Cursor>("earliest")

    const shape: EventStoreShape = {
      append: (events) =>
        Effect.gen(function* () {
          const digest = yield* registry.digest
          const result = yield* client.Append({ events, registryDigest: digest })
          // Record the tip of the batch so `latestCursor` reflects the
          // append we just did. No-op on empty batches (server would
          // return []) — preserves the `"earliest"` sentinel.
          const tip = result.at(-1)
          if (tip !== undefined) {
            yield* Ref.set(lastAppended, tip.id)
          }
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
        // Stream.tap below writes to `lastDelivered`.
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
          // Exponential backoff 500ms × 1.5, capped at 10 retries, but
          // GATED by `isRetryable` so permanent errors (NotFound,
          // RegistryWireError, unknown) short-circuit to Stream.fail
          // instead of consuming the retry budget.
          Stream.retry(
            Schedule.exponential(Duration.millis(500), 1.5).pipe(
              Schedule.intersect(Schedule.recurs(10)),
              Schedule.whileInput(isRetryable),
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

      latestCursor: Ref.get(lastAppended),
    }
    return shape
  })

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
    // TTL-cache the user-supplied token provider so we call it at most
    // once per 5 minutes instead of once per RPC request — saves cost
    // for providers backed by keychains or token-exchange flows.
    // `withRefreshOn401` inspects response status and invalidates the
    // cache on 401 so the next request refetches from the provider;
    // composed AFTER `withBearerToken` so the tap sees the final
    // request/response pair.
    const token = cachedToken(opts.token)
    // Protocol layer: HTTP over fetch with NDJSON. The bearer token is
    // attached via `transformClient` — `withBearerToken` applies
    // `HttpClient.mapRequestEffect` so each request resolves the token
    // lazily (supports rotating credentials).
    const ProtocolLayer = RpcClient.layerProtocolHttp({
      url: opts.url,
      transformClient: <E, R>(client: HttpClient.HttpClient.With<E, R>) =>
        withRefreshOn401(token)(withBearerToken(token)(client)),
    }).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(RpcSerialization.layerNdjson),
    )

    const StoreEffect = Effect.gen(function* () {
      const client = yield* RpcClient.make(RxWeaveRpc)
      const registry = yield* EventRegistry
      // `RpcClient.make(RxWeaveRpc)` returns a client whose error
      // channels are fully typed against the wire errors; the
      // structural `CloudRpcClient` surface erases those into
      // `unknown` (they're all re-mapped into `AppendError` /
      // `SubscribeError` / etc. inside `makeCloudEventStore`).
      return yield* makeCloudEventStore(
        client as unknown as CloudRpcClient,
        registry,
      )
    })

    return Layer.scoped(EventStore, StoreEffect).pipe(Layer.provide(ProtocolLayer))
  },
}
