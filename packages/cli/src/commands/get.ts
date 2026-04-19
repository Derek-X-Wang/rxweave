import { Args, Command } from "@effect/cli"
import { Effect } from "effect"
import type { EventId } from "@rxweave/schema"
import { EventStore } from "@rxweave/core"
import { Output } from "../Output.js"

const idArg = Args.text({ name: "id" })

export const getCommand = Command.make(
  "get",
  { id: idArg },
  ({ id }) =>
    Effect.gen(function* () {
      const store = yield* EventStore
      const out = yield* Output
      const event = yield* store.getById(id as EventId)
      yield* out.writeLine(event)
    }),
)
