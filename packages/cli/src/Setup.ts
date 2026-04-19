import * as Path from "node:path"
import { Effect, Layer } from "effect"
import { FileSystem } from "@effect/platform"
import { EventRegistry } from "@rxweave/schema"
import { EventStore } from "@rxweave/core"
import { MemoryStore } from "@rxweave/store-memory"
import { loadConfig } from "./Config.js"

export const DEFAULT_CONFIG_PATH = "./rxweave.config.ts"

export const readConfigPathFromArgv = (argv: ReadonlyArray<string>): string | null => {
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--config" || a === "-c") return argv[i + 1] ?? null
    if (a !== undefined && a.startsWith("--config=")) return a.slice("--config=".length)
  }
  return null
}

export const resolveStoreLayer = (configPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const abs = Path.isAbsolute(configPath) ? configPath : Path.resolve(process.cwd(), configPath)
    const exists = yield* fs.exists(abs).pipe(Effect.orElseSucceed(() => false))
    if (!exists) return MemoryStore.Live as Layer.Layer<EventStore>
    const cfg = yield* loadConfig(abs)
    const reg = yield* EventRegistry
    for (const def of cfg.schemas) {
      yield* reg.register(def).pipe(Effect.orElseSucceed(() => undefined))
    }
    return Layer.orDie(cfg.store) as Layer.Layer<EventStore>
  })
