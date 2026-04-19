import { Schema } from "effect"

export class LlmCallError extends Schema.TaggedError<LlmCallError>()(
  "LlmCallError",
  {
    agentId: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export class LlmToolArgsInvalid extends Schema.TaggedError<LlmToolArgsInvalid>()(
  "LlmToolArgsInvalid",
  {
    agentId: Schema.String,
    toolName: Schema.String,
    reason: Schema.String,
  },
) {}
