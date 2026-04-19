import { Context, Effect, Layer, Schema } from "effect"
import { FileSystem } from "@effect/platform"
import { BunFileSystem } from "@effect/platform-bun"
import { runConformance } from "@rxweave/core/testing"
import { EventStore } from "@rxweave/core"
import { EventEnvelope } from "@rxweave/schema"
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

// Cold-start factory: seed a JSONL file with exactly one valid envelope plus
// a torn partial line. Mirrors the shape of test/recovery.test.ts. Proves
// FileStore.Live boots from a torn tail, truncates it, and surfaces the
// single recoverable event through query(). See conformance spec §5.8.
const encode = Schema.encodeSync(Schema.parseJson(EventEnvelope))
const coldStartFactory = () => {
  const tmpLayer = Layer.scoped(
    EventStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      const path = `${tmp}/events.jsonl`
      // Branded EventId + ActorId are opaque by design — tests fabricate
      // ULID-shape strings via `as never` rather than pulling the Ulid
      // service. Mirrors the existing pattern in recovery.test.ts.
      const envelope = new EventEnvelope({
        id: "01HXC5QKZ8M9A0TN3P1Q2R4S5V" as never,
        type: "recovery.probe",
        actor: "tester" as never,
        source: "cli",
        timestamp: 1,
        payload: {},
      })
      const good = encode(envelope)
      // No trailing newline after the torn fragment — scanAndRecover treats
      // that as a torn tail and FileStore truncates it on boot.
      const torn = `${good}\n{"id":"trunc`
      yield* fs.writeFile(path, new TextEncoder().encode(torn))
      const ctx = yield* Layer.build(FileStore.Live({ path }))
      return Context.get(ctx, EventStore)
    }),
  )
  return tmpLayer.pipe(Layer.provide(BunFileSystem.layer))
}

runConformance({
  name: "FileStore",
  layer: makeLayer(),
  fresh: makeLayer,
  supportsColdStartRecovery: true,
  coldStartFactory,
})
