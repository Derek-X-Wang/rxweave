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
  Chunk,
  Clock,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Schedule,
  Schema,
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
import { Heartbeat, type HeartbeatConfig, RxWeaveRpc } from "@rxweave/protocol"

import {
  cachedToken,
  type TokenProvider,
  withBearerToken,
  withRefreshOn401,
} from "./Auth.js"
import { isRetryable } from "./Retry.js"
import { WatchdogTimeout } from "./Errors.js"

/**
 * Created once at module scope — `Schema.is` returns a closure and
 * constructing it per-call would be wasteful.
 */
const isHeartbeat = Schema.is(Heartbeat)

export interface CloudStoreOpts {
  /** Base URL of the cloud's `/rxweave/rpc` endpoint. */
  readonly url: string
  /**
   * Bearer token provider. Called once per HTTP request. When omitted
   * (or the provider resolves to `undefined`), outgoing requests carry
   * no `Authorization` header — used to speak to
   * `rxweave serve --no-auth` and the canvas app's embedded
   * local-auth-off server without a second adapter (spec §3.3).
   * Cloud-bound consumers should keep passing a provider; the widened
   * type is source-compatible with `() => string`.
   */
  readonly token?: TokenProvider
  /** Optional heartbeat config forwarded to the Subscribe watchdog. */
  readonly heartbeat?: HeartbeatConfig
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
    input: { readonly cursor: Cursor; readonly filter?: Filter; readonly heartbeat?: HeartbeatConfig },
  ) => Stream.Stream<EventEnvelope, unknown, never>
  readonly GetById: (input: { readonly id: EventId }) => Effect.Effect<EventEnvelope, unknown, never>
  readonly Query: (
    input: { readonly filter: Filter; readonly limit: number },
  ) => Effect.Effect<ReadonlyArray<EventEnvelope>, unknown, never>
  readonly QueryAfter: (
    input: { readonly cursor: Cursor; readonly filter: Filter; readonly limit: number },
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
  opts?: { readonly heartbeat?: HeartbeatConfig; readonly drainBeforeSubscribe?: boolean },
): Effect.Effect<EventStoreShape, never, never> =>
  Effect.gen(function* () {
    // Tracks the id of the most recently *appended* envelope. Per the
    // EventStore §5 contract, `latestCursor` is append-scoped ("id of
    // most recent append, or 'earliest' if empty") — distinct from
    // `lastDelivered`, which is subscribe-scoped (see below).
    const lastAppended = yield* Ref.make<Cursor>("earliest")
    const heartbeatConfig = opts?.heartbeat
    const drainBeforeSubscribe = opts?.drainBeforeSubscribe === true

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

      subscribe: ({ cursor, filter }) =>
        // Per-subscribe cursor state. Each call gets a fresh Ref so
        // concurrent subscribers don't clobber each other's resume
        // position. Pre-v0.5 the Ref was layer-global; that contract
        // was never observable because no caller relied on cross-
        // subscribe sharing.
        Stream.unwrapScoped(
          Effect.gen(function* () {
            // Tracks the last event id delivered by this subscriber.
            // Used by the reconnect path so `connect` resumes exclusive
            // of the most recent delivered id — the cloud cursor is
            // exclusive, so this guarantees no duplicates nor losses
            // across a reconnect.
            const lastDelivered = yield* Ref.make<Cursor>("latest")

            // undefined until first heartbeat observed; the watchdog
            // checks for non-undefined before firing.
            const lastHeartbeatAt = yield* Ref.make<number | undefined>(undefined)

            // Updates lastHeartbeatAt on every Heartbeat item.
            // Clock.currentTimeMillis is consistent with the convention used
            // elsewhere in the repo and works identically with TestClock.
            const updateWatchdog = (item: unknown): Effect.Effect<void> =>
              isHeartbeat(item)
                ? Clock.currentTimeMillis.pipe(
                    Effect.flatMap((now) => Ref.set(lastHeartbeatAt, now)),
                  )
                : Effect.void

            // Each (re)connection re-reads `lastDelivered` so a reconnect
            // after some events were already delivered resumes from the
            // most recent one, not the original cursor. Only the
            // Stream.tap below writes to `lastDelivered`.
            const connect = Effect.gen(function* () {
              const resumeFrom = yield* Ref.get(lastDelivered)
              const effectiveCursor =
                resumeFrom === "latest" ? cursor : resumeFrom

              const subscribePayload = {
                cursor: effectiveCursor,
                ...(filter !== undefined ? { filter } : {}),
                ...(heartbeatConfig !== undefined ? { heartbeat: heartbeatConfig } : {}),
              }

              const itemStream = client
                .Subscribe(subscribePayload)
                .pipe(
                  // (1) Watchdog tap — BEFORE the filter so heartbeats
                  //     (which will be filtered out next) are still seen
                  //     here to update lastHeartbeatAt.
                  Stream.tap(updateWatchdog),
                  // (2) Drop heartbeat sentinels from the user-facing stream.
                  //     They served their byte-flow purpose at the wire level
                  //     (and will arm the watchdog above); consumers of EventStore
                  //     should only see EventEnvelopes.
                  Stream.filterMap((item) => {
                    if (isHeartbeat(item)) return Option.none()
                    // Cast remains because TS does not narrow
                    // Heartbeat | EventEnvelope through a fresh-variable
                    // predicate; the union exhaustiveness is enforced by
                    // the Subscribe success schema, not by structural
                    // inference here.
                    return Option.some(item as EventEnvelope)
                  }),
                  // (3) Cursor tap runs AFTER the filter so it only sees envelopes
                  //     with valid `id` fields. Pre-v0.5 this tap was at the head
                  //     of the pipe; that placement would attempt
                  //     Ref.set(lastDelivered, undefined) for every heartbeat.
                  Stream.tap((e) => Ref.set(lastDelivered, e.id)),
                )

              if (heartbeatConfig === undefined) return itemStream

              // Watchdog: a 1Hz polling effect that fails with WatchdogTimeout
              // when too much time has elapsed since the last heartbeat.
              // Only fires when lastHeartbeatAt is non-undefined (i.e., at
              // least one heartbeat has been observed). This guards against
              // false positives on old servers (cloud-v0.2) that don't emit
              // heartbeats even when the client requests them.
              //
              // Implementation: Effect.repeat(checkEffect, spaced(1s)) runs
              // checkEffect on an infinite 1Hz schedule and only stops when
              // the effect fails. Stream.fromEffect wraps it so it emits
              // ZERO items (type never) — the stream only fails when the
              // watchdog fires. This avoids the void-emission bug of
              // repeatEffectWithSchedule (which would emit void as items).
              const idleThreshold = heartbeatConfig.intervalMs * 3
              const checkOnce: Effect.Effect<void, WatchdogTimeout> = Clock.currentTimeMillis.pipe(
                Effect.flatMap((now) =>
                  Ref.get(lastHeartbeatAt).pipe(
                    Effect.flatMap((at) =>
                      at !== undefined && now - at > idleThreshold
                        ? Effect.fail(new WatchdogTimeout({ idleMs: now - at }))
                        : Effect.void,
                    ),
                  ),
                ),
              )
              const watchdogStream: Stream.Stream<never, WatchdogTimeout, never> =
                Stream.fromEffect(
                  Effect.repeat(checkOnce, Schedule.spaced(Duration.seconds(1))).pipe(
                    // Effect.repeat on an infinite schedule only stops when the
                    // effect fails; the repeat itself succeeds with the last
                    // value (never reached). Cast to never so the stream's
                    // success channel stays as the expected never.
                    Effect.flatMap(() => Effect.never as Effect.Effect<never, WatchdogTimeout>),
                  ),
                )

              return Stream.merge(
                itemStream,
                watchdogStream as Stream.Stream<EventEnvelope, WatchdogTimeout, never>,
              )
            })

            // Live-tail stream with reconnect. The retry schedule is applied
            // here so that transient errors (including WatchdogTimeout) are
            // retried with exponential backoff. Each reconnect re-reads
            // `lastDelivered` via `connect` so it resumes exactly where it
            // left off.
            const subscribeStream = Stream.unwrap(connect).pipe(
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

            if (!drainBeforeSubscribe) return subscribeStream

            // Drain stream: pages through QueryAfter from the initial cursor
            // until an empty page is returned, emitting events in order and
            // updating lastDelivered after each event. When the drain
            // completes, lastDelivered holds the last drained event's id.
            // The live subscribeStream's connect then resumes from that id,
            // so the protocol's exclusive-cursor + snapshot-then-live
            // semantics guarantee any event appended between the drain's
            // final empty page and the Subscribe open lands in Subscribe's
            // snapshot replay — never lost, never duplicated.
            const drainStream: Stream.Stream<EventEnvelope, SubscribeError, never> =
              Stream.unfoldChunkEffect(
                cursor,
                (currentCursor) =>
                  client
                    .QueryAfter({
                      cursor: currentCursor,
                      filter: filter ?? {},
                      limit: 1024,
                    })
                    .pipe(
                      Effect.map((page) => {
                        if (page.length === 0)
                          return Option.none<readonly [Chunk.Chunk<EventEnvelope>, Cursor]>()
                        const last = page[page.length - 1]!
                        return Option.some([Chunk.fromIterable(page as ReadonlyArray<EventEnvelope>), last.id] as const)
                      }),
                    ),
              ).pipe(
                Stream.tap((e: EventEnvelope) => Ref.set(lastDelivered, e.id)),
                // Retry transient errors during drain — same policy as
                // subscribeStream. Raw error is kept during retry so
                // isRetryable can classify RpcClientError as transient;
                // SubscribeError mapping happens at the boundary after
                // the retry budget exhausts (or succeeds), matching the
                // subscribeStream pattern exactly.
                Stream.retry(
                  Schedule.exponential(Duration.millis(500), 1.5).pipe(
                    Schedule.intersect(Schedule.recurs(10)),
                    Schedule.whileInput(isRetryable),
                  ),
                ),
                Stream.mapError(() => new SubscribeError({ reason: "cloud-drain" })),
              )

            return Stream.concat(drainStream, subscribeStream)
          }),
        ),

      getById: (id) =>
        client.GetById({ id }).pipe(Effect.mapError(() => new NotFound({ id }))),

      query: (filter, limit) =>
        client
          .Query({ filter, limit })
          .pipe(Effect.mapError(() => new QueryError({ reason: "cloud-query" }))),

      // Delegates straight to the server's `QueryAfter` RPC so the
      // exclusive-cursor predicate reaches the index. The earlier
      // `Query + local filter` shortcut silently returned [] once the
      // tenant held more than `limit` events older than the cursor —
      // the server page never saw rows past the cursor at all.
      queryAfter: (cursor, filter, limit) =>
        client
          .QueryAfter({ cursor, filter, limit })
          .pipe(Effect.mapError(() => new QueryError({ reason: "cloud-query" }))),

      latestCursor: Ref.get(lastAppended),
    }
    return shape
  })

