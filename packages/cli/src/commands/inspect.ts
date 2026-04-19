import { Args, Command, Options } from "@effect/cli"
import { Effect } from "effect"
import type { EventId } from "@rxweave/schema"
import { EventStore } from "@rxweave/core"
import { Output } from "../Output.js"

const idArg = Args.text({ name: "id" })
const ancestryOpt = Options.boolean("ancestry").pipe(Options.withDefault(false))
const descendantsOpt = Options.boolean("descendants").pipe(Options.withDefault(false))
const depthOpt = Options.integer("depth").pipe(Options.withDefault(3))

export const inspectCommand = Command.make(
  "inspect",
  {
    id: idArg,
    ancestry: ancestryOpt,
    descendants: descendantsOpt,
    depth: depthOpt,
  },
  ({ id, ancestry, descendants, depth }) =>
    Effect.gen(function* () {
      const store = yield* EventStore
      const out = yield* Output

      const root = yield* store.getById(id as EventId)
      yield* out.writeLine({ kind: "event", event: root })

      if (ancestry && root.causedBy) {
        for (const parentId of root.causedBy) {
          const parent = yield* Effect.either(store.getById(parentId))
          yield* out.writeLine(
            parent._tag === "Right"
              ? { kind: "ancestor", event: parent.right }
              : { kind: "dangling", eventId: id, missingAncestor: parentId },
          )
        }
      }

      if (descendants) {
        const all = yield* store.query({}, 10000)
        for (const e of all) {
          if (e.causedBy?.includes(id as EventId)) {
            yield* out.writeLine({ kind: "descendant", event: e })
          }
        }
      }

      // depth > 1 traversal is a fast-follow; v0.1 ships depth=1 only.
      void depth
    }),
)
