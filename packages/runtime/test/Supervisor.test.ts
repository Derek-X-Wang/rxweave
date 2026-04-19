import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Duration, Effect, Ref, TestClock } from "effect"
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

  it.scoped("emits system.agent.heartbeat every 10s per active agent", () =>
    Effect.gen(function* () {
      const alpha = defineAgent({
        id: "alpha",
        on: { types: ["demo.ping"] },
        handle: () => Effect.void,
      })
      const beta = defineAgent({
        id: "beta",
        on: { types: ["demo.ping"] },
        handle: () => Effect.void,
      })

      yield* Effect.forkScoped(supervise([alpha, beta]))

      // Let the forked supervise() fiber thread through FiberMap.run
      // for each agent so cursorCtx contains both ids before we tick.
      // Under TestClock, adjusting by 0 yields the scheduler.
      yield* TestClock.adjust(Duration.millis(0))

      // First heartbeat tick (10s) — both agents should emit one.
      yield* TestClock.adjust(Duration.seconds(11))

      const store = yield* EventStore
      const hb = yield* store.query(
        { types: ["system.agent.heartbeat"] },
        100,
      )
      expect(hb.length).toBe(2)
      const ids = hb
        .map((e) => (e.payload as { agentId: string }).agentId)
        .sort()
      expect(ids).toEqual(["alpha", "beta"])
      for (const event of hb) {
        expect(event.source).toBe("system")
        const payload = event.payload as {
          agentId: string
          cursor: string | null
          timestamp: number
        }
        // No events consumed yet, so pendingCursor is still null.
        expect(payload.cursor).toBeNull()
        expect(typeof payload.timestamp).toBe("number")
      }

      // Second tick advances past 20s → expect one more per agent.
      yield* TestClock.adjust(Duration.seconds(10))
      const hb2 = yield* store.query(
        { types: ["system.agent.heartbeat"] },
        100,
      )
      expect(hb2.length).toBe(4)
    }).pipe(
      Effect.provide(MemoryStore.Live),
      Effect.provide(AgentCursorStore.Memory),
    ),
  )
})