/**
 * Private core that composes the protocol stack and wires up the
 * EventStore. Called by `CloudStore.Live` (and, in Task 14, by
 * `CloudStore.LiveFromBrowser`) with their respective per-auth-mode
 * `transformClient` functions.
 *
 * Both `heartbeat` and `drainBeforeSubscribe` are forwarded to
 * `makeCloudEventStore`. CLI/Node consumers leave both as undefined;
 * browser consumers (LiveFromBrowser) set `drainBeforeSubscribe: true`
 * to page through history via QueryAfter before opening the live tail.
 */
const makeLive = (config: {
  readonly url: string
  readonly transformClient: <E, R>(
    c: HttpClient.HttpClient.With<E, R>,
  ) => HttpClient.HttpClient.With<E, R>
  readonly heartbeat?: HeartbeatConfig
  readonly drainBeforeSubscribe?: boolean
}): Layer.Layer<EventStore, never, EventRegistry> => {
  // Protocol layer: HTTP over fetch with NDJSON. The bearer token is
  // attached via `transformClient` — `withBearerToken` applies
  // `HttpClient.mapRequestEffect` so each request resolves the token
  // lazily (supports rotating credentials).
  const ProtocolLayer = RpcClient.layerProtocolHttp({
    url: config.url,
    transformClient: config.transformClient,
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
    const cloudOpts =
      config.heartbeat !== undefined || config.drainBeforeSubscribe === true
        ? {
            ...(config.heartbeat !== undefined ? { heartbeat: config.heartbeat } : {}),
            ...(config.drainBeforeSubscribe === true ? { drainBeforeSubscribe: true as const } : {}),
          }
        : undefined
    return yield* makeCloudEventStore(
      client as unknown as CloudRpcClient,
      registry,
      cloudOpts,
    )
  })

  return Layer.scoped(EventStore, StoreEffect).pipe(Layer.provide(ProtocolLayer))
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
    // Token-less mode (`opts.token` omitted): the canvas app's embedded
    // local server and `rxweave serve --no-auth` both accept unauthed
    // requests. Skip the cachedToken wrapping and the refresh-on-401
    // tap — there's nothing to cache or invalidate — and pass
    // `() => undefined` through `withBearerToken`, which no-ops the
    // header. Keeps the transform pipeline uniform so the rest of the
    // layer (protocol, serialization, RPC client) is unchanged.
    //
    // Cloud mode: TTL-cache the user-supplied provider so we call it
    // at most once per 5 minutes instead of once per RPC request —
    // saves cost for providers backed by keychains or token-exchange
    // flows. `withRefreshOn401` inspects response status and
    // invalidates the cache on 401 so the next request refetches from
    // the provider; composed AFTER `withBearerToken` so the tap sees
    // the final request/response pair.
    const transformClient = opts.token === undefined
      ? <E, R>(client: HttpClient.HttpClient.With<E, R>) =>
          withBearerToken(() => undefined)(client)
      : (() => {
          const token = cachedToken(opts.token)
          return <E, R>(client: HttpClient.HttpClient.With<E, R>) =>
            withRefreshOn401(token)(withBearerToken(token)(client))
        })()

    return makeLive({
      url: opts.url,
      transformClient,
      ...(opts.heartbeat !== undefined ? { heartbeat: opts.heartbeat } : {}),
      // drainBeforeSubscribe is intentionally omitted here — CLI/Node
      // consumers have no fetch-buffer pathology and Subscribe handles
      // replay. LiveFromBrowser (Task 14) sets the flag to true.
    })
  },
}
