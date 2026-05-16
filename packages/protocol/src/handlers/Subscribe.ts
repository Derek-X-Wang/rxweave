import { Effect, Stream } from "effect"
import { EventStore } from "@rxweave/core"
import type { Cursor, EventEnvelope, Filter } from "@rxweave/schema"
import { type HeartbeatConfig, type Heartbeat } from "../RxWeaveRpc.js"
import { makeHeartbeatStream } from "../Heartbeat.js"
import { SubscribeWireError } from "../Errors.js"

/**
 * Pure-Effect subscribe handler shared by Cloud and `@rxweave/server`.
 *
 * Delegates to the underlying `EventStore.subscribe` — whatever
 * cursor semantics + filter pushdown the store implements flow
 * through unchanged. The Convex-backed Subscribe handler in
 * `cloud/packages/backend/convex/rxweaveRpc.ts` is a polling-loop
 * specialisation; both map their source error channel to
 * `SubscribeWireError.reason`.
 *
 * When `heartbeat` is set, the handler merges a periodic Heartbeat
 * sentinel into the envelope stream via `Stream.merge`. The merged
 * heartbeat fiber is scoped together with the envelope subscription,
 * so disconnecting the subscriber tears down both sides. The
 * clamp + emit cadence live inside `makeHeartbeatStream` — see
 * `../Heartbeat.ts` for the contract.
 *
 * Backpressure note: HTTP transport in @effect/rpc has `supportsAck:
 * false`, so a slow browser reader doesn't apply backpressure to the
 * heartbeat fiber. Heartbeats accumulate at the requested cadence
 * regardless of client drain rate. This is intentional — the
 * heartbeat's job is to keep emitting *to* the client, not to be
 * paced *by* the client.
 */
export const subscribeHandler = (args: {
  readonly cursor: Cursor
  readonly filter?: Filter
  readonly heartbeat?: HeartbeatConfig
}): Stream.Stream<EventEnvelope | Heartbeat, SubscribeWireError, EventStore> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const store = yield* EventStore
      const envelopes = store
        .subscribe(
          args.filter === undefined
            ? { cursor: args.cursor }
            : { cursor: args.cursor, filter: args.filter },
        )
        .pipe(
          Stream.mapError(
            (e) => new SubscribeWireError({ reason: e.reason }),
          ),
        )

      if (args.heartbeat === undefined) {
        return envelopes as Stream.Stream<
          EventEnvelope | Heartbeat,
          SubscribeWireError,
          never
        >
      }

      return Stream.merge(envelopes, makeHeartbeatStream(args.heartbeat.intervalMs))
    }),
  )
