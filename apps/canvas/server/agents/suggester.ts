import { Effect, Schema } from "effect"
import type { LanguageModel } from "ai"
import { anthropic } from "@ai-sdk/anthropic"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { defineLlmAgent, tool } from "@rxweave/llm"
import type { AgentDef } from "@rxweave/runtime"
import type { EventEnvelope } from "@rxweave/schema"

const log = (msg: string, ...args: unknown[]) =>
  console.log(`[suggester] ${msg}`, ...args)

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

const baseAgent = defineLlmAgent({
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
    if (event.actor !== "human") {
      log(`event ${event.id.slice(0, 12)} skip: agent-authored`)
      return "Agent-authored shape, skip."
    }
    const record = (event.payload as { record?: unknown }).record
    const text = extractText(record)
    if (!text) {
      log(`event ${event.id.slice(0, 12)} skip: no text`)
      return "Shape has no text, skip."
    }
    log(`event ${event.id.slice(0, 12)} prompt: "${text}"`)
    // We don't tell the model about position/size — it only chooses
    // text + a vertical stacking slot. The handler does the geometry
    // so notes can't overlap the triggering shape regardless of model
    // choices.
    return (
      `User labelled a shape with: "${text}". ` +
      `Suggest 1-2 concise related concepts via suggestNote. ` +
      `Pass stackIndex=0 for the first suggestion, stackIndex=1 for ` +
      `the second (they'll render stacked vertically to the right of ` +
      `the user's shape).`
    )
  },
  tools: {
    suggestNote: tool({
      description:
        "Propose a concept note near the user's shape. stackIndex=0 goes " +
        "immediately to the right; stackIndex=1+ stacks below that.",
      schema: Schema.Struct({
        text: Schema.String.pipe(Schema.maxLength(80)),
        stackIndex: Schema.Number.pipe(Schema.between(0, 4)),
      }),
      handler: (args, event) => {
        const triggering = (event.payload as {
          record: {
            x: number
            y: number
            props?: { w?: number; h?: number }
          }
        }).record
        // Place notes immediately to the right of the triggering
        // shape's bounding box. Use the shape's own width (defaulting
        // to 200 for shapes that don't carry w — e.g. "draw" shapes)
        // so notes never overlap the triggering shape. Vertical
        // spacing of 160px fits tldraw's default note size with a
        // comfortable gap.
        const NOTE_WIDTH = 200
        const NOTE_HEIGHT = 160
        const GAP = 40
        const shapeW = triggering.props?.w ?? NOTE_WIDTH
        const x = triggering.x + shapeW + GAP
        const y = triggering.y + args.stackIndex * NOTE_HEIGHT
        // tldraw v4 store.put validates records against its schema and
        // silently drops shapes missing required fields. A "note" shape
        // needs: parentId, index, rotation, isLocked, opacity, meta at
        // the record level, and a full set of note-specific props
        // (including richText in TipTap JSON form). Minimal records
        // look accepted (no error on put) but nothing renders.
        const note = {
          typeName: "shape" as const,
          id: `shape:sugg-${crypto.randomUUID()}`,
          type: "note" as const,
          x,
          y,
          rotation: 0,
          isLocked: false,
          opacity: 1,
          meta: {},
          parentId: "page:page",
          index: `a${Date.now().toString(36)}`,
          props: {
            color: "violet",
            labelColor: "black",
            size: "m",
            font: "draw",
            align: "middle",
            verticalAlign: "middle",
            growY: 0,
            url: "",
            fontSizeAdjustment: 0,
            scale: 1,
            richText: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: args.text }],
                },
              ],
            },
          },
        }
        log(`tool suggestNote → "${args.text}" @ (${x}, ${y})`)
        return Effect.succeed([
          { type: "canvas.shape.upserted", payload: { record: note } },
        ])
      },
    }),
  },
})

// Wrap the agent's handle with tap/tapError so silent retries become
// visible. The base handle swallows LLM errors under the retry
// schedule; without this we'd have no feedback when the provider is
// rate-limiting or the model id is wrong.
export const suggesterAgent: AgentDef = {
  ...baseAgent,
  handle: (event: EventEnvelope) =>
    Effect.gen(function* () {
      // Short-circuit agent-authored events BEFORE any LLM call.
      // formatPrompt already checks actor === "human" and returns
      // "skip", but the LLM still runs on that prompt — one call
      // per agent-authored round-trip, all wasted. Pre-filtering
      // here skips the LLM entirely.
      if (event.actor !== "human") {
        log(`event ${event.id.slice(0, 12)} skip (agent-authored, no LLM call)`)
        return []
      }
      log(
        `handle entered for event ${event.id.slice(0, 12)} (type=${event.type}, actor=${event.actor})`,
      )
      return yield* baseAgent.handle!(event).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            const count = Array.isArray(result) ? result.length : 0
            if (count > 0)
              log(`event ${event.id.slice(0, 12)} emitted ${count} note(s)`)
            else log(`event ${event.id.slice(0, 12)} no notes emitted`)
          }),
        ),
        Effect.tapError((err) =>
          Effect.sync(() => {
            console.error(
              `[suggester] event ${event.id.slice(0, 12)} errored:`,
              err,
            )
          }),
        ),
      )
    }),
}
