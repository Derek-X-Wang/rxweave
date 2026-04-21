#!/usr/bin/env bun
import { Command } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Cause, Effect, Layer, Option } from "effect"
import { EventRegistry } from "@rxweave/schema"
import { AgentCursorStore } from "@rxweave/runtime"
import { rootCommand } from "../src/Main.js"
import { Output } from "../src/Output.js"
import { exitCodeFor, tagOf, toErrorPayload } from "../src/Errors.js"
import { MemoryStore } from "@rxweave/store-memory"
import {
  DEFAULT_CONFIG_PATH,
  isMetaInvocation,
  readConfigPathFromArgv,
  resolveStoreLayer,
} from "../src/Setup.js"
import { initCommand } from "../src/commands/init.js"
import { devCommand } from "../src/commands/dev.js"
import { emitCommand } from "../src/commands/emit.js"
import { importCommand } from "../src/commands/import.js"
import { serveCommand } from "../src/commands/serve.js"
import { streamCommand } from "../src/commands/stream.js"
import { getCommand } from "../src/commands/get.js"
import { inspectCommand } from "../src/commands/inspect.js"
import { countCommand } from "../src/commands/count.js"
import { lastCommand } from "../src/commands/last.js"
import { headCommand } from "../src/commands/head.js"
import { cursorCommand } from "../src/commands/cursor.js"
import { schemaCommand } from "../src/commands/schema.js"
import { agentCommand } from "../src/commands/agent.js"
import { storeCommand } from "../src/commands/store.js"

const root = rootCommand.pipe(
  Command.withSubcommands([
    initCommand,
    devCommand,
    emitCommand,
    importCommand,
    serveCommand,
    streamCommand,
    getCommand,
    inspectCommand,
    countCommand,
    lastCommand,
    headCommand,
    cursorCommand,
    schemaCommand,
    agentCommand,
    storeCommand,
  ]),
)

const cli = Command.run(root, { name: "rxweave", version: "0.1.0" })

const configPath = readConfigPathFromArgv(process.argv) ?? DEFAULT_CONFIG_PATH
const metaPath = isMetaInvocation(process.argv)

const app = Effect.gen(function* () {
  const storeLayer = metaPath
    ? MemoryStore.Live
    : yield* resolveStoreLayer(configPath)
  return yield* cli(process.argv).pipe(Effect.provide(storeLayer))
})

const handled = app.pipe(
  Effect.catchAllCause((cause) =>
    Effect.gen(function* () {
      const output = yield* Output
      const fail = Cause.failureOption(cause)
      if (Option.isSome(fail)) {
        yield* output.writeError(toErrorPayload(fail.value))
        yield* Effect.sync(() => process.exit(exitCodeFor(tagOf(fail.value))))
      } else {
        yield* output.writeError({ _tag: "FiberFailure", message: Cause.pretty(cause) })
        yield* Effect.sync(() => process.exit(1))
      }
    }),
  ),
  Effect.provide(
    Layer.mergeAll(
      EventRegistry.Live,
      AgentCursorStore.Memory,
      Output.Live("json"),
    ),
  ),
  Effect.provide(BunContext.layer),
)

BunRuntime.runMain(handled)
