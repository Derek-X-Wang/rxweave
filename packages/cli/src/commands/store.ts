import { Command } from "@effect/cli"
import { Effect } from "effect"
import { EventStore } from "@rxweave/core"
import { Output } from "../Output.js"

const statsCmd = Command.make("stats", {}, () =>
  Effect.gen(function* () {
    const store = yield* EventStore
    const out = yield* Output
    const events = yield* store.query({}, 1_000_000)
    const latest = yield* store.latestCursor
    yield* out.writeLine({
      count: events.length,
      firstEvent: events[0]?.id ?? null,
      lastEvent: events[events.length - 1]?.id ?? null,
      cursor: latest,
    })
  }),
)

export const storeCommand = Command.make("store").pipe(
  Command.withSubcommands([statsCmd]),
)
