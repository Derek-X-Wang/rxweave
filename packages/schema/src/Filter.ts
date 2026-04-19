import { Schema } from "effect"
import { ActorId } from "./Ids.js"
import { Source } from "./Source.js"

export const Filter = Schema.Struct({
  types:   Schema.optional(Schema.Array(Schema.String)),
  actors:  Schema.optional(Schema.Array(ActorId)),
  sources: Schema.optional(Schema.Array(Source)),
  since:   Schema.optional(Schema.Number),
})
export type Filter = typeof Filter.Type
