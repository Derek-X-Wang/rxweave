/**
 * Cross-instance visibility test.
 *
 * Verifies that events appended to a JSONL file by one FileStore instance
 * (simulating another process) become visible to a SECOND FileStore instance
 * on the same file within a bounded polling wait (~200ms interval).
 *
 * This exercises the tail fiber's offset-based polling introduced by the
 * fix to commit a1f432c — specifically:
 *  - stat early-return when file hasn't grown (no read)
 *  - read only the new [readBytes, fileSize) tail bytes when it has
 *  - partial-line safety (only advance past complete newline-terminated lines)
 */
import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Context, Duration, Effect, Fiber, Layer, Schedule, Schema, Stream } from "effect"
import { FileSystem } from "@effect/platform"
import { BunFileSystem } from "@effect/platform-bun"
import { EventStore } from "@rxweave/core"
import { EventEnvelope } from "@rxweave/schema"
import { FileStore } from "../src/index.js"
import type { ActorId } from "@rxweave/schema"

const actor = (v: string): ActorId => v as ActorId
const encode = Schema.encodeSync(Schema.parseJson(EventEnvelope))

/**
 * Build a FileStore.Live over a given path and yield the resolved EventStore.
 * The store is scoped to the surrounding it.scopedLive scope.
 */
const buildStore = (path: string) =>
  Effect.gen(function* () {
    const ctx = yield* Layer.build(FileStore.Live({ path }))
    return Context.get(ctx, EventStore)
  })

/**
 * Retry an effect until it succeeds, with bounded retries and a delay between each.
 * Equivalent to polling until condition is met, up to maxRetries × delayMs = total budget.
 */
const pollUntil = <A>(
  check: Effect.Effect<A, string>,
  { retries, delayMs }: { retries: number; delayMs: number },
) =>
  Effect.retry(
    check,
    Schedule.addDelay(Schedule.recurs(retries), () => Duration.millis(delayMs)),
  )

