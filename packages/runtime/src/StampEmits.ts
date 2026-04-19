import { Clock, Effect } from "effect"
import {
  ActorId,
  EventId,
  EventInput,
  Ulid,
} from "@rxweave/schema"

export const stampEmits = (
  agentId: string,
  triggerId: EventId | undefined,
  inputs: ReadonlyArray<EventInput>,
): Effect.Effect<ReadonlyArray<EventInput>, never, Ulid> =>
  Effect.gen(function* () {
    const ulid = yield* Ulid
    const now = yield* Clock.currentTimeMillis
    const out: Array<EventInput> = []
    for (const input of inputs) {
      const id = yield* ulid.next
      out.push({
        type: input.type,
        actor: input.actor ?? (agentId as ActorId),
        source: input.source ?? "agent",
        payload: input.payload,
        // downstream append ignores id/timestamp/causedBy — those are
        // assigned inside the store. We carry runtime context to the
        // store via a parallel channel (see Supervisor.ts).
      } satisfies EventInput)
      void id
      void now
      void triggerId
    }
    return out
  })
