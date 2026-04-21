import { Command, Options } from "@effect/cli"
import { Effect, Option, Stream } from "effect"
import type { Cursor } from "@rxweave/schema"
import { EventStore } from "@rxweave/core"
import { Output } from "../Output.js"
import { buildFilter, filterOptions } from "./FilterOptions.js"
import { BUILTIN_FOLDS, isBuiltinFoldName } from "./folds/index.js"

const fromCursorOpt = Options.text("from-cursor").pipe(Options.optional)
const followOpt = Options.boolean("follow").pipe(Options.withDefault(false))

/**
 * Terminal-aggregation flags (plan §4.5, Tasks 15/16/17). These three
 * replace the dropped `count` / `last` / `head` top-level commands.
 * All three are mutually exclusive with each other AND with `--follow`
 * — a terminal mode runs exactly one store.query + aggregation and
 * exits, whereas `--follow` is an infinite subscription. Mixing them
 * is always a user error; we fail up-front with a structured error
 * rather than silently preferring one.
 *
 * `Number.MAX_SAFE_INTEGER` as the query limit is deliberate for v1:
 * local event logs are measured in thousands, not billions, so
 * pulling everything into memory and slicing/aggregating is fine.
 * If this becomes a problem we introduce `--batch-size` and stream
 * through a chunked reduce, but that's a real-load optimization.
 */
const countOpt = Options.boolean("count").pipe(Options.withDefault(false))
const lastOpt = Options.integer("last").pipe(Options.optional)
const foldOpt = Options.text("fold").pipe(Options.optional)

export const streamCommand = Command.make(
  "stream",
  {
    ...filterOptions,
    fromCursor: fromCursorOpt,
    follow: followOpt,
    count: countOpt,
    last: lastOpt,
    fold: foldOpt,
  },
  (opts) =>
    Effect.gen(function* () {
      const store = yield* EventStore
      const out = yield* Output

      const filter = buildFilter(opts)

      // --- Mutual-exclusion guard for terminal-aggregation modes ---------
      // Checked up front so even if the flag that would otherwise run
      // first has a bad value (e.g. --last -1), the caller sees the
      // arg-shape error instead of execution side effects.
      const terminalModes = [
        { name: "count", active: opts.count },
        { name: "last", active: Option.isSome(opts.last) },
        { name: "fold", active: Option.isSome(opts.fold) },
      ].filter((m) => m.active)

      if (terminalModes.length > 1) {
        const [a, b] = terminalModes
        const reason = `--${a!.name} and --${b!.name} are mutually exclusive`
        yield* out.writeError({
          _tag: "InvalidStreamOptions",
          reason,
        })
        return yield* Effect.fail(new Error(`stream: ${reason}`))
      }
      if (terminalModes.length === 1 && opts.follow) {
        const reason = `--follow cannot be combined with --${terminalModes[0]!.name}`
        yield* out.writeError({
          _tag: "InvalidStreamOptions",
          reason,
        })
        return yield* Effect.fail(new Error(`stream: ${reason}`))
      }

      // --- Task 15: --count ---------------------------------------------
      if (opts.count) {
        const all = yield* store.query(filter, Number.MAX_SAFE_INTEGER)
        yield* out.writeLine({ count: all.length })
        return
      }

      // --- Task 16: --last N --------------------------------------------
      if (Option.isSome(opts.last)) {
        const all = yield* store.query(filter, Number.MAX_SAFE_INTEGER)
        const tail = all.slice(-opts.last.value)
        for (const e of tail) yield* out.writeLine(e)
        return
      }

      // --- Task 17: --fold <name> ---------------------------------------
      // For v1 the fold's `on` filter is authoritative: we query by the
      // fold's declared type set and ignore the user's --types /
      // --actors / --sources flags. Mixing those with a fold would
      // require agreeing on union-vs-intersection semantics; punt until
      // a user actually asks for it.
      if (Option.isSome(opts.fold)) {
        const name = opts.fold.value
        if (!isBuiltinFoldName(name)) {
          yield* out.writeError({
            _tag: "UnknownFold",
            name,
            available: Object.keys(BUILTIN_FOLDS),
          })
          return yield* Effect.fail(new Error(`stream: unknown fold "${name}"`))
        }
        const fold = BUILTIN_FOLDS[name]
        const events = yield* store.query(fold.on, Number.MAX_SAFE_INTEGER)
        const state = events.reduce(
          (s, e) => fold.reduce(e, s),
          fold.initial(),
        )
        yield* out.writeLine(state)
        return
      }

      // --- Default: infinite subscription (possibly from a cursor) ------
      const cursor: Cursor = Option.isSome(opts.fromCursor)
        ? (opts.fromCursor.value as Cursor)
        : opts.follow
          ? "latest"
          : "earliest"

      const stream = store.subscribe({ cursor, filter })
      yield* Stream.runForEach(stream, (event) => out.writeLine(event))
    }),
)
