import { Command } from "@effect/cli"
import { Effect } from "effect"
import { EventStore } from "@rxweave/core"
import { Output } from "../Output.js"
import { buildFilter, filterOptions } from "./FilterOptions.js"

export const countCommand = Command.make(
  "count",
  filterOptions,
  (opts) =>
    Effect.gen(function* () {
      const store = yield* EventStore
      const out = yield* Output
      const events = yield* store.query(buildFilter(opts), 1_000_000)
      yield* out.writeLine({ count: events.length })
    }),
)
