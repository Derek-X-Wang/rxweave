import { Schema } from "effect"
import { EventId } from "./Ids.js"

export const Cursor = Schema.Union(
  EventId,
  Schema.Literal("earliest"),
  Schema.Literal("latest"),
)
export type Cursor = typeof Cursor.Type
