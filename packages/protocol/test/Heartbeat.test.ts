import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Chunk, Effect, Exit, Fiber, Stream, TestClock } from "effect"
import {
  clampIntervalMs,
  heartbeatGuard,
  isHeartbeat,
  makeHeartbeatStream,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  WatchdogTimeout,
  type Heartbeat,
} from "../src/index.js"

/**
 * Unit tests for `Heartbeat.ts` — the shared liveness contract
 * between `subscribeHandler` (server-side emit) and
 * `@rxweave/store-cloud` (client-side watchdog).
 *
 * The end-to-end behavior is also covered by the Subscribe handler
 * tests and CloudStore tests; this file pins the module's own
 * invariants so a future change to the contract can't drift between
 * the two consumers undetected.
 */

describe("clampIntervalMs", () => {
  const cases: ReadonlyArray<{ input: number; effective: number }> = [
    { input: 0, effective: MIN_INTERVAL_MS },
    { input: -100, effective: MIN_INTERVAL_MS },
    { input: 999, effective: MIN_INTERVAL_MS },
    { input: 1000, effective: 1000 },
    { input: 1500, effective: 1500 },
    { input: 30_000, effective: 30_000 },
    { input: 300_000, effective: MAX_INTERVAL_MS },
    { input: 300_001, effective: MAX_INTERVAL_MS },
    { input: 600_000, effective: MAX_INTERVAL_MS },
    // Non-finite values (NaN, ±Infinity) all clamp to MIN_INTERVAL_MS
    // because `Number.isFinite` is the first gate. Documenting the
    // existing behavior — "max possible value" Infinity falling to MIN
    // is counter-intuitive but matches pre-v0.5.2 semantics; changing
    // it would be a contract break for any caller that relies on
    // NaN-as-zero handling.
    { input: Number.NaN, effective: MIN_INTERVAL_MS },
    { input: Number.POSITIVE_INFINITY, effective: MIN_INTERVAL_MS },
    { input: Number.NEGATIVE_INFINITY, effective: MIN_INTERVAL_MS },
  ]

  for (const { input, effective } of cases) {
    it.effect(`${input} → ${effective}`, () =>
      Effect.sync(() => {
        expect(clampIntervalMs(input)).toBe(effective)
      }),
    )
  }
})

describe("isHeartbeat", () => {
  it.effect("returns true for { _tag: 'Heartbeat', at }", () =>
    Effect.sync(() => {
      expect(isHeartbeat({ _tag: "Heartbeat", at: 0 })).toBe(true)
      expect(isHeartbeat({ _tag: "Heartbeat", at: 12345 })).toBe(true)
    }),
  )

  it.effect("returns false for an EventEnvelope-shaped object", () =>
    Effect.sync(() => {
      expect(
        isHeartbeat({
          id: "evt-1",
          type: "x",
          actor: "a",
          source: "cli",
          timestamp: 0,
          payload: {},
        }),
      ).toBe(false)
    }),
  )

  it.effect("returns false for unknown sentinels", () =>
    Effect.sync(() => {
      expect(isHeartbeat({ _tag: "ProgressMarker", at: 0 })).toBe(false)
      expect(isHeartbeat(null)).toBe(false)
      expect(isHeartbeat(undefined)).toBe(false)
      expect(isHeartbeat({})).toBe(false)
    }),
  )
})

