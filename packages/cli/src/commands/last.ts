import { Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { EventStore } from "@rxweave/core"
import { Output } from "../Output.js"
import { buildFilter, filterOptions } from "./FilterOptions.js"

const nOpt = Options.integer("n").pipe(Options.withAlias("N"), Options.withDefault(1))

export const lastCommand = Command.make(
  "last",
  { ...filterOptions, n: nOpt },
  (opts) =>
    Effect.gen(function* () {
      const store = yield* EventStore
      const out = yield* Output
      const events = yield* store.query(buildFilter(opts), 1_000_000)
      const tail = events.slice(-opts.n)
      for (const e of tail) yield* out.writeLine(e)
    }),
)
