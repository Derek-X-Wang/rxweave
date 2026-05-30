import { Effect } from "effect"
import { defineAgent } from "@rxweave/runtime"
import type { EventEnvelope } from "@rxweave/schema"

// rung 1: a STUB responder. It teaches the protocol, not intelligence.
// rung 2: swap `reply` for a real Claude agent via @rxweave/llm's
// `defineLlmAgent` — that is where actual intelligence enters.
const reply = (text: string): string => `ack: ${text}`

// "bob-assistant" = a coworker's agent. When it emits below, the runtime
// stamps the new event with actor="bob-assistant", source="agent", and
// causedBy=[event.id] — so Alice can see what Bob's agent did, and what
// caused it, without relaying a prompt or asking Bob.
export const bobAssistant = defineAgent({
  id: "bob-assistant",
  on: { types: ["request.posted"] },
  handle: (event: EventEnvelope) =>
    Effect.succeed([
      {
        type: "response.posted",
        payload: {
          requestId: event.id,
          // event.payload is `unknown` at the type level; the `on.types`
          // filter above guarantees this is a request.posted, so the cast is safe.
          text: reply((event.payload as { text: string }).text),
        },
      },
    ]),
})