describe("cross-instance file-tail visibility", () => {
  /**
   * Primary cross-process simulation:
   *  1. Open instance A on a temp file.
   *  2. Append event-A via A (so it is on disk).
   *  3. Open instance B on the SAME file.
   *  4. Append event-B via A (simulates another process writing after B started).
   *  5. Poll B.query() until event-B appears, with a 2 s timeout.
   */
  it.scopedLive("instance B sees events appended by instance A after B started", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      const path = `${tmp}/events.jsonl`

      // Build instance A — this creates the file and warms the store.
      const storeA = yield* buildStore(path)

      // Append a seed event via A so the file is non-empty before B opens.
      yield* storeA.append([
        { type: "cross.seed", actor: actor("a"), source: "cli", payload: {} },
      ])

      // Build instance B on the SAME file — simulates a second process.
      // B recovers the seed event from disk on boot.
      const storeB = yield* buildStore(path)

      // Verify B can already see the seed event (sanity check for recovery).
      const seedCheck = yield* storeB.query({}, 10)
      expect(seedCheck.length).toBe(1)
      expect(seedCheck[0]!.type).toBe("cross.seed")

      // Now append a NEW event via A AFTER B has already started.
      // B does NOT have this in its in-memory store yet — it must discover
      // it via the 200ms background tail fiber.
      const appended = yield* storeA.append([
        { type: "cross.tail", actor: actor("a"), source: "cli", payload: { seq: 1 } },
      ])
      const tailEventId = appended[0]!.id

      // Poll B's query() until the new event appears, with a 2s budget.
      // The poll interval in FileStore is 200ms, so ~10 cycles is plenty.
      const found = yield* pollUntil(
        Effect.gen(function* () {
          const events = yield* storeB.query({}, 20)
          const tailEvent = events.find((e) => e.id === tailEventId)
          if (!tailEvent) return yield* Effect.fail("not yet visible")
          return tailEvent
        }),
        { retries: 20, delayMs: 100 }, // up to 2s
      )

      expect(found.type).toBe("cross.tail")
      expect(found.id).toBe(tailEventId)
    }).pipe(Effect.provide(BunFileSystem.layer)),
  )

  /**
   * Subscribe-based cross-instance test.
   *
   * Opens instance B's subscribe stream BEFORE the event is appended via A,
   * then asserts the event appears in the stream within a bounded time.
   * B's subscribe uses the pubsub, which is fed by the background tail fiber
   * when a cross-process event is detected.
   */
  it.scopedLive("B's subscribe stream receives events appended by A after subscribe", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      const path = `${tmp}/events.jsonl`

      const storeA = yield* buildStore(path)
      const storeB = yield* buildStore(path)

      // Start a subscriber on B listening from 'latest' (no replay).
      // The subscriber will block until one event arrives via B's pubsub,
      // which is fed by the 200ms tail fiber when A writes.
      const subscribeFiber = yield* Effect.fork(
        storeB
          .subscribe({ cursor: "latest" })
          .pipe(Stream.take(1), Stream.runCollect),
      )

      // Give the subscriber a moment to register before A writes.
      yield* Effect.sleep(Duration.millis(50))

      // Append via A — B's tail fiber will detect this within ~200ms and
      // publish it to B's pubsub, unblocking the subscriber.
      const appended = yield* storeA.append([
        { type: "cross.subscribe", actor: actor("a"), source: "cli", payload: {} },
      ])
      const expectedId = appended[0]!.id

      // Wait for the subscriber to collect one event, with a 2s timeout.
      // Fiber.join re-raises if the fiber fails; we add a separate timeout
      // to avoid hanging if the event never arrives.
      const collected = yield* Fiber.join(subscribeFiber).pipe(
        Effect.timeout(Duration.seconds(2)),
      )

      // Effect.timeout fails with TimeoutException on timeout — if we reach
      // here, collected is Chunk<EventEnvelope>.
      const events = Array.from(collected)
      expect(events.length).toBe(1)
      expect(events[0]!.id).toBe(expectedId)
      expect(events[0]!.type).toBe("cross.subscribe")
    }).pipe(Effect.provide(BunFileSystem.layer)),
  )

  /**
   * Partial-line safety: write a complete JSON event line in two pieces —
   * first without the trailing '\n', wait a poll cycle, then add the '\n'.
   * Verifies:
   *  - B does not crash or corrupt readBytes when it sees the partial
   *  - B picks up the event once the line is complete (after the '\n' arrives)
   */
  it.scopedLive("B holds back a partial line and picks it up once the newline arrives", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      const path = `${tmp}/events.jsonl`

      // Build B on an empty file.
      const storeB = yield* buildStore(path)

      // Construct a valid EventEnvelope and encode it as a JSONL line.
      const envelope = new EventEnvelope({
        id: "01HXC5QKZ8M9A0TN3P1Q2R4S5V" as never,
        type: "partial.line",
        actor: actor("external"),
        source: "cli",
        timestamp: Date.now(),
        payload: {},
      })
      const jsonLine = encode(envelope)
      const lineBytes = new TextEncoder().encode(jsonLine)

      // Step 1: write the JSON body WITHOUT the trailing '\n'.
      // This simulates another process mid-write on the file.
      yield* fs.writeFile(path, lineBytes)

      // Wait for at least one poll cycle.  B should see the file has grown
      // but the new bytes have no trailing '\n' — so it defers the line.
      yield* Effect.sleep(Duration.millis(400))

      // B must still have 0 events — the partial line was correctly held back.
      const beforeComplete = yield* storeB.query({}, 10)
      expect(beforeComplete.length).toBe(0)

      // Step 2: complete the line by appending the '\n'.
      yield* fs.writeFile(
        path,
        new Uint8Array([...lineBytes, 0x0a]), // 0x0a = '\n'
      )

      // Poll B until the event appears — B's next tail poll should pick up
      // the now-complete line starting from its last known readBytes.
      const found = yield* pollUntil(
        Effect.gen(function* () {
          const events = yield* storeB.query({}, 10)
          const ev = events.find((e) => e.id === envelope.id)
          if (!ev) return yield* Effect.fail("not yet visible")
          return ev
        }),
        { retries: 20, delayMs: 100 },
      )

      expect(found.type).toBe("partial.line")
      expect(found.id).toBe(envelope.id)
    }).pipe(Effect.provide(BunFileSystem.layer)),
  )
})
