import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Duration, Effect, Ref } from "effect"
import { EventStore } from "@rxweave/core"
import { MemoryStore } from "@rxweave/store-memory"
import { AgentCursorStore } from "../src/AgentCursorStore.js"
import { defineAgent } from "../src/AgentDef.js"
import { supervise } from "../src/Supervisor.js"

describe("supervise", () => {
  it.scopedLive("runs a handle agent that sees events appended after start", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make(0)
      const echo = defineAgent({
        id: "echo",
        on: { types: ["demo.ping"] },
        handle: () => Ref.update(seen, (n) => n + 1),
      })

      yield* Effect.forkScoped(supervise([echo]))
      const store = yield* EventStore
      yield* Effect.sleep(Duration.millis(10))
      yield* store.append([
        { type: "demo.ping", actor: "tester", source: "cli", payload: {} },
      ])
      yield* Effect.sleep(Duration.millis(50))

      expect(yield* Ref.get(seen)).toBe(1)
    }).pipe(
      Effect.provide(MemoryStore.Live),
      Effect.provide(AgentCursorStore.Memory),
    ),
  )

  it.scopedLive("emits events returned from a handle back into the store", () =>
    Effect.gen(function* () {
      const echo = defineAgent({
        id: "echoer",
        on: { types: ["demo.ping"] },
        handle: () =>
          Effect.succeed([
            { type: "demo.pong", actor: "echoer", source: "agent", payload: {} },
          ] as const),
      })

      yield* Effect.forkScoped(supervise([echo]))
      const store = yield* EventStore
      yield* Effect.sleep(Duration.millis(10))
      yield* store.append([
        { type: "demo.ping", actor: "tester", source: "cli", payload: {} },
      ])
      yield* Effect.sleep(Duration.millis(50))

      const pongs = yield* store.query({ types: ["demo.pong"] }, 10)
      expect(pongs.length).toBe(1)
      expect(pongs[0]!.source).toBe("agent")
      expect(pongs[0]!.causedBy?.length).toBe(1)
    }).pipe(
      Effect.provide(MemoryStore.Live),
      Effect.provide(AgentCursorStore.Memory),
    ),
  )
})
