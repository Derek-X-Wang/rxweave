import { Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { FileSystem } from "@effect/platform"
import { Output } from "../Output.js"

const yesOpt = Options.boolean("yes").pipe(Options.withDefault(false))
const templateOpt = Options.choice("template", ["minimal", "full"] as const).pipe(
  Options.withDefault("minimal" as const),
)

// v0.1 template — keeps `schemas` and `agents` empty so `rxweave dev`
// starts cleanly in a freshly-initialized project. The `FileStore.Live`
// path is intentionally relative to cwd so `.rxweave/events.jsonl` sits
// next to the config file.
const CONFIG_TEMPLATE = `import { defineConfig } from "@rxweave/cli"
import { FileStore } from "@rxweave/store-file"

export default defineConfig({
  store: FileStore.Live({ path: ".rxweave/events.jsonl" }),
  schemas: [],
  agents: [],
})
`

export const initCommand = Command.make(
  "init",
  { yes: yesOpt, template: templateOpt },
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const out = yield* Output
      const configPath = "./rxweave.config.ts"
      const exists = yield* fs.exists(configPath)
      if (exists) {
        yield* out.writeError({ _tag: "AlreadyInitialized", path: configPath })
        return yield* Effect.fail(new Error("config exists"))
      }
      yield* fs.writeFileString(configPath, CONFIG_TEMPLATE)
      yield* fs.makeDirectory(".rxweave", { recursive: true })
      yield* out.writeLine({ created: [configPath, ".rxweave/"] })
    }),
)
