import * as Path from "node:path"
import { Effect, Layer } from "effect"
import { FileSystem } from "@effect/platform"
import { EventRegistry } from "@rxweave/schema"
import { EventStore } from "@rxweave/core"
import { MemoryStore } from "@rxweave/store-memory"
import { loadConfig } from "./Config.js"

export const DEFAULT_CONFIG_PATH = "./rxweave.config.ts"

const META_FLAGS = new Set(["--help", "-h", "--version", "--wizard", "--completions"])

export const readConfigPathFromArgv = (argv: ReadonlyArray<string>): string | null => {
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--config" || a === "-c") return argv[i + 1] ?? null
    if (a !== undefined && a.startsWith("--config=")) return a.slice("--config=".length)
  }
  return null
}

/**
 * Returns true when argv is asking for help/version/completions or is bare.
 * Lets bin/rxweave.ts skip the config dynamic-import on these read-only
 * meta paths — otherwise `rxweave --help` pays a full config module graph
 * load before @effect/cli even parses argv.
 */
export const isMetaInvocation = (argv: ReadonlyArray<string>): boolean => {
  const args = argv.slice(2)
  if (args.length === 0) return true
  for (const a of args) if (META_FLAGS.has(a)) return true
  return false
}

export const resolveStoreLayer = (configPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const abs = Path.isAbsolute(configPath) ? configPath : Path.resolve(process.cwd(), configPath)
    const exists = yield* fs.exists(abs).pipe(Effect.orElseSucceed(() => false))
    if (!exists) return MemoryStore.Live as Layer.Layer<EventStore>
    const cfg = yield* loadConfig(abs)
    const reg = yield* EventRegistry
    yield* reg.registerAll(cfg.schemas, { swallowDuplicates: true })
    return Layer.orDie(cfg.store) as Layer.Layer<EventStore>
  })
