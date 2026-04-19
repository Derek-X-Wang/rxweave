import { Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { Output, type Format } from "./Output.js"

export const configOption = Options.file("config").pipe(
  Options.withAlias("c"),
  Options.withDefault("./rxweave.config.ts"),
)
export const storeOption = Options.file("store").pipe(
  Options.withAlias("s"),
  Options.optional,
)
export const formatOption = Options.choice("format", ["json", "pretty"] as const).pipe(
  Options.withDefault("json" as const),
)

export const rootCommand = Command.make("rxweave")

export const withOutput = (format: Format) =>
  <A, E, R>(eff: Effect.Effect<A, E, R>) =>
    eff.pipe(Effect.provide(Output.Live(format)))
