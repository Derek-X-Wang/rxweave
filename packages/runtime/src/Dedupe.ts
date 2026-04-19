import { Effect, Ref } from "effect"
import type { EventEnvelope, EventInput } from "@rxweave/schema"

export type DedupeMemory = "local" | "store"

export const withIdempotence = <E>(
  key: (event: EventEnvelope) => string,
  memory: DedupeMemory,
  handler: (event: EventEnvelope) => Effect.Effect<ReadonlyArray<EventInput> | void, E, unknown>,
) => {
  const localRef = memory === "local" ? Ref.unsafeMake(new Set<string>()) : null
  return (event: EventEnvelope) =>
    Effect.gen(function* () {
      const k = key(event)
      if (memory === "local" && localRef) {
        const seen = yield* Ref.get(localRef)
        if (seen.has(k)) return
        yield* Ref.update(localRef, (s) => new Set(s).add(k))
        return yield* handler(event)
      }
      // memory === "store": delegate to store-backed dedupe via a
      // dedicated `agent.dedupe.<id>` sub-log; implementation lives
      // in Supervisor.ts where the agent id is in scope.
      return yield* handler(event)
    })
}
