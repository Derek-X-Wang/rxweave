import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { MAX_EVENTS, pushEvent, walkLineage } from "../src/EventLog.js"

const makeEnvelope = (id: string, causedBy?: readonly string[]) => ({
  id,
  type: "canvas.shape.upserted",
  actor: "human",
  ...(causedBy !== undefined ? { causedBy } : {}),
  payload: {},
})

describe("pushEvent", () => {
  it.effect("appends a new event to an empty log", () =>
    Effect.sync(() => {
      const log = pushEvent([], makeEnvelope("e1"))
      expect(log.length).toBe(1)
      expect(log[0]!.id).toBe("e1")
    }),
  )

  it.effect("preserves causedBy", () =>
    Effect.sync(() => {
      const log = pushEvent([], makeEnvelope("e2", ["e1"]))
      expect(log[0]!.causedBy).toEqual(["e1"])
    }),
  )

  it.effect("caps log at MAX_EVENTS", () =>
    Effect.sync(() => {
      let log: ReadonlyArray<ReturnType<typeof pushEvent>[number]> = []
      for (let i = 0; i < MAX_EVENTS + 10; i++) {
        log = pushEvent(log, makeEnvelope(`e${i}`))
      }
      expect(log.length).toBe(MAX_EVENTS)
      // Oldest events should have been dropped; newest retained.
      expect(log[log.length - 1]!.id).toBe(`e${MAX_EVENTS + 9}`)
    }),
  )

  it.effect("does not mutate the original array", () =>
    Effect.sync(() => {
      const original: ReadonlyArray<ReturnType<typeof pushEvent>[number]> = []
      pushEvent(original, makeEnvelope("e1"))
      expect(original.length).toBe(0)
    }),
  )
})

describe("walkLineage", () => {
  it.effect("returns empty array for unknown eventId", () =>
    Effect.sync(() => {
      const chain = walkLineage([], "nonexistent")
      expect(chain.length).toBe(0)
    }),
  )

  it.effect("returns single event when no causedBy", () =>
    Effect.sync(() => {
      const log = pushEvent([], makeEnvelope("e1"))
      const chain = walkLineage(log, "e1")
      expect(chain.length).toBe(1)
      expect(chain[0]!.id).toBe("e1")
    }),
  )

  it.effect("walks a causal chain of 3", () =>
    Effect.sync(() => {
      let log = pushEvent([], makeEnvelope("e1"))
      log = pushEvent(log, makeEnvelope("e2", ["e1"]))
      log = pushEvent(log, makeEnvelope("e3", ["e2"]))
      const chain = walkLineage(log, "e3")
      expect(chain.map((e) => e.id)).toEqual(["e3", "e2", "e1"])
    }),
  )

  it.effect("stops at maxDepth", () =>
    Effect.sync(() => {
      let log: ReadonlyArray<ReturnType<typeof pushEvent>[number]> = []
      for (let i = 1; i <= 10; i++) {
        log = pushEvent(log, makeEnvelope(`e${i}`, i > 1 ? [`e${i - 1}`] : undefined))
      }
      // maxDepth=3 → e10, e9, e8 (3 levels including the start node)
      const chain = walkLineage(log, "e10", 3)
      expect(chain.length).toBe(3)
      expect(chain.map((e) => e.id)).toEqual(["e10", "e9", "e8"])
    }),
  )

  it.effect("stops when ancestor not in log", () =>
    Effect.sync(() => {
      // e2 causedBy e1, but e1 was never pushed (pre-load history)
      const log = pushEvent([], makeEnvelope("e2", ["e1"]))
      const chain = walkLineage(log, "e2")
      // Returns e2 only; e1 not in log so walk stops.
      expect(chain.length).toBe(1)
      expect(chain[0]!.id).toBe("e2")
    }),
  )

  it.effect("terminates cleanly on self-cycle (e1.causedBy=[e1]) — no duplicates", () =>
    Effect.sync(() => {
      // A self-loop: e1 claims its own id as its causal ancestor.
      // walkLineage must stop after adding e1 once, not loop forever.
      const log = pushEvent([], makeEnvelope("e1", ["e1"]))
      const chain = walkLineage(log, "e1")
      // e1 appears exactly once — cycle detected, walk terminates.
      expect(chain.length).toBe(1)
      expect(chain[0]!.id).toBe("e1")
      // No duplicate ids in the result.
      const ids = chain.map((e) => e.id)
      expect(new Set(ids).size).toBe(ids.length)
    }),
  )

  it.effect("terminates cleanly on mutual cycle (e1→e2→e1) — no duplicates", () =>
    Effect.sync(() => {
      // Mutual cycle: e1 caused e2, e2 caused e1.
      let log = pushEvent([], makeEnvelope("e1"))
      log = pushEvent(log, makeEnvelope("e2", ["e1"]))
      // Artificially patch e1's causedBy to point at e2 by rebuilding:
      // We can't modify the immutable entry, so instead test from e2's
      // perspective where the cycle is e2→e1→(e1 already visited).
      // e2 causedBy e1, e1 has no further causedBy → chain is [e2, e1].
      // For a true mutual cycle we need both entries pointing at each other.
      // Rebuild with causedBy set on both:
      let log2: ReadonlyArray<ReturnType<typeof pushEvent>[number]> = []
      log2 = pushEvent(log2, makeEnvelope("a", ["b"]))
      log2 = pushEvent(log2, makeEnvelope("b", ["a"]))
      // Walk from "a": a→b→(a already visited) → stops.
      const chain = walkLineage(log2, "a", 10)
      expect(chain.map((e) => e.id)).toEqual(["a", "b"])
      // No duplicate ids.
      const ids = chain.map((e) => e.id)
      expect(new Set(ids).size).toBe(ids.length)
    }),
  )
})
