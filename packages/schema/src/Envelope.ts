import { Schema } from "effect"
import { EventId, ActorId } from "./Ids.js"
import { Source } from "./Source.js"

export class EventEnvelope extends Schema.Class<EventEnvelope>("EventEnvelope")({
  id: EventId,
  type: Schema.String,
  actor: ActorId,
  source: Source,
  timestamp: Schema.Number,
  causedBy: Schema.optional(Schema.Array(EventId)),
  payload: Schema.Unknown,
}) {}

// EventInput is a transit-only payload (users construct plain object
// literals, never `new EventInput(...)` — verified in the repo). Using
// Schema.Struct instead of Schema.Class means the @effect/rpc client can
// encode plain objects directly without hitting TypeLiteralClass's
// class-identity check, which rejected them at the wire boundary.
export const EventInput = Schema.Struct({
  type: Schema.String,
  actor: Schema.optional(ActorId),
  source: Schema.optional(Source),
  causedBy: Schema.optional(Schema.Array(EventId)),
  payload: Schema.Unknown,
})
export type EventInput = typeof EventInput.Type
