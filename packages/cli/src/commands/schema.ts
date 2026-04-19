import { Args, Command, Options } from "@effect/cli"
import { Effect, Schema } from "effect"
import { EventRegistry, SchemaValidation } from "@rxweave/schema"
import { Output } from "../Output.js"

const listCmd = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const reg = yield* EventRegistry
    const out = yield* Output
    const wire = yield* reg.wire
    for (const def of wire) yield* out.writeLine(def)
  }),
)

const typeArg = Args.text({ name: "type" })

const showCmd = Command.make("show", { type: typeArg }, ({ type }) =>
  Effect.gen(function* () {
    const reg = yield* EventRegistry
    const out = yield* Output
    const wire = (yield* reg.wire).find((w) => w.type === type)
    if (!wire) {
      yield* out.writeError({ _tag: "UnknownEventType", type })
      return
    }
    yield* out.writeLine(wire)
  }),
)

const payloadOpt = Options.text("payload")

const validateCmd = Command.make(
  "validate",
  { type: typeArg, payload: payloadOpt },
  ({ type, payload }) =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      const out = yield* Output
      const def = yield* reg.lookup(type)
      const parsed = JSON.parse(payload)
      const result = yield* Effect.either(Schema.decodeUnknown(def.payload)(parsed))
      if (result._tag === "Right") {
        yield* out.writeLine({ valid: true })
      } else {
        yield* out.writeError(new SchemaValidation({ type, issue: result.left }))
        return yield* Effect.fail(new SchemaValidation({ type, issue: result.left }))
      }
    }),
)

export const schemaCommand = Command.make("schema").pipe(
  Command.withSubcommands([listCmd, showCmd, validateCmd]),
)
