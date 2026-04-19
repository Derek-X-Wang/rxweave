import { Rpc, RpcGroup } from "@effect/rpc"
import { Schema } from "effect"
import {
  Cursor,
  EventDefWire,
  EventEnvelope,
  EventId,
  EventInput,
  Filter,
} from "@rxweave/schema"
import {
  AppendWireError,
  NotFoundWireError,
  QueryWireError,
  RegistryWireError,
  SubscribeWireError,
} from "./Errors.js"

export class RxWeaveRpc extends RpcGroup.make(
  Rpc.make("Append", {
    payload: Schema.Struct({
      events: Schema.Array(EventInput),
      registryDigest: Schema.String,
    }),
    success: Schema.Array(EventEnvelope),
    error: AppendWireError,
  }),
  Rpc.make("Subscribe", {
    payload: Schema.Struct({
      cursor: Cursor,
      filter: Schema.optional(Filter),
    }),
    success: EventEnvelope,
    stream: true,
    error: SubscribeWireError,
  }),
  Rpc.make("GetById", {
    payload: Schema.Struct({ id: EventId }),
    success: EventEnvelope,
    error: NotFoundWireError,
  }),
  Rpc.make("Query", {
    payload: Schema.Struct({ filter: Filter, limit: Schema.Number }),
    success: Schema.Array(EventEnvelope),
    error: QueryWireError,
  }),
  Rpc.make("QueryAfter", {
    // Server-side cursor-paged query — mirrors `Query` but pushes the
    // exclusive-cursor predicate to the index instead of local-filtering.
    // Introduced for v0.2.1: CloudStore's client-side `queryAfter` was
    // doing `Query + local filter`, which silently returned [] once the
    // tenant held more than `limit` events older than the cursor (the
    // server page never reached rows past the cursor). See `queryEventsAfter`
    // in cloud/convex/rxweave.ts for the server-side index predicate.
    payload: Schema.Struct({
      cursor: Cursor,
      filter: Filter,
      limit: Schema.Number,
    }),
    success: Schema.Array(EventEnvelope),
    error: QueryWireError,
  }),
  Rpc.make("RegistrySyncDiff", {
    payload: Schema.Struct({ clientDigest: Schema.String }),
    success: Schema.Struct({
      upToDate: Schema.Boolean,
      missingOnClient: Schema.Array(EventDefWire),
      missingOnServer: Schema.Array(Schema.String),
    }),
    error: RegistryWireError,
  }),
  Rpc.make("RegistryPush", {
    payload: Schema.Struct({ defs: Schema.Array(EventDefWire) }),
    success: Schema.Void,
    error: RegistryWireError,
  }),
) {}
