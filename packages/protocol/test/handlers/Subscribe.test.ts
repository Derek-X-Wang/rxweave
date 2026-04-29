import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Chunk, Effect, Exit, Fiber, Stream, TestClock } from "effect"
import { EventStore } from "@rxweave/core"
import { MemoryStore } from "@rxweave/store-memory"
import { subscribeHandler } from "../../src/handlers/Subscribe.js"

describe("subscribeHandler", () => {
  it.scoped("streams events matching the filter from the cursor", () =>
    Effect.gen(function* () {
      const store = yield* EventStore
      yield* store.append([
        { type: "demo.ping", actor: "tester", source: "cli", payload: {} },
        { type: "demo.pong", actor: "tester", source: "cli", payload: {} },
      ])

      const stream = subscribeHandler({ cursor: "earliest", filter: { types: ["demo.ping"] } })
      const collected = yield* Stream.runCollect(
        stream.pipe(Stream.take(1)),
      )
      const arr = Chunk.toReadonlyArray(collected)
      expect(arr.length).toBe(1)
      expect(arr[0]!.type).toBe("demo.ping")
    }).pipe(Effect.provide(MemoryStore.Live)),
  )
})

describe("subscribeHandler — heartbeat undefined (backwards-compat)", () => {
  it.scoped("emits no Heartbeat items when heartbeat arg is omitted", () =>
    Effect.gen(function* () {
      const store = yield* EventStore
      yield* store.append([
        { type: "demo.ping", actor: "tester", source: "cli", payload: {} },
        { type: "demo.pong", actor: "tester", source: "cli", payload: {} },
      ])

      const stream = subscribeHandler({ cursor: "earliest" })
      const collected = yield* Stream.runCollect(stream.pipe(Stream.take(2)))
      const items = Chunk.toReadonlyArray(collected)

      expect(items.length).toBe(2)
      for (const item of items) {
        expect((item as { _tag?: string })._tag).not.toBe("Heartbeat")
        expect((item as { id?: string }).id).toBeDefined()
      }
    }).pipe(Effect.provide(MemoryStore.Live)),
  )
})

describe("subscribeHandler — heartbeat injection", () => {
  it.scoped("emits one heartbeat immediately on subscribe-open", () =>
    Effect.gen(function* () {
      const stream = subscribeHandler({
        cursor: "earliest",
        heartbeat: { intervalMs: 1000 },
      })
      const first = yield* Stream.runHead(stream).pipe(Effect.timeout("100 millis"))
      expect(first._tag).toBe("Some")
      expect((first as { value: { _tag: string } }).value._tag).toBe("Heartbeat")
    }).pipe(Effect.provide(MemoryStore.Live)),
  )

  it.scoped("emits N+1 heartbeats over N intervals after the first", () =>
    Effect.gen(function* () {
      const stream = subscribeHandler({
        cursor: "earliest",
        heartbeat: { intervalMs: 1000 },
      })

      const fiber = yield* Effect.fork(
        Stream.runCollect(
          stream.pipe(
            Stream.filter((item) => (item as { _tag?: string })._tag === "Heartbeat"),
            Stream.take(4),
          ),
        ),
      )
      yield* TestClock.adjust("3500 millis")
      const exit = yield* Fiber.await(fiber)
      const items = Chunk.toReadonlyArray(
        (exit as Exit.Exit<Chunk.Chunk<unknown>, unknown> & { _tag: "Success"; value: Chunk.Chunk<unknown> }).value,
      )
      expect(items.length).toBe(4)
    }).pipe(Effect.provide(MemoryStore.Live)),
  )

  it.scoped("does NOT double-emit at t=0 (regression for Stream.concat mistake)", () =>
    Effect.gen(function* () {
      const stream = subscribeHandler({
        cursor: "earliest",
        heartbeat: { intervalMs: 1000 },
      })
      const fiber = yield* Effect.fork(
        Stream.runCollect(
          stream.pipe(
            Stream.filter((item) => (item as { _tag?: string })._tag === "Heartbeat"),
            Stream.take(2),
          ).pipe(Effect.timeout("500 millis")),
        ),
      )
      // advance TestClock past the 500ms timeout but not to the 1000ms mark
      // so the second heartbeat never fires and the timeout returns Left
      yield* TestClock.adjust("600 millis")
      const exit = yield* Fiber.await(fiber)
      expect(exit._tag).toBe("Failure")
    }).pipe(Effect.provide(MemoryStore.Live)),
  )
})

describe("subscribeHandler — intervalMs clamping", () => {
  const cases: ReadonlyArray<{ input: number; effective: number }> = [
    { input: 0, effective: 1000 },
    { input: -100, effective: 1000 },
    { input: 999, effective: 1000 },
    { input: 1000, effective: 1000 },
    { input: 30_000, effective: 30_000 },
    { input: 300_000, effective: 300_000 },
    { input: 300_001, effective: 300_000 },
    { input: Number.NaN, effective: 1000 },
  ]

  for (const { input, effective } of cases) {
    it.scoped(
      `intervalMs ${input} → effective ${effective}`,
      () =>
        Effect.gen(function* () {
          const stream = subscribeHandler({
            cursor: "earliest",
            heartbeat: { intervalMs: input },
          })

          const fiber = yield* Effect.fork(
            Stream.runCollect(
              stream.pipe(
                Stream.filter((item) => (item as { _tag?: string })._tag === "Heartbeat"),
                Stream.take(2),
              ),
            ),
          )
          // Advance just under effective interval — second heartbeat must NOT have arrived.
          yield* TestClock.adjust(`${effective - 1} millis`)
          // Second heartbeat must NOT have arrived yet — guards against
          // clampInterval being silently bypassed (e.g. input 999 would deliver
          // at 999ms unclamped vs 1000ms clamped, but Stream.take(2) without
          // this poll cannot distinguish them).
          const partial = yield* Fiber.poll(fiber)
          expect(partial._tag).toBe("None")
          // Advance the remaining 2ms (cross the threshold).
          yield* TestClock.adjust("2 millis")
          const exit = yield* Fiber.await(fiber)
          const items = Chunk.toReadonlyArray(
            (exit as { _tag: "Success"; value: Chunk.Chunk<unknown> }).value,
          )
          expect(items.length).toBe(2)
        }).pipe(Effect.provide(MemoryStore.Live)),
    )
  }
})
