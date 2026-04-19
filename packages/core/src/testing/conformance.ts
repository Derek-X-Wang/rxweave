import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer, Ref, Stream } from "effect"
import type { ActorId } from "@rxweave/schema"
import { EventStore } from "../EventStore.js"

export interface ConformanceOptions {
  readonly name: string
  readonly layer: Layer.Layer<EventStore>
  readonly fresh?: () => Layer.Layer<EventStore>
  readonly coldStartFactory?: () => Layer.Layer<EventStore>
}

const actor = (v: string): ActorId => v as ActorId

export const runConformance = (opts: ConformanceOptions) => {
  const { name, layer, fresh } = opts
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

    it.effect("two concurrent subscribers observe the same ordered stream", () =>
      Effect.gen(function* () {
        const store = yield* EventStore
        // Append the full set BEFORE subscribing so both subscribers consume
        // from the same snapshot; avoids live-fan-out race variance across
        // adapters that handle live delivery differently.
        const appended = yield* store.append([
          { type: "canvas.node.created", actor: actor("tester"), source: "cli", payload: { id: "a", label: "A" } },
          { type: "canvas.node.created", actor: actor("tester"), source: "cli", payload: { id: "b", label: "B" } },
          { type: "canvas.node.created", actor: actor("tester"), source: "cli", payload: { id: "c", label: "C" } },
        ])
        const f1 = yield* store
          .subscribe({ cursor: "earliest" })
          .pipe(Stream.take(3), Stream.runCollect, Effect.fork)
        const f2 = yield* store
          .subscribe({ cursor: "earliest" })
          .pipe(Stream.take(3), Stream.runCollect, Effect.fork)
        const r1 = Array.from(yield* Fiber.join(f1))
        const r2 = Array.from(yield* Fiber.join(f2))
        const ids1 = r1.map((e) => e.id)
        const ids2 = r2.map((e) => e.id)
        const expected = appended.map((e) => e.id)
        expect(ids1).toEqual(expected)
        expect(ids2).toEqual(expected)
      }).pipe(Effect.provide(makeLayer())),
    )

    it.scopedLive("slow subscriber under flood stays bounded and non-crashing", () =>
      Effect.gen(function* () {
        const store = yield* EventStore
        const processed = yield* Ref.make(0)
        const subFiber = yield* Effect.forkScoped(
          store.subscribe({ cursor: "latest" }).pipe(
            Stream.tap(() =>
              Effect.sleep(Duration.millis(1)).pipe(
                Effect.zipRight(Ref.update(processed, (n) => n + 1)),
              ),
            ),
            Stream.runDrain,
          ),
        )
        // Let the subscriber wire up before flooding.
        yield* Effect.sleep(Duration.millis(20))
        const flood = Array.from({ length: 2000 }, (_, i) => ({
          type: "flood.tick",
          actor: actor("flooder"),
          source: "cli" as const,
          payload: { i },
        }))
        yield* store.append(flood)
        // Give the slow consumer ~200ms to process what it can.
        yield* Effect.sleep(Duration.millis(200))
        const count = yield* Ref.get(processed)
        expect(count).toBeGreaterThan(0)
        // Store should still accept writes after the flood.
        const after = yield* store.append([
          { type: "post.flood", actor: actor("flooder"), source: "cli", payload: {} },
        ])
        expect(after.length).toBe(1)
        yield* Fiber.interrupt(subFiber)
        // TODO(v0.2.x): assert SubscriberLagged tag once adapters emit it.
      }).pipe(Effect.provide(makeLayer())),
    )

    it.scopedLive("in-flight subscribers terminate when layer scope closes", () =>
      Effect.gen(function* () {
        const cleaned = yield* Ref.make(false)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* EventStore
            yield* Effect.forkScoped(
              store.subscribe({ cursor: "earliest" }).pipe(
                Stream.runDrain,
                Effect.ensuring(Ref.set(cleaned, true)),
              ),
            )
            yield* Effect.sleep(Duration.millis(10))
            yield* store.append([
              { type: "shutdown.probe", actor: actor("tester"), source: "cli", payload: {} },
            ])
            yield* Effect.sleep(Duration.millis(20))
          }).pipe(Effect.provide(makeLayer())),
        )
        expect(yield* Ref.get(cleaned)).toBe(true)
      }),
    )

    if (opts.coldStartFactory) {
      const coldStartFactory = opts.coldStartFactory
      it.effect("cold-start recovery boots from torn tail without data loss", () =>
        Effect.gen(function* () {
          const store = yield* EventStore
          const events = yield* store.query({}, 100)
          // Factory contract: populates the backing store with exactly one
          // recoverable event of type "recovery.probe", plus a torn tail
          // that must be truncated.
          expect(events.length).toBe(1)
          expect(events[0]!.type).toBe("recovery.probe")
        }).pipe(Effect.provide(coldStartFactory())),
      )
    }
  })
}
