import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { AgentCursorStore } from "@rxweave/runtime"
import { Output } from "../src/Output.js"
import { agentCommand, execCmd } from "../src/commands/agent.js"

// NOTE: Pins the subcommand surface of `rxweave agent`. A future
// rename — or accidental deletion — should surface here rather than
// downstream in agent-driven shell scripts that assume e.g.
// `rxweave agent exec <path>` as the one-shot entrypoint.
//
// The subcommand-name snapshot reaches into @effect/cli's internals
// (`descriptor.children[i].command.command.name`). That's the shape
// in @effect/cli@0.75.1 — if it shifts, update the extractor in one
// place here; the intent is to pin names, not the library's internal
// tree. Handler invocation goes through the exported subcommand Command
// directly to avoid pulling in FileSystem/Path/Terminal.

const subcommandNames = (cmd: typeof agentCommand): ReadonlyArray<string> => {
  const children = (cmd as unknown as {
    descriptor: { children: ReadonlyArray<{ command: { command: { name: string } } }> }
  }).descriptor.children
  return children.map((c) => c.command.command.name)
}

describe("agent command", () => {
  it("exposes list / status / exec subcommands (run is gone)", () => {
    const names = subcommandNames(agentCommand)
    expect(names).toEqual(expect.arrayContaining(["exec", "list", "status"]))
    expect(names).not.toContain("run")
  })

  it.effect("exec handler emits NotImplemented until Task 26 wires config", () =>
    Effect.gen(function* () {
      const errors: Array<string> = []
      const out = Layer.succeed(Output, {
        writeLine: () => Effect.void,
        writeError: (v) =>
          Effect.sync(() => {
            errors.push(typeof v === "string" ? v : JSON.stringify(v))
          }),
      })

      yield* execCmd
        .handler({
          path: Option.none(),
          id: Option.none(),
          fromCursor: Option.none(),
        })
        .pipe(Effect.provide(out))

      expect(errors.length).toBe(1)
      const parsed = JSON.parse(errors[0]!) as { _tag: string; reason: string }
      expect(parsed._tag).toBe("NotImplemented")
      // Reason text must mention the new name so it's obvious in
      // stderr that the user hit the exec path (not run).
      expect(parsed.reason).toMatch(/exec/)
      expect(parsed.reason).not.toMatch(/\brun\b/)
    }).pipe(Effect.provide(AgentCursorStore.Memory)),
  )
})
