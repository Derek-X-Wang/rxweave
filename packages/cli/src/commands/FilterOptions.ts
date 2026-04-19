import { Options } from "@effect/cli"
import { Option } from "effect"
import type { Filter } from "@rxweave/schema"

export const filterOptions = {
  types: Options.text("types").pipe(Options.repeated, Options.optional),
  actors: Options.text("actors").pipe(Options.repeated, Options.optional),
  sources: Options.text("sources").pipe(Options.repeated, Options.optional),
  since: Options.integer("since").pipe(Options.optional),
}

export const buildFilter = (opts: {
  readonly types: Option.Option<ReadonlyArray<string>>
  readonly actors: Option.Option<ReadonlyArray<string>>
  readonly sources: Option.Option<ReadonlyArray<string>>
  readonly since: Option.Option<number>
}): Filter => {
  const filter: {
    -readonly [K in keyof Filter]: Filter[K]
  } = {}
  if (Option.isSome(opts.types)) filter.types = opts.types.value
  if (Option.isSome(opts.actors)) filter.actors = opts.actors.value as unknown as ReadonlyArray<never>
  if (Option.isSome(opts.sources)) filter.sources = opts.sources.value as unknown as ReadonlyArray<never>
  if (Option.isSome(opts.since)) filter.since = opts.since.value
  return filter as Filter
}
