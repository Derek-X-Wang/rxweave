import { Command } from "@effect/cli"
import { Console, Effect } from "effect"
import { EventStore } from "@rxweave/core"

// Emits the store's current head event-id on stdout as a single token —
// no JSON wrapping, no trailing whitespace beyond the newline. Agents
// use this to establish a `--since`/`--from-cursor` baseline before
// doing work:
//
//     cursor=$(rxweave cursor)
//     ...do work, emit events...
//     rxweave stream --from-cursor "$cursor"
//
// For an empty store `EventStore.latestCursor` returns the sentinel
// "earliest" (see MemoryStore / FileStore / CloudStore contracts).
// Printing that literal would force every shell script to special-case
// the string "earliest"; emitting an empty line instead gives
// `$(rxweave cursor)` a consistent empty-string result that downstream
// commands can either pass through or branch on with `[ -z "$cursor" ]`.
export const cursorCommand = Command.make("cursor", {}, () =>
  Effect.gen(function* () {
    const store = yield* EventStore
    const cursor = yield* store.latestCursor
    if (cursor === "earliest") {
      yield* Console.log("")
    } else {
      yield* Console.log(cursor)
    }
  }),
)
