import { Duration, Effect, Schedule, Schema } from "effect"
import type { LanguageModel } from "ai"
import { generateText, jsonSchema, stepCountIs, tool as aiTool } from "ai"
import { defineAgent, type AgentDef } from "@rxweave/runtime"
import type { EventEnvelope, EventInput, Filter } from "@rxweave/schema"
import { LlmCallError } from "./Errors.js"
import { type LlmToolDef, toJsonSchema } from "./Tool.js"

export interface LlmAgentDef {
  readonly id: string
  readonly on: Filter
  readonly model: LanguageModel
  readonly systemPrompt: string | ((event: EventEnvelope) => string)
  readonly tools: Record<string, LlmToolDef<any, any>>
  readonly formatPrompt?: (event: EventEnvelope) => string
  readonly stopAfterSteps?: number
  readonly retry?: Schedule.Schedule<unknown, unknown>
  readonly restart?: Schedule.Schedule<unknown, unknown>
  readonly concurrency?: "serial" | { readonly max: number }
}

// Three attempts on transient LLM errors (rate limit, network, 5xx).
// The fourth failure bubbles to `supervise`, which applies the agent's
// `restart` schedule and re-enters the subscribe loop.
const defaultLlmRetry: Schedule.Schedule<unknown, unknown> = Schedule.exponential(
  Duration.millis(200),
  2.0,
).pipe(Schedule.intersect(Schedule.recurs(3)))

const defaultFormatPrompt = (event: EventEnvelope): string =>
  `Event type: ${event.type}\nEvent payload: ${JSON.stringify(event.payload)}`

export const defineLlmAgent = (def: LlmAgentDef): AgentDef => {
  // Fail fast on schemas the JSON-Schema converter can't represent.
  const toolSchemas = Object.fromEntries(
    Object.entries(def.tools).map(
      ([name, t]) => [name, toJsonSchema(t.schema)] as const,
    ),
  )

  const handle = (event: EventEnvelope) =>
    Effect.gen(function* () {
      const emitted: Array<EventInput> = []
      const systemPrompt =
        typeof def.systemPrompt === "function"
          ? def.systemPrompt(event)
          : def.systemPrompt
      const prompt = (def.formatPrompt ?? defaultFormatPrompt)(event)

      const aiTools = Object.fromEntries(
        Object.entries(def.tools).map(([name, t]) => [
          name,
          aiTool({
            description: t.description,
            inputSchema: jsonSchema(toolSchemas[name] as never),
            execute: async (args: unknown) => {
              const validated = Schema.decodeUnknownSync(t.schema)(args)
              const result = await Effect.runPromise(t.handler(validated, event))
              const events = Array.isArray(result) ? result : []
              emitted.push(...events)
              return {
                ok: true,
                emittedTypes: events.map((e) => e.type),
              }
            },
          }),
        ]),
      )

      yield* Effect.tryPromise({
        try: () =>
          generateText({
            model: def.model,
            system: systemPrompt,
            prompt,
            tools: aiTools,
            stopWhen: stepCountIs(def.stopAfterSteps ?? 5),
          }),
        catch: (cause) => new LlmCallError({ agentId: def.id, cause }),
      }).pipe(Effect.retry(def.retry ?? defaultLlmRetry))

      return emitted
    })

  return defineAgent({
    id: def.id,
    on: def.on,
    handle,
    ...(def.concurrency !== undefined ? { concurrency: def.concurrency } : {}),
    ...(def.restart !== undefined ? { restart: def.restart } : {}),
  })
}
