import { Effect, JSONSchema, Schema } from "effect"
import type { EventEnvelope, EventInput } from "@rxweave/schema"

export interface LlmToolDef<A, I = A> {
  readonly description: string
  readonly schema: Schema.Schema<A, I>
  readonly handler: (
    args: A,
    event: EventEnvelope,
  ) => Effect.Effect<ReadonlyArray<EventInput> | void, unknown, never>
}

export const tool = <A, I = A>(def: LlmToolDef<A, I>): LlmToolDef<A, I> => def

// Effect Schema → JSON Schema for AI SDK. `JSONSchema.make` throws on
// schemas it can't represent (e.g. with transforms that have no static
// JSON form) — we call this eagerly at `defineLlmAgent` time so bad
// schemas fail at module load, not inside the hot per-event path.
export const toJsonSchema = (schema: Schema.Schema<any, any>): object =>
  JSONSchema.make(schema) as unknown as object
