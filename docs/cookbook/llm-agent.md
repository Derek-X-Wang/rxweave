# Cookbook: Give `bob-assistant` a brain (a real Claude agent)

`rxweave init --template full` scaffolds a collaboration stream where a
coworker's agent (`bob-assistant`) replies to each `request.posted` with a
stub: `ack: <text>`. That teaches the protocol — event in, agent reacts,
derived event out, provenance stamped — but the responder isn't actually
thinking.

This recipe is **rung 2**: swap the stub for a real Claude agent via
[`@rxweave/llm`](../../packages/llm). Same shared log, same `actor` /
`causedBy` provenance — but now `bob-assistant`'s reply is Claude's.

## 1. Install the LLM packages

```bash
bun add @rxweave/llm @ai-sdk/anthropic
export ANTHROPIC_API_KEY=sk-ant-...
```

`@rxweave/llm` wraps the runtime's `defineAgent` on top of the
[Vercel AI SDK](https://sdk.vercel.ai); `@ai-sdk/anthropic` is the provider.

## 2. Rewrite `agents/bob-assistant.ts`

Replace the stub with a `defineLlmAgent`. It reads each `request.posted`,
lets Claude compose a reply, and emits `response.posted` through a tool:

```ts
import { Effect, Schema } from "effect"
import { anthropic } from "@ai-sdk/anthropic"
import { defineLlmAgent, tool } from "@rxweave/llm"

export const bobAssistant = defineLlmAgent({
  id: "bob-assistant",
  on: { types: ["request.posted"] },
  model: anthropic("claude-sonnet-4-5"), // or any current Vercel AI SDK model
  systemPrompt:
    "You are a teammate's assistant on a shared event stream. " +
    "For each request, call `respond` with a concise, helpful reply.",
  tools: {
    respond: tool({
      description: "Post a reply to the shared stream",
      schema: Schema.Struct({ text: Schema.String }),
      handler: (args, event) =>
        Effect.succeed([
          {
            type: "response.posted",
            payload: { requestId: event.id, text: args.text },
          },
        ]),
    }),
  },
})
```

Nothing else changes: `rxweave.config.ts` already wires `bobAssistant`, and
the runtime still auto-stamps the emitted `response.posted` with
`actor="bob-assistant"`, `source="agent"`, and `causedBy=[<request id>]` —
exactly as the stub did. The agent's *output contract* is identical; only
its *brain* changed.

## 3. Run it

```bash
rxweave dev &
rxweave emit request.posted --actor alice \
  --payload '{"text":"summarize the auth design in one sentence"}'
rxweave stream                              # alice's request + Claude's reply on one log
rxweave inspect <response-id> --ancestry    # the reply, caused by alice's request
```

`bob-assistant`'s reply is now Claude's, not `ack: …` — but the shape is the
same: one shared log, multiple actors, full provenance. Alice sees what Bob's
agent actually *said*, and what caused it, without relaying a prompt or asking
Bob.

## Notes

- **More tools, multi-step.** `defineLlmAgent` supports several tools and
  multi-step tool use (the AI SDK's `stepCountIs`). Give `bob-assistant` more
  tools — emit different event types, look things up — and Claude chooses
  which to call.
- **Any provider.** Swap `@ai-sdk/anthropic` for any Vercel AI SDK provider;
  `model:` accepts any AI-SDK model handle.
- **Cost + secrets.** This calls a real model once per `request.posted`. Keep
  `ANTHROPIC_API_KEY` in the environment — never in the event log or
  `rxweave.config.ts`.
- **Rung 3 — a second human.** Add another participant:
  `rxweave emit request.posted --actor bob …`, with Bob's own agent on the
  same stream. You observe and react to each other's agents through the log.
  The "paste this prompt into your Claude" relay is gone — which is the whole
  point of RxWeave.

See also: [`@rxweave/llm`](../../packages/llm) for the full `defineLlmAgent` /
`tool()` API, and `apps/dev/agents/llm-task-from-speech.ts` for a second
worked example.
