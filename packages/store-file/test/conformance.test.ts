import { Context, Effect, Layer } from "effect"
import { FileSystem } from "@effect/platform"
import { BunFileSystem } from "@effect/platform-bun"
import { runConformance } from "@rxweave/core/testing"
import { EventStore } from "@rxweave/core"
import { FileStore } from "../src/index.js"

const makeLayer = () => {
  const tmpLayer = Layer.scoped(
    EventStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      const ctx = yield* Layer.build(
        FileStore.Live({ path: `${tmp}/events.jsonl` }),
      )
      return Context.get(ctx, EventStore)
    }),
  )
  return tmpLayer.pipe(Layer.provide(BunFileSystem.layer))
}

runConformance({ name: "FileStore", layer: makeLayer(), fresh: makeLayer })
