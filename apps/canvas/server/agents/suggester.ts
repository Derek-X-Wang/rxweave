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

// Extract visible text from a tldraw shape. tldraw v4 stores labels
// for geo/note/text shapes in `props.richText` (TipTap JSON); older
// versions used `props.text`. We support both.
type RichTextNode = {
  type?: string
  text?: string
  content?: ReadonlyArray<RichTextNode>
}

const walkRichText = (node: RichTextNode | undefined): string => {
  if (!node) return ""
  if (node.type === "text" && typeof node.text === "string") return node.text
  if (Array.isArray(node.content))
    return node.content.map(walkRichText).join("")
  return ""
}

const extractText = (record: unknown): string | null => {
  const r = record as
    | { props?: { text?: string; richText?: RichTextNode } }
    | undefined
  const plain = r?.props?.text
  if (typeof plain === "string" && plain.trim()) return plain.trim()
  const rich = walkRichText(r?.props?.richText).trim()
  return rich ? rich : null
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