describe("makeHeartbeatStream", () => {
  it.scoped("emits first heartbeat immediately", () =>
    Effect.gen(function* () {
      const first = yield* Stream.runHead(makeHeartbeatStream(1000)).pipe(
        Effect.timeout("100 millis"),
      )
      expect(first._tag).toBe("Some")
      const item = (first as { value: Heartbeat }).value
      expect(item._tag).toBe("Heartbeat")
      expect(typeof item.at).toBe("number")
    }),
  )

  it.scoped("self-clamps below-minimum requests up to MIN_INTERVAL_MS (bug 1)", () =>
    // Codex review: callers MUST NOT be able to bypass the clamp by
    // calling `makeHeartbeatStream` directly with a sub-minimum
    // value. Prior to v0.5.2 the clamp lived in the Subscribe handler
    // around the call site; a future private cloud handler bypassing
    // `@effect/rpc` could have re-emitted at the unclamped cadence
    // and re-introduced the sub-second watchdog drift. The clamp
    // moved inside `makeHeartbeatStream` itself so the wire-range
    // invariant is local.
    Effect.gen(function* () {
      // Request 500 ms (below MIN_INTERVAL_MS=1000). Expect the second
      // heartbeat NOT to arrive until ~1000 ms have elapsed.
      const fiber = yield* Effect.fork(
        Stream.runCollect(makeHeartbeatStream(500).pipe(Stream.take(2))),
      )
      // Just before the clamped interval — second heartbeat must not
      // have landed yet.
      yield* TestClock.adjust("999 millis")
      const partial = yield* Fiber.poll(fiber)
      expect(partial._tag).toBe("None")
      // Cross the clamped threshold.
      yield* TestClock.adjust("2 millis")
      const exit = yield* Fiber.await(fiber)
      const items = Chunk.toReadonlyArray(
        (exit as { _tag: "Success"; value: Chunk.Chunk<Heartbeat> }).value,
      )
      expect(items.length).toBe(2)
    }),
  )

  it.scoped("emits at the clamped cadence (1500 ms → 1500 ms)", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        Stream.runCollect(makeHeartbeatStream(1500).pipe(Stream.take(3))),
      )
      // Three heartbeats fire at t=0, t=1500, t=3000. Advance just
      // past the third tick.
      yield* TestClock.adjust("3001 millis")
      const exit = yield* Fiber.await(fiber)
      const items = Chunk.toReadonlyArray(
        (exit as { _tag: "Success"; value: Chunk.Chunk<Heartbeat> }).value,
      )
      expect(items.length).toBe(3)
    }),
  )
})

describe("heartbeatGuard — strip semantics", () => {
  it.scoped("heartbeats are removed from the output stream", () =>
    Effect.gen(function* () {
      // Single-shot input: [Heartbeat, envelope-like]. Output should
      // be the envelope only.
      const input: Stream.Stream<{ id?: string } | Heartbeat> = Stream.fromIterable([
        { _tag: "Heartbeat", at: 0 } as Heartbeat,
        { id: "evt-1" } as { id?: string },
      ])
      const guarded = input.pipe(heartbeatGuard(1000))
      const fiber = yield* Effect.fork(
        Stream.runCollect(guarded.pipe(Stream.take(1))),
      )
      // The first item the consumer pulls is the envelope; advance
      // a small amount in case Stream.fromIterable involves a tick.
      yield* TestClock.adjust("1 millis")
      const exit = yield* Fiber.await(fiber)
      const items = Chunk.toReadonlyArray(
        (exit as { _tag: "Success"; value: Chunk.Chunk<{ id?: string }> }).value,
      )
      expect(items.length).toBe(1)
      expect(items[0]!.id).toBe("evt-1")
    }),
  )
})

