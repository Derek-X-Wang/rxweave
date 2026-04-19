import { Schema } from "effect"
import { defineEvent } from "./Registry.js"
import { EventId } from "./Ids.js"

/**
 * Emitted by the runtime supervisor for each active agent every tick
 * (~10s). Consumers (dashboards, observability) can filter by
 * `type: "system.agent.heartbeat"` and key by `payload.agentId` to
 * render an agents-view liveness grid.
 *
 * `cursor` mirrors the agent's in-flight `pendingCursor` — `null` means
 * the agent hasn't processed any event yet in this run. The literals
 * `"earliest"` / `"latest"` are reserved for callers who want to seed
 * synthetic heartbeats from out-of-band state; the supervisor itself
 * only ever emits `EventId | null`.
 */
export const SystemAgentHeartbeat = defineEvent(
  "system.agent.heartbeat",
  Schema.Struct({
    agentId: Schema.String,
    cursor: Schema.Union(
      EventId,
      Schema.Literal("earliest"),
      Schema.Literal("latest"),
      Schema.Null,
    ),
    timestamp: Schema.Number,
  }),
)
