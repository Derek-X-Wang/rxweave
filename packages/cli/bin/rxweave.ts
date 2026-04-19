#!/usr/bin/env bun
import { Command } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect } from "effect"
import { rootCommand } from "../src/Main.js"

const cli = Command.run(rootCommand, {
  name: "rxweave",
  version: "0.1.0",
})

cli(process.argv).pipe(
  Effect.provide(BunContext.layer),
  BunRuntime.runMain,
)
