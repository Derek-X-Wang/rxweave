import { Schema } from "effect"
import { Cursor } from "./Cursor.js"
import { defineEvent } from "./Registry.js"

/**
 * Emitted by the runtime supervisor for each active agent every tick
 * (~10s). Consumers (dashboards, observability) can filter by
 * `type: "system.agent.heartbeat"` and key by `event.actor` — the
 * canonical branded `ActorId` that carries the agent identity — to
 * render an agents-view liveness grid.
 *
 * `cursor` mirrors the agent's in-flight `pendingCursor` — `null` means
 * the agent hasn't processed any event yet in this run. The supervisor
 * only ever emits `EventId | null`; the wider `Cursor` union (including
 * `"earliest"` / `"latest"` sentinels) is accepted so out-of-band
 * callers can seed synthetic heartbeats if needed.
 *
 * v0.2.1: dropped the duplicated `agentId` payload field — `event.actor`
 * is the single source of truth for the emitter's identity across every
 * event type, so stamping it twice on the heartbeat was a footgun
 * waiting to diverge under refactor. Dashboards that previously read
 * `payload.agentId` should read `event.actor` instead.
 */
export const SystemAgentHeartbeat = defineEvent(
  "system.agent.heartbeat",
  Schema.Struct({
    cursor: Schema.NullOr(Cursor),
    timestamp: Schema.Number,
  }),
)