describe("heartbeatGuard — watchdog", () => {
  it.scoped("does NOT fire when no heartbeat is observed (old-server compat)", () =>
    // Old servers (cloud-v0.2) accept the heartbeat field but don't
    // emit. The watchdog must stay disarmed in that case — firing
    // would manufacture a reconnect storm against a server that's
    // perfectly healthy.
    Effect.gen(function* () {
      const source = Stream.never as unknown as Stream.Stream<
        { id?: string } | Heartbeat,
        never,
        never
      >
      const fiber = yield* Effect.fork(
        Stream.runCollect(source.pipe(heartbeatGuard(1000), Stream.take(1))),
      )
      // 60s — well past any threshold. Watchdog must not arm.
      yield* TestClock.adjust("60000 millis")
      const status = yield* Fiber.status(fiber)
      expect(status._tag).toBe("Suspended")
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.scoped("fires after clampedInterval × 3 of silence post-heartbeat", () =>
    Effect.gen(function* () {
      // Emit one heartbeat at t=0 then go silent (Stream.never).
      const source: Stream.Stream<Heartbeat, never, never> = Stream.concat(
        Stream.fromIterable([{ _tag: "Heartbeat", at: 0 } as Heartbeat]),
        Stream.never,
      )
      const guarded = source.pipe(heartbeatGuard(1000))
      const fiber = yield* Effect.fork(
        Stream.runCollect(guarded.pipe(Stream.take(1))),
      )
      // Threshold = 1000 × 3 = 3000 ms. The 1Hz watchdog tick at
      // t=4000 sees `now - at = 4000 > 3000` → fires.
      yield* TestClock.adjust("4100 millis")
      const exit = yield* Fiber.await(fiber)
      expect(exit._tag).toBe("Failure")
      const failure = Exit.causeOption(exit as Exit.Exit<unknown, WatchdogTimeout>)
      expect(failure._tag).toBe("Some")
    }),
  )

  it.scoped("uses clamped interval for threshold (bug 1 regression)", () =>
    // Bug 1: pre-v0.5.2 client computed idleThreshold = intervalMs * 3
    // from the unclamped request. With intervalMs:100 the buggy
    // threshold was 300 ms — well below the server's clamped 1000 ms
    // gap. Fixed by computing threshold from the clamped value inside
    // heartbeatGuard.
    //
    // This is the same shape as the CloudStore-level regression test
    // but pinned at the module boundary so a future re-org cannot
    // silently re-introduce the drift.
    Effect.gen(function* () {
      // Single heartbeat at t=0 then silence. After fix, threshold
      // is clamp(100) × 3 = 3000 ms — same as the previous test, so
      // 1500 ms of advance keeps the fiber Suspended. Under the bug
      // the threshold would be 300 ms and the fiber would Fail.
      const source: Stream.Stream<Heartbeat, never, never> = Stream.concat(
        Stream.fromIterable([{ _tag: "Heartbeat", at: 0 } as Heartbeat]),
        Stream.never,
      )
      const guarded = source.pipe(heartbeatGuard(100))
      const fiber = yield* Effect.fork(
        Stream.runCollect(guarded.pipe(Stream.take(1))),
      )
      yield* TestClock.adjust("1500 millis")
      const status = yield* Fiber.status(fiber)
      expect(status._tag).toBe("Suspended")
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.scoped("source errors pass through (no error-channel widening beyond WatchdogTimeout)", () =>
    Effect.gen(function* () {
      class SourceFailed extends Error {
        readonly _tag = "SourceFailed"
      }
      const source: Stream.Stream<Heartbeat, SourceFailed, never> = Stream.fail(
        new SourceFailed(),
      )
      const guarded = source.pipe(heartbeatGuard(1000))
      const exit = yield* Stream.runCollect(guarded).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.scoped("heartbeats keep arming the Ref — long-lived healthy stream does not fire", () =>
    // Pin the cooperation between makeHeartbeatStream's cadence and
    // heartbeatGuard's threshold. The server emits at the clamped
    // 1000ms cadence; the guard's threshold is 3000ms; running for
    // 10 seconds must not trigger a single false WatchdogTimeout.
    Effect.gen(function* () {
      // Compose: server-side emitter at the clamped cadence, fed
      // straight into the guard.
      const source = makeHeartbeatStream(1000) as Stream.Stream<
        Heartbeat,
        never,
        never
      >
      const guarded = source.pipe(heartbeatGuard(1000))
      const fiber = yield* Effect.fork(
        Stream.runCollect(guarded.pipe(Stream.take(1))),
      )
      yield* TestClock.adjust("10000 millis")
      const status = yield* Fiber.status(fiber)
      // No envelopes ever arrive (source is heartbeats only). Guard
      // strips them; the runCollect is still pulling — Suspended.
      expect(status._tag).toBe("Suspended")
      yield* Fiber.interrupt(fiber)
    }),
  )
})
