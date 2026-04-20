import { Effect, Schema } from "effect"
import type { LanguageModel } from "ai"
import { anthropic } from "@ai-sdk/anthropic"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { defineLlmAgent, tool } from "@rxweave/llm"

// Prefer OpenRouter (one key, many providers, usage caps) when
// OPENROUTER_API_KEY is set; fall back to a direct Anthropic key.
// OpenRouter and Anthropic use slightly different model-id slugs —
// OpenRouter is `anthropic/claude-sonnet-4.5`, Anthropic-direct is
// `claude-sonnet-4-5`.
const model: LanguageModel = process.env.OPENROUTER_API_KEY
  ? createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })(
      "anthropic/claude-sonnet-4.5",
    )
  : anthropic("claude-sonnet-4-5")

// Extract text from a tldraw shape. `geo`, `note`, and `text` shapes
// all store their label in `props.text`; `richText` (TipTap JSON) is
// more involved so we skip those for v1.
const extractText = (record: unknown): string | null => {
  const r = record as
    | { type?: string; props?: { text?: string } }
    | undefined
  const t = r?.props?.text
  return typeof t === "string" && t.trim() ? t.trim() : null
}

export const suggesterAgent = defineLlmAgent({
  id: "canvas-suggester",
  on: { types: ["canvas.shape.upserted"] },
  model,
  systemPrompt:
    `You are a brainstorming partner on a shared whiteboard. When the user ` +
    `writes a labelled shape, suggest 1-2 related concepts via suggestNote. ` +
    `Be concrete and brief (<10 words per note). Skip the suggestion if:\n` +
    `- the shape has no meaningful text,\n` +
    `- the topic is too vague for you to add real value,\n` +
    `- the user already has several notes on the same topic.`,
  formatPrompt: (event) => {
    // Runtime stamps `actor = agent.id` on emits, so the suggester's
    // own notes round-trip through its `on` filter. Guard here before
    // we spend an LLM call.
    if (event.actor !== "human") return "Agent-authored shape, skip."
    const record = (event.payload as { record?: unknown }).record
    const text = extractText(record)
    if (!text) return "Shape has no text, skip."
    const pos = record as { x?: number; y?: number }
    return `User labelled a shape with: "${text}" at (${pos.x ?? 0}, ${pos.y ?? 0}).`
  },
  tools: {
    suggestNote: tool({
      description: "Place a concept note adjacent to the user's shape.",
      schema: Schema.Struct({
        text: Schema.String.pipe(Schema.maxLength(80)),
        offsetX: Schema.Number.pipe(Schema.between(-400, 400)),
        offsetY: Schema.Number.pipe(Schema.between(-400, 400)),
      }),
      handler: (args, event) => {
        const triggering = (event.payload as {
          record: { x: number; y: number }
        }).record
        // Minimal tldraw note record. The store fills defaults for
        // unspecified optional fields; we only set what's meaningful
        // (position + props that differ from defaults). Violet colour
        // makes agent-authored notes visually distinct without any
        // bridge-side conditional.
        const note = {
          typeName: "shape" as const,
          id: `shape:sugg-${crypto.randomUUID()}`,
          type: "note" as const,
          x: triggering.x + args.offsetX,
          y: triggering.y + args.offsetY,
          props: { text: args.text, color: "violet", size: "m" },
        }
        return Effect.succeed([
          { type: "canvas.shape.upserted", payload: { record: note } },
        ])
      },
    }),
  },
})
