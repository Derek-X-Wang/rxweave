import { Args, Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { AgentCursorStore } from "@rxweave/runtime"
import { Output } from "../Output.js"

const listCmd = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const cursors = yield* AgentCursorStore
    const out = yield* Output
    const entries = yield* cursors.list
    for (const entry of entries) yield* out.writeLine(entry)
  }),
)

const idArg = Args.text({ name: "id" })

const statusCmd = Command.make("status", { id: idArg }, ({ id }) =>
  Effect.gen(function* () {
    const cursors = yield* AgentCursorStore
    const out = yield* Output
    const cursor = yield* cursors.get(id)
    yield* out.writeLine({ agentId: id, cursor, fiberStatus: "unknown" })
    // Fiber status readout is a fast-follow: needs access to the
    // running FiberMap which lives in a dev-session scope.
  }),
)

const pathArg = Args.file({ name: "path" }).pipe(Args.optional)
const idFilterOpt = Options.text("id").pipe(Options.optional)
const fromCursorOpt = Options.text("from-cursor").pipe(Options.optional)

const runCmd = Command.make(
  "run",
  { path: pathArg, id: idFilterOpt, fromCursor: fromCursorOpt },
  () =>
    Effect.gen(function* () {
      const out = yield* Output
      yield* out.writeError({
        _tag: "NotImplemented",
        reason: "rxweave agent run wires up inside Task 26 (requires config loader).",
      })
    }),
)

export const agentCommand = Command.make("agent").pipe(
  Command.withSubcommands([runCmd, listCmd, statusCmd]),
)
