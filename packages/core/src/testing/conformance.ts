import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Fiber, Layer, Stream } from "effect"
import type { ActorId } from "@rxweave/schema"
import { EventStore } from "../EventStore.js"

export interface ConformanceOptions {
  readonly name: string
  readonly layer: Layer.Layer<EventStore>
  readonly fresh?: () => Layer.Layer<EventStore>
}

const actor = (v: string): ActorId => v as ActorId

export const runConformance = ({ name, layer, fresh }: ConformanceOptions) => {
  const makeLayer = fresh ?? (() => layer)

  describe(`${name} conformance`, () => {
    it.effect("append + subscribe round-trips a single event", () =>
      Effect.gen(function* () {
        const store = yield* EventStore
        const appended = yield* store.append([
          { type: "canvas.node.created", actor: actor("tester"), source: "cli", payload: { id: "n1", label: "A" } },
        ])
        expect(appended.length).toBe(1)
        const first = appended[0]!
        const got = yield* store.getById(first.id)
        expect(got.type).toBe("canvas.node.created")
      }).pipe(Effect.provide(makeLayer())),
    )

    it.effect("cursor is exclusive on resume", () =>
      Effect.gen(function* () {
        const store = yield* EventStore
        const appended = yield* store.append([
          { type: "canvas.node.created", actor: actor("tester"), source: "cli", payload: { id: "a", label: "A" } },
          { type: "canvas.node.created", actor: actor("tester"), source: "cli", payload: { id: "b", label: "B" } },
        ])
        const sub = yield* store
          .subscribe({ cursor: appended[0]!.id })
          .pipe(Stream.take(1), Stream.runCollect, Effect.fork)
        const got = yield* Fiber.join(sub)
        const arr = Array.from(got)
        expect(arr.length).toBe(1)
        expect(arr[0]!.id).toBe(appended[1]!.id)
      }).pipe(Effect.provide(makeLayer())),
    )

    it.effect("filter pushdown by type glob", () =>
      Effect.gen(function* () {
        const store = yield* EventStore
        yield* store.append([
          { type: "canvas.node.created", actor: actor("tester"), source: "cli", payload: { id: "a", label: "A" } },
          { type: "canvas.node.deleted", actor: actor("tester"), source: "cli", payload: { id: "a" } },
        ])
        const got = yield* store.query({ types: ["canvas.node.created"] }, 10)
        expect(got.length).toBe(1)
      }).pipe(Effect.provide(makeLayer())),
    )

    it.effect("query filter by actor", () =>
      Effect.gen(function* () {
        const store = yield* EventStore
        yield* store.append([
          { type: "canvas.node.created", actor: actor("a"), source: "cli", payload: { id: "1", label: "x" } },
          { type: "canvas.node.created", actor: actor("b"), source: "cli", payload: { id: "2", label: "y" } },
        ])
        const got = yield* store.query({ actors: [actor("b")] }, 10)
        expect(got.length).toBe(1)
        expect(got[0]!.actor).toBe("b")
      }).pipe(Effect.provide(makeLayer())),
    )

    it.effect("latestCursor reflects most recent append", () =>
      Effect.gen(function* () {
        const store = yield* EventStore
        const appended = yield* store.append([
          { type: "canvas.node.created", actor: actor("tester"), source: "cli", payload: { id: "a", label: "A" } },
        ])
        const latest = yield* store.latestCursor
        expect(latest).toBe(appended[0]!.id)
      }).pipe(Effect.provide(makeLayer())),
    )

    it.effect("getById returns NotFound for unknown id", () =>
      Effect.gen(function* () {
        const store = yield* EventStore
        const res = yield* Effect.flip(
          store.getById("01HXC5QKZ8M9A0TN3P1Q2R4S5V" as never),
        )
        expect(res._tag).toBe("NotFound")
      }).pipe(Effect.provide(makeLayer())),
    )

    it.effect("queryAfter('earliest') matches query() from the beginning", () =>
      Effect.gen(function* () {
        const store = yield* EventStore
        yield* store.append([
          { type: "canvas.node.created", actor: actor("tester"), source: "cli", payload: { id: "a", label: "A" } },
          { type: "canvas.node.created", actor: actor("tester"), source: "cli", payload: { id: "b", label: "B" } },
          { type: "canvas.node.created", actor: actor("tester"), source: "cli", payload: { id: "c", label: "C" } },
        ])
        const viaQuery = yield* store.query({}, 10)
        const viaQueryAfter = yield* store.queryAfter("earliest", {}, 10)
        expect(viaQueryAfter.length).toBe(viaQuery.length)
        expect(viaQueryAfter.map((e) => e.id)).toEqual(viaQuery.map((e) => e.id))
      }).pipe(Effect.provide(makeLayer())),
    )

    it.effect("queryAfter(eventId) returns only events strictly after cursor", () =>
      Effect.gen(function* () {
        const store = yield* EventStore
        const appended = yield* store.append([
          { type: "canvas.node.created", actor: actor("tester"), source: "cli", payload: { id: "a", label: "A" } },
          { type: "canvas.node.created", actor: actor("tester"), source: "cli", payload: { id: "b", label: "B" } },
          { type: "canvas.node.created", actor: actor("tester"), source: "cli", payload: { id: "c", label: "C" } },
        ])
        const after = yield* store.queryAfter(appended[0]!.id, {}, 10)
        expect(after.length).toBe(2)
        expect(after[0]!.id).toBe(appended[1]!.id)
        expect(after[1]!.id).toBe(appended[2]!.id)
        // Cursor itself must not be included.
        expect(after.find((e) => e.id === appended[0]!.id)).toBeUndefined()
      }).pipe(Effect.provide(makeLayer())),
    )

    it.effect("queryAfter('latest') returns []", () =>
      Effect.gen(function* () {
        const store = yield* EventStore
        yield* store.append([
          { type: "canvas.node.created", actor: actor("tester"), source: "cli", payload: { id: "a", label: "A" } },
          { type: "canvas.node.created", actor: actor("tester"), source: "cli", payload: { id: "b", label: "B" } },
        ])
        const got = yield* store.queryAfter("latest", {}, 10)
        expect(got.length).toBe(0)
      }).pipe(Effect.provide(makeLayer())),
    )
  })
}
