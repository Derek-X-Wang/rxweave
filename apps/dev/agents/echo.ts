import { Effect } from "effect"
import { defineAgent, withIdempotence } from "@rxweave/runtime"
import type { EventEnvelope } from "@rxweave/schema"

export const echoAgent = defineAgent({
  id: "echo",
  on: { types: ["canvas.node.created"] },
  handle: withIdempotence(
    (e: EventEnvelope) => e.id,
    "local",
    (event) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => console.log(`echo saw ${event.id}`))
        return [{ type: "echo.seen", payload: { id: event.id } }]
      }),
  ),
})
