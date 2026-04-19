import { Context, Effect, Layer } from "effect"

export type Format = "json" | "pretty"

export interface OutputShape {
  readonly writeLine: (value: unknown) => Effect.Effect<void>
  readonly writeError: (value: unknown) => Effect.Effect<void>
}

export class Output extends Context.Tag("rxweave/cli/Output")<Output, OutputShape>() {
  static Live = (format: Format) =>
    Layer.succeed(Output, {
      writeLine: (value) =>
        Effect.sync(() => {
          if (format === "json") {
            process.stdout.write(JSON.stringify(value) + "\n")
          } else {
            process.stdout.write(prettyPrint(value) + "\n")
          }
        }),
      writeError: (value) =>
        Effect.sync(() => {
          process.stderr.write(JSON.stringify(value) + "\n")
        }),
    })
}

const prettyPrint = (v: unknown): string => {
  if (typeof v === "string") return v
  if (v && typeof v === "object" && "type" in v && "id" in v) {
    const e = v as { id: string; type: string; actor: string; timestamp: number }
    return `${e.id}  ${e.type}  ${e.actor}  ${new Date(e.timestamp).toISOString()}`
  }
  return JSON.stringify(v, null, 2)
}
