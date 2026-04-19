import { Schema } from "effect"

export const Source = Schema.Literal("canvas", "agent", "system", "voice", "cli", "cloud")
export type Source = typeof Source.Type
