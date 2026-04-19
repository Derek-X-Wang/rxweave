import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { MemoryStore } from "@rxweave/store-memory"
import { EventRegistry, defineEvent } from "@rxweave/schema"
import { Output } from "../src/Output.js"
import { emitCommand } from "../src/commands/emit.js"

// NOTE: @effect/cli@0.75.1 does not expose `Command.parse(cmd, argv)` as a top-level helper
// returning `{ handler }`. The real parser is `CommandDescriptor.parse(descriptor, argv, cfg)`
// which returns `Effect<CommandDirective<A>, ValidationError, FileSystem | Path | Terminal>`
// and requires the platform services. For a unit test we don't need to re-test the upstream
// arg parser — we test the handler logic directly with a constructed opts object, matching
// the shape that `Command.make(name, config, handler)` produces for the handler arg.

const NodeCreated = defineEvent(
  "canvas.node.created",
  Schema.Struct({ id: Schema.String }),
)

describe("emit command", () => {
  it.effect("emits a validated event", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      yield* reg.register(NodeCreated)
      const lines: Array<string> = []
      const errors: Array<string> = []
      const out = Layer.succeed(Output, {
        writeLine: (v) => Effect.sync(() => lines.push(JSON.stringify(v))),
        writeError: (v) => Effect.sync(() => errors.push(JSON.stringify(v))),
      })

      yield* emitCommand.handler({
        type: "canvas.node.created",
        payload: Option.some(JSON.stringify({ id: "n1" })),
        payloadFile: Option.none(),
        actor: "cli",
        source: "cli" as const,
        batch: false,
      }).pipe(Effect.provide(out))

      expect(errors.length).toBe(0)
      expect(lines.length).toBe(1)
      const parsedOut = JSON.parse(lines[0]!) as { type: string; actor: string }
      expect(parsedOut.type).toBe("canvas.node.created")
      expect(parsedOut.actor).toBe("cli")
    }).pipe(
      Effect.provide(MemoryStore.Live),
      Effect.provide(EventRegistry.Live),
    ),
  )
})
