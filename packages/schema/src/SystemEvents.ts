import { Schema } from "effect"
import { Cursor } from "./Cursor.js"
import { defineEvent } from "./Registry.js"

/**
 * Emitted by the runtime supervisor for each active agent every tick
 * (~10s). Consumers (dashboards, observability) can filter by
 * `type: "system.agent.heartbeat"` and key by `payload.agentId` to
 * render an agents-view liveness grid.
 *
 * `cursor` mirrors the agent's in-flight `pendingCursor` — `null` means
 * the agent hasn't processed any event yet in this run. The supervisor
 * only ever emits `EventId | null`; the wider `Cursor` union (including
 * `"earliest"` / `"latest"` sentinels) is accepted so out-of-band
 * callers can seed synthetic heartbeats if needed.
 */
export const SystemAgentHeartbeat = defineEvent(
  "system.agent.heartbeat",
  Schema.Struct({
    agentId: Schema.String,
    cursor: Schema.NullOr(Cursor),
    timestamp: Schema.Number,
  }),
)
