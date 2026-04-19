#!/usr/bin/env bun
import { Command } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { EventRegistry } from "@rxweave/schema"
import { MemoryStore } from "@rxweave/store-memory"
import { rootCommand } from "../src/Main.js"
import { Output } from "../src/Output.js"
import { emitCommand } from "../src/commands/emit.js"
import { streamCommand } from "../src/commands/stream.js"
import { getCommand } from "../src/commands/get.js"
import { inspectCommand } from "../src/commands/inspect.js"
import { countCommand } from "../src/commands/count.js"
import { lastCommand } from "../src/commands/last.js"
import { headCommand } from "../src/commands/head.js"

const root = rootCommand.pipe(
  Command.withSubcommands([
    emitCommand,
    streamCommand,
    getCommand,
    inspectCommand,
    countCommand,
    lastCommand,
    headCommand,
  ]),
)

const cli = Command.run(root, { name: "rxweave", version: "0.1.0" })

// v0.1 defaults: in-memory store, empty schema registry, JSON output.
// A follow-up task wires `--config` into proper Layer selection.
const defaults = Layer.mergeAll(
  MemoryStore.Live,
  EventRegistry.Live,
  Output.Live("json"),
)

cli(process.argv).pipe(
  Effect.provide(defaults),
  Effect.provide(BunContext.layer),
  BunRuntime.runMain,
)
