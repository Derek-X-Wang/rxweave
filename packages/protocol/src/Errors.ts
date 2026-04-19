import { Schema } from "effect"

export class AppendWireError extends Schema.TaggedError<AppendWireError>()(
  "AppendWireError",
  {
    reason: Schema.String,
    registryOutOfDate: Schema.optional(Schema.Array(Schema.String)),
  },
) {}

export class SubscribeWireError extends Schema.TaggedError<SubscribeWireError>()(
  "SubscribeWireError",
  { reason: Schema.String, lagged: Schema.optional(Schema.Boolean) },
) {}

export class NotFoundWireError extends Schema.TaggedError<NotFoundWireError>()(
  "NotFoundWireError",
  { id: Schema.String },
) {}

export class QueryWireError extends Schema.TaggedError<QueryWireError>()(
  "QueryWireError",
  { reason: Schema.String },
) {}

export class RegistryWireError extends Schema.TaggedError<RegistryWireError>()(
  "RegistryWireError",
  { reason: Schema.String },
) {}
