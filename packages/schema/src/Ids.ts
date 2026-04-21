import { Schema } from "effect"

export const EventId = Schema.String.pipe(
  Schema.pattern(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  Schema.brand("EventId"),
)
export type EventId = typeof EventId.Type

// ActorId: free-form string today; a single optional `:` separator
// is reserved for the future <user-id>:<agent-type> convention when
// multi-user identity lands (spec §5.1 / §5.2). Alphanum plus
// `_`, `.`, `-` keeps the character set tight enough that past
// actors stay distinguishable once the convention formalises.
const ACTOR_PATTERN = /^[a-zA-Z0-9_.-]+(:[a-zA-Z0-9_.-]+)?$/

export const ActorId = Schema.String.pipe(
  Schema.pattern(ACTOR_PATTERN),
  Schema.brand("ActorId"),
)
export type ActorId = typeof ActorId.Type
