import { Args, Command, Options } from "@effect/cli"
import { Effect, Option, Schema } from "effect"
import { readFile } from "node:fs/promises"
import { EventStore } from "@rxweave/core"
import {
  ActorId,
  EventRegistry,
  Source,
  UnknownEventType,
  type EventInput,
} from "@rxweave/schema"
import { Output } from "../Output.js"

const typeArg = Args.text({ name: "type" })
const payloadOption = Options.text("payload").pipe(Options.optional)
const payloadFileOption = Options.file("payload-file").pipe(Options.optional)
const actorOption = Options.text("actor").pipe(Options.withDefault("cli"))
const sourceOption = Options.choice("source", [
  "canvas",
  "agent",
  "system",
  "voice",
  "cli",
  "cloud",
] as const).pipe(Options.withDefault("cli" as const))
const batchOption = Options.boolean("batch").pipe(Options.withDefault(false))

export const emitCommand = Command.make(
  "emit",
  {
    type: typeArg,
    payload: payloadOption,
    payloadFile: payloadFileOption,
    actor: actorOption,
    source: sourceOption,
    batch: batchOption,
  },
  (opts) =>
    Effect.gen(function* () {
      const store = yield* EventStore
      const registry = yield* EventRegistry
      const out = yield* Output

      if (opts.batch) {
        const decoder = new TextDecoder()
        const chunks: Array<string> = []
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              process.stdin.on("data", (chunk) =>
                chunks.push(decoder.decode(chunk as Buffer)),
              )
              process.stdin.on("end", () => resolve())
            }),
        )
        const lines = chunks
          .join("")
          .split("\n")
          .filter((l) => l.length > 0)
        const inputs: Array<EventInput> = []
        for (const line of lines) {
          const raw = JSON.parse(line) as {
            type: string
            payload: unknown
            actor?: string
            source?: Source
          }
          const def = yield* registry.lookup(raw.type)
          const payload = yield* Schema.decodeUnknown(def.payload)(raw.payload)
          inputs.push({
            type: raw.type,
            actor: (raw.actor ?? "cli") as ActorId,
            source: (raw.source ?? "cli") as Source,
            payload,
          } as unknown as EventInput)
        }
        const envelopes = yield* store.append(inputs)
        for (const env of envelopes) yield* out.writeLine(env)
        return
      }

      let payloadText = ""
      if (Option.isSome(opts.payload)) {
        payloadText = opts.payload.value
      } else if (Option.isSome(opts.payloadFile)) {
        const filePath = opts.payloadFile.value
        payloadText = yield* Effect.promise(() =>
          readFile(filePath, "utf8"),
        )
      }

      if (payloadText.length === 0) {
        yield* out.writeError({
          _tag: "InputError",
          reason: "payload or payload-file required",
        })
        return yield* Effect.fail(new UnknownEventType({ type: opts.type }))
      }

      const def = yield* registry.lookup(opts.type)
      const payload = yield* Schema.decodeUnknown(def.payload)(
        JSON.parse(payloadText),
      )
      const envelopes = yield* store.append([
        {
          type: opts.type,
          actor: opts.actor as ActorId,
          source: opts.source as Source,
          payload,
        } as unknown as EventInput,
      ])
      yield* out.writeLine(envelopes[0]!)
    }),
)
