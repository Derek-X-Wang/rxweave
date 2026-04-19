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

export class EventInput extends Schema.Class<EventInput>("EventInput")({
  type: Schema.String,
  actor: Schema.optional(ActorId),
  source: Schema.optional(Source),
  causedBy: Schema.optional(Schema.Array(EventId)),
  payload: Schema.Unknown,
}) {}
