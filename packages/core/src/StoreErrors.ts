import { Schema } from "effect"
import { EventId } from "@rxweave/schema"

export class AppendError extends Schema.TaggedError<AppendError>()(
  "AppendError",
  { reason: Schema.String, cause: Schema.optional(Schema.Unknown) },
) {}

export class SubscribeError extends Schema.TaggedError<SubscribeError>()(
  "SubscribeError",
  { reason: Schema.String },
) {}

export class SubscriberLagged extends Schema.TaggedError<SubscriberLagged>()(
  "SubscriberLagged",
  { dropped: Schema.Number },
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { id: EventId },
) {}

export class QueryError extends Schema.TaggedError<QueryError>()(
  "QueryError",
  { reason: Schema.String },
) {}
