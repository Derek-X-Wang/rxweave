import { Schema } from "effect"

export const EventId = Schema.String.pipe(
  Schema.pattern(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  Schema.brand("EventId"),
)
export type EventId = typeof EventId.Type

export const ActorId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("ActorId"),
)
export type ActorId = typeof ActorId.Type
