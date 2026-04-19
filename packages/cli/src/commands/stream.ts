import { Command, Options } from "@effect/cli"
import { Effect, Option, Stream } from "effect"
import type { Cursor } from "@rxweave/schema"
import { EventStore } from "@rxweave/core"
import { Output } from "../Output.js"
import { buildFilter, filterOptions } from "./FilterOptions.js"

const fromCursorOpt = Options.text("from-cursor").pipe(Options.optional)
const followOpt = Options.boolean("follow").pipe(Options.withDefault(false))

export const streamCommand = Command.make(
  "stream",
  {
    ...filterOptions,
    fromCursor: fromCursorOpt,
    follow: followOpt,
  },
  (opts) =>
    Effect.gen(function* () {
      const store = yield* EventStore
      const out = yield* Output

      const filter = buildFilter(opts)

      const cursor: Cursor = Option.isSome(opts.fromCursor)
        ? (opts.fromCursor.value as Cursor)
        : opts.follow
          ? "latest"
          : "earliest"

      const stream = store.subscribe({ cursor, filter })
      yield* Stream.runForEach(stream, (event) => out.writeLine(event))
    }),
)
