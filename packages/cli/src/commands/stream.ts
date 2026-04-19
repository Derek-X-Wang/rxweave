import { Command, Options } from "@effect/cli"
import { Effect, Option, Stream } from "effect"
import type { ActorId, Cursor, Filter, Source } from "@rxweave/schema"
import { EventStore } from "@rxweave/core"
import { Output } from "../Output.js"

const typesOpt = Options.text("types").pipe(Options.repeated, Options.optional)
const actorsOpt = Options.text("actors").pipe(Options.repeated, Options.optional)
const sourcesOpt = Options.text("sources").pipe(Options.repeated, Options.optional)
const sinceOpt = Options.integer("since").pipe(Options.optional)
const fromCursorOpt = Options.text("from-cursor").pipe(Options.optional)
const followOpt = Options.boolean("follow").pipe(Options.withDefault(false))

export const streamCommand = Command.make(
  "stream",
  {
    types: typesOpt,
    actors: actorsOpt,
    sources: sourcesOpt,
    since: sinceOpt,
    fromCursor: fromCursorOpt,
    follow: followOpt,
  },
  (opts) =>
    Effect.gen(function* () {
      const store = yield* EventStore
      const out = yield* Output

      // Build a mutable bag first, then freeze into the readonly `Filter`
      // shape. `Filter` (derived from `Schema.Struct`) has readonly fields,
      // and `exactOptionalPropertyTypes` forbids assigning `undefined` to
      // the optional keys directly — so we only set keys that are present.
      const filterBag: {
        types?: ReadonlyArray<string>
        actors?: ReadonlyArray<ActorId>
        sources?: ReadonlyArray<Source>
        since?: number
      } = {}
      if (Option.isSome(opts.types)) {
        filterBag.types = opts.types.value as ReadonlyArray<string>
      }
      if (Option.isSome(opts.actors)) {
        filterBag.actors = opts.actors.value as unknown as ReadonlyArray<ActorId>
      }
      if (Option.isSome(opts.sources)) {
        filterBag.sources = opts.sources.value as unknown as ReadonlyArray<Source>
      }
      if (Option.isSome(opts.since)) {
        filterBag.since = opts.since.value
      }
      const filter: Filter = filterBag

      const cursor: Cursor = Option.isSome(opts.fromCursor)
        ? (opts.fromCursor.value as Cursor)
        : opts.follow
          ? "latest"
          : "earliest"

      const stream = store.subscribe({ cursor, filter })
      yield* Stream.runForEach(stream, (event) => out.writeLine(event))
    }),
)
