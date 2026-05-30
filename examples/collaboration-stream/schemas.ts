import { Schema } from "effect"
import { defineEvent } from "@rxweave/schema"

// A human (or their tool) posts a request to the shared stream.
export const RequestPosted = defineEvent(
  "request.posted",
  Schema.Struct({ text: Schema.String }),
)

// An agent's reply — a first-class event on the same stream, with the same
// actor / causedBy / source fields a human event has.
export const ResponsePosted = defineEvent(
  "response.posted",
  Schema.Struct({ requestId: Schema.String, text: Schema.String }),
)
