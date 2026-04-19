// Demo: LLM-backed replacement for `task-from-speech.ts`.
//
// Pure-TS agent uses hardcoded trigger words (`todo`, `task`, `remind me`).
// This version lets an LLM decide whether speech contains an actionable
// task, extract a title + optional priority, and emit `task.created`.
//
// Opt-in: not wired into `rxweave.config.ts` by default because it
// requires `ANTHROPIC_API_KEY`. To enable, uncomment the import + entry
// in the config and export ANTHROPIC_API_KEY=... before `rxweave dev`.

import { Effect, Schema } from "effect"
import { anthropic } from "@ai-sdk/anthropic"
import { defineLlmAgent, tool } from "@rxweave/llm"

export const llmTaskFromSpeechAgent = defineLlmAgent({
  id: "llm-task-from-speech",
  on: { types: ["speech.transcribed"] },
  model: anthropic("claude-sonnet-4-5"),
  systemPrompt:
    "You extract actionable tasks from transcribed speech. " +
    "If the speech contains a clear task, call `createTask` with a " +
    "concise title (max 80 chars) and an optional priority. " +
    "If it doesn't, do not call any tool.",
  tools: {
    createTask: tool({
      description: "Create a task from the user's speech",
      schema: Schema.Struct({
        title: Schema.String.pipe(Schema.maxLength(80)),
        priority: Schema.optional(
          Schema.Literal("low", "medium", "high"),
        ),
      }),
      handler: (args, event) =>
        Effect.succeed([
          {
            type: "task.created",
            payload: {
              ...args,
              sourceText: (event.payload as { text: string }).text,
            },
          },
        ] as const),
    }),
  },
})
