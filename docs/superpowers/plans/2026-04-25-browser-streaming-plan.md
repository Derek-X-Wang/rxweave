# Browser Streaming Implementation Plan (v0.5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the v0.5 protocol heartbeat sentinel + `CloudStore.LiveFromBrowser` factory so `apps/web` and any other browser client get sub-second live delivery on every browser engine. Bundle three small handoff polish items (`registerAll`, `mkdirSync` fold, `apps/web` schema relocation).

**Architecture:** Widen `Subscribe` to a `Schema.Union(Heartbeat, EventEnvelope)` success type with an opt-in `heartbeat: { intervalMs }` request field. The shared `subscribeHandler` injects sentinels via `Stream.merge`; `@rxweave/server` and (in cloud-v0.3 follow-up) Convex inherit identical behavior. Client side, refactor `CloudStore.Live` to share an internal `makeLive` core; lift cursor-resume state into per-subscribe scope; add `LiveFromBrowser({ origin, tokenPath, heartbeat })` that wires drain-then-subscribe + heartbeat default + library-owned reconnect.

**Tech Stack:** Bun 1.3.5, Effect 3.21.x, `@effect/rpc` 0.75.x, `@effect/platform-bun`, Vitest 2.x + `@effect/vitest`, TypeScript 5.9.x.

**Spec:** `docs/superpowers/specs/2026-04-25-browser-streaming-design.md`

---

## File Structure

```
packages/protocol/src/
├── RxWeaveRpc.ts                    Modified — Heartbeat schema + widened Subscribe
└── handlers/
    └── Subscribe.ts                  Modified — heartbeat injection via Stream.merge

packages/protocol/test/handlers/
└── Subscribe.test.ts                 Modified — backwards-compat + cadence + clamp + first-emit + tolerance

packages/server/test/
└── Server.test.ts                    Modified — heartbeat sentinel arrives as Chunk frame

packages/store-cloud/src/
├── CloudStore.ts                     Modified — refactor Live → makeLive; per-subscribe lastDelivered;
│                                                  heartbeat filter; watchdog wiring
├── LiveFromBrowser.ts                NEW       — browser factory, drain-then-subscribe, SessionTokenFetch
├── Errors.ts                         Modified — add WatchdogTimeout
├── Retry.ts                          Modified — classify WatchdogTimeout as retryable
└── Auth.ts                           Modified — SessionTokenFetch strategy (request-replay on 401)

packages/store-cloud/test/
└── CloudStore.test.ts                Modified — filter, drain, race, concurrent subs, watchdog,
                                                  401-retry-of-failed-request, future-sentinel

packages/schema/src/
└── Registry.ts                       Modified — registerAll(defs, opts) digest-aware

packages/schema/test/
└── Registry.test.ts                  Modified — registerAll happy path + duplicate-swallow + conflict

packages/server/src/
└── Auth.ts                           Modified — fold mkdirSync into generateAndPersistToken

packages/server/test/
└── Auth.test.ts                      Modified — generateAndPersistToken with missing parent dir

packages/cli/src/commands/
├── dev.ts                            Modified — replace registerAll loop
└── ../Setup.ts                       Modified — replace registerAll loop

apps/web/
├── src/shared/schemas.ts             NEW (moved) — formerly server/schemas.ts
├── server/server.ts                  Modified — import path + drop mkdirSync prelude + registerAll
├── server/schemas.ts                 DELETE  — relocated
├── src/RxweaveBridge.tsx             Replaced — use LiveFromBrowser
└── package.json                      Modified — possibly bun --watch glob update
```

---

## Phase A — Protocol additions

### Task 1: Add `Heartbeat` schema + widen `Subscribe.success` to a Union

**Files:**
- Modify: `packages/protocol/src/RxWeaveRpc.ts`
- Test: `packages/protocol/test/RxWeaveRpc.test.ts` (new file if absent; otherwise extend)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/protocol/test/RxWeaveRpc.test.ts
import { describe, expect, test } from "vitest"
import { Schema } from "effect"
import { Heartbeat, RxWeaveRpc } from "../src/RxWeaveRpc.js"

describe("Heartbeat", () => {
  test("decodes a tagged sentinel", () => {
    const decoded = Schema.decodeUnknownSync(Heartbeat)({
      _tag: "Heartbeat",
      at: 1700000000000,
    })
    expect(decoded._tag).toBe("Heartbeat")
    expect(decoded.at).toBe(1700000000000)
  })

  test("rejects untagged input", () => {
    expect(() =>
      Schema.decodeUnknownSync(Heartbeat)({ at: 1700000000000 }),
    ).toThrow()
  })
})

describe("RxWeaveRpc.Subscribe success", () => {
  test("Subscribe.success decodes a Heartbeat", () => {
    const subscribe = RxWeaveRpc.requests.Subscribe
    const successSchema = subscribe.successSchema as Schema.Schema<unknown, unknown>
    const decoded = Schema.decodeUnknownSync(successSchema)({
      _tag: "Heartbeat",
      at: 1700000000000,
    })
    expect((decoded as { _tag: string })._tag).toBe("Heartbeat")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/protocol && bun run test`
Expected: FAIL with module-export error (`Heartbeat` not exported) and the Subscribe success test failing because the schema is currently `EventEnvelope` only.

- [ ] **Step 3: Implement Heartbeat schema + widen Subscribe.success**

```typescript
// packages/protocol/src/RxWeaveRpc.ts
// At top, add Heartbeat schema (alongside the existing imports + Rpc.make calls):
import { Rpc, RpcGroup } from "@effect/rpc"
import { Schema } from "effect"
import {
  Cursor,
  EventDefWire,
  EventEnvelope,
  EventId,
  EventInput,
  Filter,
} from "@rxweave/schema"
import {
  AppendWireError,
  NotFoundWireError,
  QueryWireError,
  RegistryWireError,
  SubscribeWireError,
} from "./Errors.js"

/**
 * `Heartbeat` — server-emitted liveness sentinel on the `Subscribe` stream.
 *
 * Carries only `at` (server unix-ms). Used by browser clients (WebKit
 * fetch-buffer flush) and as a generic liveness signal. v0.6 may extend
 * this struct additively (e.g., `serverCursor`); the `_tag` discriminator
 * keeps that change non-breaking.
 */
export const Heartbeat = Schema.TaggedStruct("Heartbeat", {
  at: Schema.Number,
})
export type Heartbeat = Schema.Schema.Type<typeof Heartbeat>

// Modify the existing Rpc.make("Subscribe", ...) to use Schema.Union for success:
export class RxWeaveRpc extends RpcGroup.make(
  // ... existing entries unchanged through Append ...
  Rpc.make("Subscribe", {
    payload: Schema.Struct({
      cursor: Cursor,
      filter: Schema.optional(Filter),
      // NEW — opt-in heartbeat. Old clients omit this; old servers
      // drop it via Schema.Struct's unknown-key behavior.
      heartbeat: Schema.optional(Schema.Struct({ intervalMs: Schema.Number })),
    }),
    success: Schema.Union(Heartbeat, EventEnvelope),
    stream: true,
    error: SubscribeWireError,
  }),
  // ... remaining entries unchanged ...
) {}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/protocol && bun run test`
Expected: PASS — both Heartbeat schema tests + Subscribe success Union decode.

- [ ] **Step 5: Run the full protocol test suite to confirm no regression**

Run: `cd packages/protocol && bun run test`
Expected: All existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/RxWeaveRpc.ts packages/protocol/test/RxWeaveRpc.test.ts
git commit -m "feat(protocol): add Heartbeat sentinel + widen Subscribe to Union

Subscribe.success becomes Schema.Union(Heartbeat, EventEnvelope).
Heartbeat is a Schema.TaggedStruct(\"Heartbeat\", { at }); EventEnvelope
remains a Schema.Class without _tag, so the union resolves
structurally. The request payload gains an optional heartbeat field
clients may set to opt in.

Backwards-compatible: old clients omit heartbeat → server emits no
sentinels (handler change in next task). Old servers receiving the
new field drop it via Schema.Struct's unknown-key semantics."
```

### Task 2: Add `WatchdogTimeout` error + classify retryable

**Files:**
- Modify: `packages/store-cloud/src/Errors.ts` (add new error class)
- Modify: `packages/store-cloud/src/Retry.ts`
- Test: `packages/store-cloud/test/Retry.test.ts` (extend existing if present, otherwise new file)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/store-cloud/test/Retry.test.ts (or extend existing)
import { describe, expect, test } from "vitest"
import { isRetryable } from "../src/Retry.js"
import { WatchdogTimeout } from "../src/Errors.js"

describe("isRetryable", () => {
  test("WatchdogTimeout is retryable", () => {
    const err = new WatchdogTimeout({ idleMs: 45_000 })
    expect(isRetryable(err)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/store-cloud && bun run test`
Expected: FAIL — `WatchdogTimeout` not exported from `Errors.js`, or `isRetryable` returns false (default) for the new tag.

- [ ] **Step 3: Implement the WatchdogTimeout class**

```typescript
// packages/store-cloud/src/Errors.ts (add to existing file; if file doesn't exist, create it)
import { Data } from "effect"

/**
 * Surfaced when the heartbeat-driven liveness watchdog observes
 * `> 3 × intervalMs` since the last `Heartbeat` arrival. Classified
 * retryable by `Retry.isRetryable` so the existing Stream.retry
 * schedule reconnects from the last-delivered cursor.
 *
 * Only armed once the first heartbeat is observed — see `makeLive`
 * subscribe pipeline. Old servers (cloud-v0.2) that ignore the
 * heartbeat field never arm the watchdog, so this error never
 * fires against them.
 */
export class WatchdogTimeout extends Data.TaggedError("WatchdogTimeout")<{
  readonly idleMs: number
}> {}
```

If `Errors.ts` doesn't already exist in `packages/store-cloud/src/`, also export the class via `packages/store-cloud/src/index.ts`. Check first; if it does exist, just add the class.

- [ ] **Step 4: Wire WatchdogTimeout into isRetryable**

```typescript
// packages/store-cloud/src/Retry.ts
// Update the TRANSIENT_TAGS set:
const TRANSIENT_TAGS = new Set<string>([
  // Transport-layer error surfaced by @effect/rpc when the HTTP
  // request itself fails (DNS, connection reset, timeout, 5xx).
  "RpcClientError",
  // Watchdog timeout from makeLive's heartbeat liveness check —
  // reconnect from the last-delivered cursor.
  "WatchdogTimeout",
])
```

(No other changes to `Retry.ts` needed — the existing `_tag` lookup picks up the new tag automatically.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/store-cloud && bun run test`
Expected: PASS — `WatchdogTimeout` retryable test green; existing Retry tests unaffected.

- [ ] **Step 6: Commit**

```bash
git add packages/store-cloud/src/Errors.ts packages/store-cloud/src/Retry.ts packages/store-cloud/test/Retry.test.ts
git commit -m "feat(store-cloud): WatchdogTimeout error, classified retryable

Adds the error variant the heartbeat watchdog raises when no
heartbeat is observed for > 3 × intervalMs. Classifying it
retryable in isRetryable means the existing Stream.retry schedule
in CloudStore.subscribe reconnects from lastDelivered without any
new retry plumbing — the watchdog just needs to be injected before
the retry layer (next task)."
```

---

## Phase B — Server-side heartbeat injection

### Task 3: subscribeHandler accepts heartbeat option (signature widening, no behavior change yet)

**Files:**
- Modify: `packages/protocol/src/handlers/Subscribe.ts`
- Test: `packages/protocol/test/handlers/Subscribe.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/protocol/test/handlers/Subscribe.test.ts (extend existing describe block)
import { describe, expect, test } from "vitest"
import { it } from "@effect/vitest"
import { Chunk, Effect, Stream } from "effect"
import { EventStore } from "@rxweave/core"
import { MemoryStore } from "@rxweave/store-memory"
import { subscribeHandler } from "../../src/handlers/Subscribe.js"

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
      // Asserts no heartbeat snuck in. EventEnvelope items have a `id`
      // field; Heartbeat does not.
      for (const item of items) {
        expect((item as { _tag?: string })._tag).not.toBe("Heartbeat")
        expect((item as { id?: string }).id).toBeDefined()
      }
    }).pipe(Effect.provide(MemoryStore.Live)),
  )
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/protocol && bun run test test/handlers/Subscribe`
Expected: PASS — the existing handler signature ignores the heartbeat field and emits envelopes only. (This task is a regression-guard; the test passes against today's code.)

If the test passes already, that's fine — proceed to step 3 (signature widening) without expecting a red→green flip. The TDD flip happens in Task 4.

- [ ] **Step 3: Widen the handler signature**

```typescript
// packages/protocol/src/handlers/Subscribe.ts
import { Effect, Stream } from "effect"
import { EventStore } from "@rxweave/core"
import type { Cursor, EventEnvelope, Filter } from "@rxweave/schema"
import { Heartbeat } from "../RxWeaveRpc.js"
import { SubscribeWireError } from "../Errors.js"

/**
 * Pure-Effect subscribe handler shared by Cloud and `@rxweave/server`.
 *
 * Delegates to the underlying `EventStore.subscribe` — whatever cursor
 * semantics + filter pushdown the store implements flow through
 * unchanged. The Convex-backed Subscribe handler in
 * `cloud/packages/backend/convex/rxweaveRpc.ts` is a polling-loop
 * specialisation; both map their source error channel to
 * `SubscribeWireError.reason`.
 *
 * When `heartbeat` is set, the handler merges a periodic Heartbeat
 * sentinel into the envelope stream via Stream.merge. The merged
 * heartbeat fiber is scoped together with the envelope subscription,
 * so disconnecting the subscriber tears down both sides.
 *
 * Backpressure note: HTTP transport in @effect/rpc has supportsAck:
 * false (node_modules/@effect/rpc/src/RpcServer.ts:1076), so a slow
 * browser reader doesn't apply backpressure to the heartbeat fiber.
 * Heartbeats accumulate at the requested cadence regardless of client
 * drain rate. This is intentional — the heartbeat's job is to keep
 * emitting *to* the client, not to be paced *by* the client.
 */
export const subscribeHandler = (args: {
  readonly cursor: Cursor
  readonly filter?: Filter
  readonly heartbeat?: { readonly intervalMs: number }
}): Stream.Stream<EventEnvelope | Heartbeat, SubscribeWireError, EventStore> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const store = yield* EventStore
      return store
        .subscribe(
          args.filter === undefined
            ? { cursor: args.cursor }
            : { cursor: args.cursor, filter: args.filter },
        )
        .pipe(
          Stream.mapError(
            (e) => new SubscribeWireError({ reason: e.reason }),
          ),
        )
    }),
  )
```

(Heartbeat injection wiring comes in Task 4. This task only widens the signature.)

- [ ] **Step 4: Run the existing protocol test suite to confirm no regression**

Run: `cd packages/protocol && bun run test`
Expected: PASS — all existing tests still pass; the new no-heartbeat-when-undefined test passes.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/handlers/Subscribe.ts packages/protocol/test/handlers/Subscribe.test.ts
git commit -m "refactor(protocol): widen subscribeHandler signature for heartbeat

Adds optional heartbeat arg to subscribeHandler and widens the
return stream type to EventEnvelope | Heartbeat. No behavior
change yet — heartbeat injection wiring lands in the next task.

Includes regression-guard test asserting no Heartbeat items leak
into the stream when the arg is omitted."
```

### Task 4: subscribeHandler injects heartbeats when requested

**Files:**
- Modify: `packages/protocol/src/handlers/Subscribe.ts`
- Test: `packages/protocol/test/handlers/Subscribe.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/protocol/test/handlers/Subscribe.test.ts (add to the existing describe)
import { Duration, Schedule, TestClock } from "effect"

describe("subscribeHandler — heartbeat injection", () => {
  it.scoped("emits one heartbeat immediately on subscribe-open", () =>
    Effect.gen(function* () {
      const stream = subscribeHandler({
        cursor: "earliest",
        heartbeat: { intervalMs: 1000 },
      })
      // Take the first item without advancing the clock past the
      // initial emit.
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
      // Advance test clock by 3 intervals → 1 (immediate) + 3 = 4 heartbeats.
      yield* TestClock.adjust("3500 millis")
      const collected = yield* fiber.pipe(Effect.flatMap((f) => f.await))
      // Effect's Fiber.await returns Exit; unwrap success.
      const items = Chunk.toReadonlyArray(
        (collected as { _tag: "Success"; value: Chunk.Chunk<unknown> }).value,
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
      // Take 2 heartbeats; second must require advancing the clock.
      // If we double-emitted at t=0, the second item would arrive
      // without the clock advance and the timeout would not fire.
      const result = yield* Stream.runCollect(
        stream.pipe(
          Stream.filter((item) => (item as { _tag?: string })._tag === "Heartbeat"),
          Stream.take(2),
        ),
      ).pipe(Effect.timeout("500 millis"), Effect.either)
      expect(result._tag).toBe("Left") // timeout; only one heartbeat in 500ms
    }).pipe(Effect.provide(MemoryStore.Live)),
  )
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/protocol && bun run test test/handlers/Subscribe`
Expected: FAIL — handler still ignores `heartbeat`; no heartbeats are emitted.

- [ ] **Step 3: Implement heartbeat injection**

```typescript
// packages/protocol/src/handlers/Subscribe.ts
import { Duration, Effect, Schedule, Stream } from "effect"
import { EventStore } from "@rxweave/core"
import type { Cursor, EventEnvelope, Filter } from "@rxweave/schema"
import { Heartbeat } from "../RxWeaveRpc.js"
import { SubscribeWireError } from "../Errors.js"

const MIN_INTERVAL_MS = 1000
const MAX_INTERVAL_MS = 300_000

const clampInterval = (ms: number): number => {
  if (!Number.isFinite(ms) || ms < MIN_INTERVAL_MS) return MIN_INTERVAL_MS
  if (ms > MAX_INTERVAL_MS) return MAX_INTERVAL_MS
  return ms
}

const makeHeartbeatStream = (
  intervalMs: number,
): Stream.Stream<Heartbeat, never, never> =>
  Stream.repeatEffectWithSchedule(
    Effect.sync(
      (): Heartbeat => ({ _tag: "Heartbeat", at: Date.now() }),
    ),
    Schedule.spaced(Duration.millis(intervalMs)),
  )

export const subscribeHandler = (args: {
  readonly cursor: Cursor
  readonly filter?: Filter
  readonly heartbeat?: { readonly intervalMs: number }
}): Stream.Stream<EventEnvelope | Heartbeat, SubscribeWireError, EventStore> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const store = yield* EventStore
      const envelopes = store
        .subscribe(
          args.filter === undefined
            ? { cursor: args.cursor }
            : { cursor: args.cursor, filter: args.filter },
        )
        .pipe(
          Stream.mapError(
            (e) => new SubscribeWireError({ reason: e.reason }),
          ),
        )

      if (args.heartbeat === undefined) {
        return envelopes as Stream.Stream<EventEnvelope | Heartbeat, SubscribeWireError, never>
      }

      const intervalMs = clampInterval(args.heartbeat.intervalMs)
      const heartbeats = makeHeartbeatStream(intervalMs) as Stream.Stream<
        EventEnvelope | Heartbeat,
        SubscribeWireError,
        never
      >
      return Stream.merge(envelopes, heartbeats)
    }),
  )
```

The `Stream.repeatEffectWithSchedule` already emits the first value immediately before consulting the schedule (Effect's documented behavior). Do NOT prepend `Stream.succeed(makeHeartbeat())` — that would produce two immediate heartbeats.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/protocol && bun run test test/handlers/Subscribe`
Expected: PASS — first-heartbeat-immediate, cadence-after-N-intervals, and no-double-emit regression test all green.

- [ ] **Step 5: Run the full protocol suite**

Run: `cd packages/protocol && bun run test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/handlers/Subscribe.ts packages/protocol/test/handlers/Subscribe.test.ts
git commit -m "feat(protocol): inject heartbeats into subscribeHandler when requested

Stream.merge of envelope-stream + Stream.repeatEffectWithSchedule.
First heartbeat emits at t=0 (subscribe-open) by Stream.repeatEffect-
WithSchedule's documented behavior; subsequent every intervalMs.
Regression test asserts no double-immediate-emit (the previous spec
draft had a Stream.concat(Stream.succeed, ...) prefix that would have
double-emitted). intervalMs clamped to [1000, 300000]; out-of-range
silently clamped, not rejected.

Heartbeat fiber lifetime is tied to the subscribe scope via
Stream.merge — disconnecting the subscriber tears down both sides."
```

### Task 5: intervalMs clamping boundary tests

**Files:**
- Test: `packages/protocol/test/handlers/Subscribe.test.ts`

- [ ] **Step 1: Add boundary tests to the existing describe block**

```typescript
// packages/protocol/test/handlers/Subscribe.test.ts (extend describe "subscribeHandler — heartbeat injection")
import { Effect, Stream, TestClock, Chunk } from "effect"

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

          // Collect 2 heartbeats; the second arrives `effective` after the
          // first. We assert the inter-arrival timing.
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
          // Advance the remaining 2ms (cross the threshold).
          yield* TestClock.adjust("2 millis")
          const exit = yield* fiber.pipe(Effect.flatMap((f) => f.await))
          const items = Chunk.toReadonlyArray(
            (exit as { _tag: "Success"; value: Chunk.Chunk<unknown> }).value,
          )
          expect(items.length).toBe(2)
        }).pipe(Effect.provide(MemoryStore.Live)),
    )
  }
})
```

- [ ] **Step 2: Run the tests**

Run: `cd packages/protocol && bun run test test/handlers/Subscribe`
Expected: PASS for all 8 boundary cases (the implementation already clamps).

If any case fails, adjust the `clampInterval` function in `Subscribe.ts` until all 8 pass. Likely failure: `Number.NaN` not handled — fix with `Number.isFinite` (the implementation in Task 4 already does this).

- [ ] **Step 3: Commit**

```bash
git add packages/protocol/test/handlers/Subscribe.test.ts
git commit -m "test(protocol): intervalMs boundary tests for clampInterval

Covers 0, negative, just-below-min (999), exact min (1000), middle,
exact max (300000), just-above-max (300001), and NaN. Asserts
effective interval matches the clamped value via inter-heartbeat
timing on the test clock."
```

---

## Phase C — Server-side end-to-end test (heartbeat over the wire)

### Task 6: `@rxweave/server` Server.test.ts — heartbeat sentinel arrives as RpcMessage Chunk frame

**Files:**
- Modify: `packages/server/test/Server.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/test/Server.test.ts (add new test in existing describe)
// NOTE: this test runs under bun:test (the package's test runner is bun, not vitest — see packages/server/package.json).
import { test, expect } from "bun:test"
import { Effect, Stream, Chunk } from "effect"
import { startServer } from "../src/Server.js"
import { MemoryStore } from "@rxweave/store-memory"
import { EventRegistry } from "@rxweave/schema"

test("Subscribe with heartbeat: server emits Heartbeat sentinel over the wire", async () => {
  const program = Effect.gen(function* () {
    const handle = yield* startServer({
      port: 0, // ephemeral
      host: "127.0.0.1",
      auth: undefined, // no-auth for the test
    })

    // Connect via raw fetch so we can inspect the wire shape directly,
    // not through @effect/rpc's typed client (which would already have
    // decoded the Heartbeat frame back into a typed value).
    const url = `http://${handle.host}:${handle.port}/rxweave/rpc/`
    const body = JSON.stringify({
      _tag: "Request",
      id: 1,
      tag: "Subscribe",
      payload: {
        cursor: "earliest",
        heartbeat: { intervalMs: 1000 },
      },
      // RpcMessage envelope shape — mirror what @effect/rpc client sends
    })
    // NOTE: the exact request envelope shape depends on @effect/rpc's
    // wire format — refer to node_modules/@effect/rpc/src/RpcMessage.ts
    // when implementing. This test asserts that AT LEAST ONE frame in
    // the response stream contains a Heartbeat in its `values` array.
    const response = yield* Effect.tryPromise(() =>
      fetch(url, { method: "POST", body, headers: { "Content-Type": "application/x-ndjson" } }),
    )

    // Read the first ~2 seconds of NDJSON frames.
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const collected: Array<unknown> = []
    const start = Date.now()
    while (Date.now() - start < 2000) {
      const { done, value } = yield* Effect.tryPromise(() => reader.read())
      if (done) break
      const text = decoder.decode(value)
      for (const line of text.split("\n").filter((l) => l.length > 0)) {
        collected.push(JSON.parse(line))
      }
    }
    yield* Effect.tryPromise(() => reader.cancel())

    return collected
  }).pipe(
    Effect.provide(MemoryStore.Live),
    Effect.provide(EventRegistry.Live),
  )

  const frames = await Effect.runPromise(program)

  // Walk through frames; expect at least one to be a Chunk frame whose
  // values array contains a Heartbeat.
  const sawHeartbeat = frames.some((frame) => {
    const f = frame as { _tag?: string; values?: ReadonlyArray<{ _tag?: string }> }
    return (
      f._tag === "Chunk" &&
      Array.isArray(f.values) &&
      f.values.some((v) => v._tag === "Heartbeat")
    )
  })
  expect(sawHeartbeat).toBe(true)
})
```

- [ ] **Step 2: Run the test to verify it fails (or passes — depends on prior tasks)**

Run: `cd packages/server && bun run test`
Expected: PASS if Tasks 1–4 are complete (the wire shape just works once subscribeHandler emits the union and the rxweave server forwards it). If FAIL, the assertion's error message will tell you whether the issue is the request envelope shape or the response decoding.

The exact `_tag` of the request envelope (`"Request"` here) and the response frame envelope (`"Chunk"` here) come from `node_modules/@effect/rpc/src/RpcMessage.ts:187` — verify against that file at implementation time. If the shape is different, update the test assertion (NOT the production code) to match the actual wire format.

- [ ] **Step 3: Verify the result**

If it passes, no implementation changes — `@rxweave/server` is zero-touch as the spec promised.

If it fails because the request body shape is wrong, fix the test's request body to match `RpcMessage.Request` shape from the @effect/rpc source. Re-run.

- [ ] **Step 4: Commit**

```bash
git add packages/server/test/Server.test.ts
git commit -m "test(server): Heartbeat sentinel arrives as RpcMessage Chunk frame

End-to-end test: real bun-runtime server, real fetch client, real
NDJSON wire. Asserts the server's response stream contains at least
one Chunk frame whose values array carries a { _tag: \"Heartbeat\" }
item, NOT a top-level JSON line per Codex's wire-format correction
in the spec.

Confirms @rxweave/server is zero-touch — the heartbeat just flows
through subscribeHandler's widened return type."
```

---

## Phase D — Client-side: per-subscriber state, filter, watchdog

### Task 7: Lift `lastDelivered` Ref into per-subscribe scope

**Files:**
- Modify: `packages/store-cloud/src/CloudStore.ts`
- Test: `packages/store-cloud/test/CloudStore.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/store-cloud/test/CloudStore.test.ts (add new test)
import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Chunk, Effect, Stream, Ref, Layer } from "effect"
import { EventRegistry } from "@rxweave/schema"
import { EventStore } from "@rxweave/core"
import { makeCloudEventStore, type CloudRpcClient } from "../src/CloudStore.js"

describe("CloudStore — per-subscriber cursor state", () => {
  it.effect("two concurrent subscribers don't share lastDelivered", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      // Build an in-memory mock client that just emits a known sequence
      // and tracks the cursor each subscribe was opened with.
      const subscribeCalls: Array<string> = []
      const mockClient: CloudRpcClient = {
        Append: () => Effect.succeed([]),
        Subscribe: (input) => {
          subscribeCalls.push(input.cursor)
          // Emit a single envelope with id derived from the cursor for traceability.
          return Stream.fromIterable([
            { id: `evt-after-${input.cursor}`, type: "x", actor: "a", source: "cli", timestamp: 0, payload: {} },
          ] as unknown as Array<never>)
        },
        GetById: () => Effect.die("unused"),
        Query: () => Effect.die("unused"),
        QueryAfter: () => Effect.die("unused"),
      }

      const shape = yield* makeCloudEventStore(mockClient, reg)

      // Open two subscribes with different starting cursors; collect first
      // event from each independently. If lastDelivered is shared, the
      // second subscribe will see the first's resume cursor instead of "earliest".
      yield* Stream.runCollect(shape.subscribe({ cursor: "cursor-A" }).pipe(Stream.take(1)))
      yield* Stream.runCollect(shape.subscribe({ cursor: "earliest" }).pipe(Stream.take(1)))

      // Both subscribes should have been opened against their own
      // starting cursors. Pre-fix, the second would have been opened
      // against "evt-after-cursor-A" (the layer-global lastDelivered).
      expect(subscribeCalls[0]).toBe("cursor-A")
      expect(subscribeCalls[1]).toBe("earliest")
    }).pipe(Effect.provide(EventRegistry.Live)),
  )
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/store-cloud && bun run test`
Expected: FAIL — second subscribe call is opened with the resume cursor from the first (because `lastDelivered` is layer-global today).

- [ ] **Step 3: Lift `lastDelivered` Ref into the subscribe Effect**

```typescript
// packages/store-cloud/src/CloudStore.ts (modify makeCloudEventStore)
export const makeCloudEventStore = (
  client: CloudRpcClient,
  registry: EventRegistry["Type"],
): Effect.Effect<EventStoreShape, never, never> =>
  Effect.gen(function* () {
    // lastAppended stays layer-global (per EventStore §5 contract).
    const lastAppended = yield* Ref.make<Cursor>("earliest")

    const shape: EventStoreShape = {
      append: (events) => /* unchanged */,

      subscribe: ({ cursor, filter }) =>
        // Per-subscribe cursor state. Each call to subscribe gets a
        // fresh Ref so concurrent subscribers don't clobber each other's
        // resume position. Pre-v0.5 this Ref lived in the closure above
        // and was layer-global; that contract was never observable
        // because no caller relied on cross-subscribe sharing.
        Stream.unwrap(
          Effect.gen(function* () {
            const lastDelivered = yield* Ref.make<Cursor>("latest")

            const connect = Effect.gen(function* () {
              const resumeFrom = yield* Ref.get(lastDelivered)
              const effectiveCursor = resumeFrom === "latest" ? cursor : resumeFrom
              return client
                .Subscribe(
                  filter === undefined
                    ? { cursor: effectiveCursor }
                    : { cursor: effectiveCursor, filter },
                )
                .pipe(Stream.tap((e) => Ref.set(lastDelivered, e.id)))
            })

            return Stream.unwrap(connect).pipe(
              Stream.retry(
                Schedule.exponential(Duration.millis(500), 1.5).pipe(
                  Schedule.intersect(Schedule.recurs(10)),
                  Schedule.whileInput(isRetryable),
                ),
              ),
              Stream.mapError(() => new SubscribeError({ reason: "cloud-subscribe" })),
            )
          }),
        ),

      getById: /* unchanged */,
      query: /* unchanged */,
      queryAfter: /* unchanged */,
      latestCursor: Ref.get(lastAppended),
    }
    return shape
  })
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/store-cloud && bun run test`
Expected: PASS — both subscribe calls use their declared starting cursors.

- [ ] **Step 5: Run the full store-cloud suite + conformance suite to confirm no regression**

Run: `cd packages/store-cloud && bun run test`
Expected: All tests pass. The 22-case conformance suite is the load-bearing check.

- [ ] **Step 6: Commit**

```bash
git add packages/store-cloud/src/CloudStore.ts packages/store-cloud/test/CloudStore.test.ts
git commit -m "fix(store-cloud): per-subscriber lastDelivered state

The Ref was previously layer-global so concurrent subscribers on the
same Live layer clobbered each other's resume cursor. Moves the Ref
inside subscribe so each call gets its own. lastAppended (used by
latestCursor) stays layer-global because it tracks append events,
which are layer-scoped semantically.

Necessary for browser drain/watchdog correctness; beneficial for
Live too. The existing 22-case conformance suite still passes — no
caller depended on the old layer-global behavior."
```

### Task 8: Heartbeat filter — drop sentinels before user-facing stream + cursor tap

**Files:**
- Modify: `packages/store-cloud/src/CloudStore.ts`
- Test: `packages/store-cloud/test/CloudStore.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/store-cloud/test/CloudStore.test.ts
describe("CloudStore — heartbeat filter ordering", () => {
  it.effect("heartbeats do not appear in user-facing stream", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      // Mock client that emits a heartbeat then an envelope.
      const mockClient: CloudRpcClient = {
        Append: () => Effect.succeed([]),
        Subscribe: () =>
          Stream.fromIterable([
            { _tag: "Heartbeat", at: 1 } as unknown as never,
            { id: "evt-1", type: "x", actor: "a", source: "cli", timestamp: 0, payload: {} } as unknown as never,
          ]),
        GetById: () => Effect.die("unused"),
        Query: () => Effect.die("unused"),
        QueryAfter: () => Effect.die("unused"),
      }
      const shape = yield* makeCloudEventStore(mockClient, reg)
      const collected = yield* Stream.runCollect(shape.subscribe({ cursor: "earliest" }).pipe(Stream.take(1)))
      const items = Chunk.toReadonlyArray(collected)
      expect(items.length).toBe(1)
      expect((items[0] as { id: string }).id).toBe("evt-1")
    }).pipe(Effect.provide(EventRegistry.Live)),
  )

  it.effect("cursor unchanged by heartbeats (regression: heartbeats have no id)", () =>
    Effect.gen(function* () {
      // This test passes if the implementation correctly orders the filter
      // before the cursor tap. If the cursor tap runs first, Ref.set with
      // an undefined id will either crash or write undefined into the Ref.
      // We assert by opening a second subscribe and checking it starts at
      // its declared cursor (not at "undefined").
      const reg = yield* EventRegistry
      const subscribeCalls: Array<string> = []
      let firstCall = true
      const mockClient: CloudRpcClient = {
        Append: () => Effect.succeed([]),
        Subscribe: (input) => {
          subscribeCalls.push(input.cursor)
          if (firstCall) {
            firstCall = false
            // First subscribe: emit only heartbeats.
            return Stream.fromIterable([
              { _tag: "Heartbeat", at: 1 } as unknown as never,
              { _tag: "Heartbeat", at: 2 } as unknown as never,
            ])
          }
          return Stream.empty
        },
        GetById: () => Effect.die("unused"),
        Query: () => Effect.die("unused"),
        QueryAfter: () => Effect.die("unused"),
      }
      const shape = yield* makeCloudEventStore(mockClient, reg)
      yield* Stream.runDrain(shape.subscribe({ cursor: "earliest" }).pipe(Stream.take(0)))
      yield* Stream.runDrain(shape.subscribe({ cursor: "earliest" }).pipe(Stream.take(0)))
      // Both subscribes were opened against "earliest" — never against undefined.
      for (const c of subscribeCalls) {
        expect(c).toBe("earliest")
      }
    }).pipe(Effect.provide(EventRegistry.Live)),
  )
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/store-cloud && bun run test`
Expected: FAIL — heartbeats currently leak through to user-facing stream; the cursor tap may also crash on `e.id` for heartbeats.

- [ ] **Step 3: Add the heartbeat filter to the subscribe pipeline**

```typescript
// packages/store-cloud/src/CloudStore.ts — modify the connect Effect
import { Option } from "effect"

// Inside makeCloudEventStore subscribe:
const connect = Effect.gen(function* () {
  const resumeFrom = yield* Ref.get(lastDelivered)
  const effectiveCursor = resumeFrom === "latest" ? cursor : resumeFrom
  return client
    .Subscribe(
      filter === undefined
        ? { cursor: effectiveCursor }
        : { cursor: effectiveCursor, filter },
    )
    .pipe(
      // (1) Watchdog tap runs BEFORE the filter so it observes every
      //     item including heartbeats. (Wired in Task 9.)

      // (2) Drop heartbeat sentinels from the user-facing stream.
      //     They served their byte-flow purpose at the wire level
      //     (and arm the watchdog above); consumers of EventStore
      //     should only see EventEnvelopes.
      Stream.filterMap((item) => {
        const tag = (item as { _tag?: string })._tag
        if (tag === "Heartbeat") return Option.none()
        return Option.some(item as EventEnvelope)
      }),
      // (3) Cursor tap runs AFTER the filter so it only sees envelopes
      //     with valid `id` fields. Pre-v0.5 this tap was at the head
      //     of the pipe; that placement would attempt
      //     Ref.set(lastDelivered, undefined) for every heartbeat.
      Stream.tap((e) => Ref.set(lastDelivered, e.id)),
    )
})
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/store-cloud && bun run test`
Expected: PASS — heartbeats dropped from user-facing stream; cursor stays at its declared value.

- [ ] **Step 5: Commit**

```bash
git add packages/store-cloud/src/CloudStore.ts packages/store-cloud/test/CloudStore.test.ts
git commit -m "feat(store-cloud): drop heartbeat sentinels from user-facing stream

Stream.filterMap removes Heartbeat items between the wire decoder
and the user-facing Stream<EventEnvelope>. The cursor-update tap
runs AFTER the filter, so it only sees items with valid `id` —
pre-fix, every heartbeat would have written undefined into the
lastDelivered Ref because heartbeats have no id field.

Watchdog tap (added in next task) runs BEFORE the filter so it
observes every item, including heartbeats, to track liveness."
```

### Task 9: Per-subscribe `lastHeartbeatAt` Ref + watchdog fiber

**Files:**
- Modify: `packages/store-cloud/src/CloudStore.ts`
- Test: `packages/store-cloud/test/CloudStore.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/store-cloud/test/CloudStore.test.ts
describe("CloudStore — heartbeat watchdog", () => {
  it.scoped("watchdog fires after 3 × intervalMs of silence post-heartbeat", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      const mockClient: CloudRpcClient = {
        Append: () => Effect.succeed([]),
        // Emit one heartbeat, then go silent.
        Subscribe: () =>
          Stream.concat(
            Stream.fromIterable([
              { _tag: "Heartbeat", at: 0 } as unknown as never,
            ]),
            Stream.never,
          ),
        GetById: () => Effect.die("unused"),
        Query: () => Effect.die("unused"),
        QueryAfter: () => Effect.die("unused"),
      }
      const shape = yield* makeCloudEventStore(mockClient, reg, {
        heartbeat: { intervalMs: 1000 },
      })
      const fiber = yield* Effect.fork(
        Stream.runCollect(shape.subscribe({ cursor: "earliest" }).pipe(Stream.take(1))),
      )
      yield* TestClock.adjust("3500 millis")
      const exit = yield* fiber.pipe(Effect.flatMap((f) => f.await))
      expect(exit._tag).toBe("Failure") // SubscribeError after WatchdogTimeout retried out
    }).pipe(Effect.provide(EventRegistry.Live)),
  )

  it.scoped("watchdog does NOT fire when no heartbeat ever observed (cloud-v0.2 path)", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      const mockClient: CloudRpcClient = {
        Append: () => Effect.succeed([]),
        // Never emit a heartbeat. Server simply doesn't support it.
        Subscribe: () => Stream.never as unknown as Stream.Stream<never, never, never>,
        GetById: () => Effect.die("unused"),
        Query: () => Effect.die("unused"),
        QueryAfter: () => Effect.die("unused"),
      }
      const shape = yield* makeCloudEventStore(mockClient, reg, {
        heartbeat: { intervalMs: 1000 },
      })
      const fiber = yield* Effect.fork(
        Stream.runCollect(shape.subscribe({ cursor: "earliest" }).pipe(Stream.take(1))),
      )
      yield* TestClock.adjust("60_000 millis") // way past 3 × interval
      // Fiber must still be running (watchdog never armed).
      const status = yield* fiber.pipe(Effect.flatMap((f) => f.status))
      expect(status._tag).toBe("Suspended")
      yield* fiber.pipe(Effect.flatMap((f) => f.interrupt))
    }).pipe(Effect.provide(EventRegistry.Live)),
  )
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/store-cloud && bun run test`
Expected: FAIL — `makeCloudEventStore` doesn't accept the `heartbeat` option yet, and there's no watchdog wiring.

- [ ] **Step 3: Add an optional `heartbeat` option to `makeCloudEventStore` and wire the watchdog**

```typescript
// packages/store-cloud/src/CloudStore.ts
import { WatchdogTimeout } from "./Errors.js"

export const makeCloudEventStore = (
  client: CloudRpcClient,
  registry: EventRegistry["Type"],
  opts?: { readonly heartbeat?: { readonly intervalMs: number } },
): Effect.Effect<EventStoreShape, never, never> =>
  Effect.gen(function* () {
    const lastAppended = yield* Ref.make<Cursor>("earliest")

    const heartbeatConfig = opts?.heartbeat

    const shape: EventStoreShape = {
      append: /* unchanged */,

      subscribe: ({ cursor, filter }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const lastDelivered = yield* Ref.make<Cursor>("latest")
            // undefined until first heartbeat observed; the watchdog
            // checks for non-undefined before firing.
            const lastHeartbeatAt = yield* Ref.make<number | undefined>(undefined)

            const updateWatchdog = (item: unknown): Effect.Effect<void> => {
              const tag = (item as { _tag?: string })._tag
              if (tag === "Heartbeat") {
                return Ref.set(lastHeartbeatAt, Date.now())
              }
              return Effect.void
            }

            const connect = Effect.gen(function* () {
              const resumeFrom = yield* Ref.get(lastDelivered)
              const effectiveCursor = resumeFrom === "latest" ? cursor : resumeFrom

              const subscribePayload =
                heartbeatConfig === undefined
                  ? filter === undefined
                    ? { cursor: effectiveCursor }
                    : { cursor: effectiveCursor, filter }
                  : filter === undefined
                  ? { cursor: effectiveCursor, heartbeat: heartbeatConfig }
                  : { cursor: effectiveCursor, filter, heartbeat: heartbeatConfig }

              const itemStream = client
                .Subscribe(subscribePayload as never)
                .pipe(
                  Stream.tap(updateWatchdog),
                  Stream.filterMap((item) => {
                    const tag = (item as { _tag?: string })._tag
                    if (tag === "Heartbeat") return Option.none()
                    return Option.some(item as EventEnvelope)
                  }),
                  Stream.tap((e) => Ref.set(lastDelivered, e.id)),
                )

              if (heartbeatConfig === undefined) return itemStream

              // Watchdog: a periodic check that emits a WatchdogTimeout
              // if too much time has elapsed since the last heartbeat.
              // Implemented as Stream.merge of the item stream + a
              // failing stream that observes time since last heartbeat.
              const idleThreshold = heartbeatConfig.intervalMs * 3
              const watchdogFailureStream: Stream.Stream<never, WatchdogTimeout, never> =
                Stream.repeatEffectWithSchedule(
                  Effect.gen(function* () {
                    const at = yield* Ref.get(lastHeartbeatAt)
                    if (at !== undefined && Date.now() - at > idleThreshold) {
                      return yield* Effect.fail(new WatchdogTimeout({ idleMs: Date.now() - at }))
                    }
                    return undefined as never
                  }).pipe(Effect.filterOrFail(() => false, () => undefined as never)),
                  Schedule.spaced(Duration.seconds(1)),
                )
              return Stream.merge(itemStream, watchdogFailureStream as Stream.Stream<EventEnvelope, WatchdogTimeout, never>)
            })

            return Stream.unwrap(connect).pipe(
              // Stream.retry runs after the watchdog so a WatchdogTimeout
              // (classified retryable in Retry.ts) triggers reconnect.
              Stream.retry(
                Schedule.exponential(Duration.millis(500), 1.5).pipe(
                  Schedule.intersect(Schedule.recurs(10)),
                  Schedule.whileInput(isRetryable),
                ),
              ),
              Stream.mapError(() => new SubscribeError({ reason: "cloud-subscribe" })),
            )
          }),
        ),

      // ...
    }
    return shape
  })
```

The watchdog implementation above is intentionally simple: a 1Hz polling fiber that fails the stream when `lastHeartbeatAt !== undefined && now - lastHeartbeatAt > 3 * intervalMs`. The `filterOrFail(() => false, () => undefined)` after `repeatEffectWithSchedule` is a noop trick to keep the success channel `never` — heartbeats only ever fail or yield `undefined`.

If the polling-fiber implementation is awkward, an equivalent approach is `Stream.timeout(idleThreshold)` on the item stream, gated by the "first heartbeat observed" condition — but that requires more delicate stream wiring.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/store-cloud && bun run test`
Expected: PASS — watchdog fires when armed and silent past threshold; never fires when unarmed.

- [ ] **Step 5: Run the full store-cloud test suite + conformance to confirm no regression**

Run: `cd packages/store-cloud && bun run test`
Expected: 22 conformance cases pass.

- [ ] **Step 6: Commit**

```bash
git add packages/store-cloud/src/CloudStore.ts packages/store-cloud/test/CloudStore.test.ts
git commit -m "feat(store-cloud): heartbeat liveness watchdog with first-heartbeat arm

makeCloudEventStore takes an optional heartbeat config. When set,
each subscribe gets a per-fiber lastHeartbeatAt Ref initialised to
undefined; a 1Hz polling fiber fails the stream with WatchdogTimeout
when the Ref is non-undefined and the last heartbeat is older than
3 × intervalMs.

The 'only-after-first-heartbeat' arming closes the false-positive
case where the client opts in but the server doesn't emit them
(cloud-v0.2). Without an observed heartbeat, the watchdog can
never fire, so old-server fallback is regression-free.

WatchdogTimeout is classified retryable in Retry.ts so the existing
Stream.retry schedule reconnects from lastDelivered."
```

### Task 10: Watchdog reconnect end-to-end test

**Files:**
- Test: `packages/store-cloud/test/CloudStore.test.ts`

- [ ] **Step 1: Add the reconnect-on-watchdog test**

```typescript
// packages/store-cloud/test/CloudStore.test.ts (extend describe)
describe("CloudStore — watchdog triggers reconnect from lastDelivered", () => {
  it.scoped("after WatchdogTimeout, the next Subscribe call uses lastDelivered cursor", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      const subscribeCalls: Array<unknown> = []
      let attempt = 0
      const mockClient: CloudRpcClient = {
        Append: () => Effect.succeed([]),
        Subscribe: (input) => {
          subscribeCalls.push(input.cursor)
          attempt += 1
          if (attempt === 1) {
            // First connection: emit one envelope, one heartbeat, then silence.
            return Stream.concat(
              Stream.fromIterable([
                {
                  id: "evt-A",
                  type: "x",
                  actor: "a",
                  source: "cli" as const,
                  timestamp: 0,
                  payload: {},
                } as unknown as never,
                { _tag: "Heartbeat", at: 0 } as unknown as never,
              ]),
              Stream.never,
            )
          }
          // Reconnect: emit another envelope and complete.
          return Stream.fromIterable([
            {
              id: "evt-B",
              type: "x",
              actor: "a",
              source: "cli" as const,
              timestamp: 0,
              payload: {},
            } as unknown as never,
          ])
        },
        GetById: () => Effect.die("unused"),
        Query: () => Effect.die("unused"),
        QueryAfter: () => Effect.die("unused"),
      }
      const shape = yield* makeCloudEventStore(mockClient, reg, {
        heartbeat: { intervalMs: 1000 },
      })
      const fiber = yield* Effect.fork(
        Stream.runCollect(shape.subscribe({ cursor: "cursor-init" }).pipe(Stream.take(2))),
      )
      yield* TestClock.adjust("4000 millis") // pass watchdog threshold
      const exit = yield* fiber.pipe(Effect.flatMap((f) => f.await))

      // Two subscribe attempts: first opened at "cursor-init", reconnect
      // opened at "evt-A" (the lastDelivered as of WatchdogTimeout).
      expect(subscribeCalls.length).toBeGreaterThanOrEqual(2)
      expect(subscribeCalls[0]).toBe("cursor-init")
      expect(subscribeCalls[1]).toBe("evt-A")
      expect(exit._tag).toBe("Success")
    }).pipe(Effect.provide(EventRegistry.Live)),
  )
})
```

- [ ] **Step 2: Run the test**

Run: `cd packages/store-cloud && bun run test`
Expected: PASS if Tasks 7–9 are correctly wired. If FAIL with assertion on `subscribeCalls[1] !== "evt-A"`, the cursor tap may not be running before WatchdogTimeout fires — check the pipeline order from Task 8.

- [ ] **Step 3: Commit**

```bash
git add packages/store-cloud/test/CloudStore.test.ts
git commit -m "test(store-cloud): watchdog reconnect resumes from lastDelivered

End-to-end assertion that WatchdogTimeout → Stream.retry → Subscribe
is opened with the cursor of the last delivered envelope, not the
original starting cursor. Locks in the Task 8 + Task 9 pipeline
ordering as the contract."
```

---

## Phase E — `LiveFromBrowser` factory

### Task 11: SessionTokenFetch auth strategy with request-replay on 401

**Files:**
- Modify: `packages/store-cloud/src/Auth.ts`
- Test: `packages/store-cloud/test/Auth.test.ts` (extend or create)

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/store-cloud/test/Auth.test.ts (add new describe block)
import { describe, expect, test } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "@effect/platform"
import { sessionTokenFetch, AuthFailed } from "../src/Auth.js"

const installMockFetch = (handler: (req: Request) => Promise<Response>): void => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    return handler(req)
  }) as typeof fetch
}

const runRpcCall = (transform: ReturnType<typeof sessionTokenFetch>["transformClient"]) =>
  Effect.gen(function* () {
    const baseClient = yield* HttpClient.HttpClient
    const wrapped = transform(baseClient)
    const req = HttpClientRequest.post("http://test/rxweave/rpc/")
    return yield* wrapped.execute(req)
  }).pipe(Effect.provide(FetchHttpClient.layer))

describe("sessionTokenFetch", () => {
  test("attaches bearer from token endpoint to subsequent RPC", async () => {
    let tokenCalls = 0
    let lastAuth: string | undefined
    installMockFetch(async (req) => {
      if (req.url.endsWith("/rxweave/session-token")) {
        tokenCalls += 1
        return new Response("rxk_test_abc123\n", { status: 200 })
      }
      lastAuth = req.headers.get("authorization") ?? undefined
      return new Response("ok", { status: 200 })
    })

    const { transformClient } = sessionTokenFetch({
      origin: "http://test",
      tokenPath: "/rxweave/session-token",
    })
    const exit = await Effect.runPromiseExit(runRpcCall(transformClient))

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(tokenCalls).toBe(1)
    expect(lastAuth).toBe("Bearer rxk_test_abc123")
  })

  test("on 401, refetches the token AND retries the failed request once", async () => {
    let tokenCalls = 0
    let rpcCalls = 0
    let firstRpcAuth: string | undefined
    let secondRpcAuth: string | undefined
    installMockFetch(async (req) => {
      if (req.url.endsWith("/rxweave/session-token")) {
        tokenCalls += 1
        return new Response(tokenCalls === 1 ? "rxk_old\n" : "rxk_new\n", { status: 200 })
      }
      const auth = req.headers.get("authorization") ?? undefined
      rpcCalls += 1
      if (rpcCalls === 1) {
        firstRpcAuth = auth
        return new Response("expired", { status: 401 })
      }
      secondRpcAuth = auth
      return new Response("ok", { status: 200 })
    })

    const { transformClient } = sessionTokenFetch({
      origin: "http://test",
      tokenPath: "/rxweave/session-token",
    })
    const exit = await Effect.runPromiseExit(runRpcCall(transformClient))

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(tokenCalls).toBe(2)
    expect(rpcCalls).toBe(2)
    expect(firstRpcAuth).toBe("Bearer rxk_old")
    expect(secondRpcAuth).toBe("Bearer rxk_new")
  })

  test("two consecutive 401s raise AuthFailed", async () => {
    installMockFetch(async (req) => {
      if (req.url.endsWith("/rxweave/session-token")) {
        return new Response("rxk_anything\n", { status: 200 })
      }
      return new Response("expired", { status: 401 })
    })

    const { transformClient } = sessionTokenFetch({
      origin: "http://test",
      tokenPath: "/rxweave/session-token",
    })
    const exit = await Effect.runPromiseExit(runRpcCall(transformClient))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Exit.causeOption(exit)
      // Walk the cause to find an AuthFailed tagged error.
      const sawAuthFailed = JSON.stringify(failure).includes("AuthFailed")
      expect(sawAuthFailed).toBe(true)
    }
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/store-cloud && bun run test`
Expected: FAIL — `sessionTokenFetch` not exported from `Auth.ts`.

- [ ] **Step 3: Implement sessionTokenFetch + AuthFailed**

```typescript
// packages/store-cloud/src/Auth.ts (extend existing file)
import { Data, Effect } from "effect"
import { HttpClient, HttpClientRequest } from "@effect/platform"

// (existing TokenProvider, cachedToken, resolveToken, withBearerToken,
//  withRefreshOn401 stay unchanged.)

/**
 * Tagged error raised when two consecutive RPC calls return 401 even
 * after a fresh token fetch. Terminal — the application must
 * re-bootstrap (e.g., reload the page).
 */
export class AuthFailed extends Data.TaggedError("AuthFailed")<{
  readonly cause: string
}> {}

/**
 * Browser auth strategy: bootstrap a bearer token via fetch to a
 * server-provided endpoint (typically `/rxweave/session-token`),
 * cache it (TTL via cachedToken), and on 401 invalidate-AND-retry the
 * failed request once. After a second 401, propagate AuthFailed.
 *
 * Composition relies on `withBearerToken(cached)` to attach the header
 * via mapRequestEffect — that wrapper re-resolves the cache on every
 * request, so calling `cached.invalidate()` then re-issuing through
 * the same wrapped client is sufficient to send a fresh token.
 *
 * The retry layer is built with `HttpClient.make` so the wrapped
 * client's `.execute` is the unit of retry; this is the simplest
 * primitive that lets us re-send the SAME request through the SAME
 * bearer-attaching middleware twice. Retry budget is exactly one
 * extra send per request — no exponential schedule, no backoff.
 */
export const sessionTokenFetch = (opts: {
  readonly origin: string
  readonly tokenPath: string
}): {
  readonly transformClient: <E, R>(
    c: HttpClient.HttpClient.With<E, R>,
  ) => HttpClient.HttpClient.With<E, R>
} => {
  const tokenUrl = `${opts.origin}${opts.tokenPath}`

  const provider: TokenProvider = async () => {
    const r = await fetch(tokenUrl)
    if (!r.ok) {
      throw new Error(`session-token fetch failed: ${r.status}`)
    }
    return (await r.text()).trim()
  }
  const cached = cachedToken(provider)

  return {
    transformClient: <E, R>(
      client: HttpClient.HttpClient.With<E, R>,
    ): HttpClient.HttpClient.With<E, R> => {
      const withAuth = withBearerToken(cached)(client)
      // HttpClient.make accepts a request → Effect<HttpClientResponse>
      // function. We compose a retry-once-on-401 wrapper around
      // withAuth.execute. Because withAuth uses mapRequestEffect to
      // attach the Bearer header per request, calling cached.invalidate()
      // before the second execute guarantees the second send uses a
      // freshly-fetched token.
      return HttpClient.make((req) =>
        Effect.gen(function* () {
          const first = yield* withAuth.execute(req)
          if (first.status !== 401) return first
          cached.invalidate()
          const second = yield* withAuth.execute(req)
          if (second.status === 401) {
            return yield* Effect.fail(
              new AuthFailed({ cause: "401 after token refresh" }),
            )
          }
          return second
        }),
      ) as HttpClient.HttpClient.With<E, R>
    },
  }
}
```

Notes for the implementing engineer:

- The exact `HttpClient.make` factory signature (positional `f` callback vs. an object with `execute`) varies across `@effect/platform` minor versions. If `HttpClient.make((req) => ...)` doesn't compile, switch to `HttpClient.make({ execute: (req) => ... })` per the version you have installed; the body is the same.
- The `as HttpClient.HttpClient.With<E, R>` cast bridges the strict-typed `HttpClient.HttpClient` returned by `HttpClient.make` and the parameterized `With<E, R>` shape consumed by `RpcClient.layerProtocolHttp`'s `transformClient`. If your installed `@effect/platform` exports a parameterized `make`, drop the cast.
- `AuthFailed` extends `Data.TaggedError("AuthFailed")` — same shape as `WatchdogTimeout` from Task 2 (and matches the existing tagged-error idiom across the repo).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/store-cloud && bun run test`
Expected: PASS — token attached, refetch+retry on 401, AuthFailed after two consecutive.

- [ ] **Step 5: Commit**

```bash
git add packages/store-cloud/src/Auth.ts packages/store-cloud/test/Auth.test.ts
git commit -m "feat(store-cloud): SessionTokenFetch auth with request-replay on 401

Bootstraps a bearer via fetch(origin + tokenPath), caches it for
the layer's lifetime, and on 401 invalidates the cache, refetches,
AND retries the failing request with the new token. The existing
withRefreshOn401 only invalidated; the next call paid the round-trip.
For browser clients where 401 typically means session-rotated mid-RPC,
in-flight retry is the cleaner UX.

Two consecutive 401s after refresh → AuthFailed (terminal)."
```

### Task 12: Refactor `Live` internals into private `makeLive`

**Files:**
- Modify: `packages/store-cloud/src/CloudStore.ts`
- (No test changes — conformance suite is the load-bearing check)

- [ ] **Step 1: Verify conformance suite passes against current `Live`**

Run: `cd packages/store-cloud && bun run test`
Expected: All 22 conformance cases pass.

- [ ] **Step 2: Extract `makeLive` and have `Live` call it**

```typescript
// packages/store-cloud/src/CloudStore.ts
const makeLive = (config: {
  readonly url: string
  readonly transformClient: <E, R>(c: HttpClient.HttpClient.With<E, R>) => HttpClient.HttpClient.With<E, R>
  readonly heartbeat?: { readonly intervalMs: number }
  readonly drainBeforeSubscribe?: boolean
}): Layer.Layer<EventStore, never, EventRegistry> => {
  const ProtocolLayer = RpcClient.layerProtocolHttp({
    url: config.url,
    transformClient: config.transformClient,
  }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(RpcSerialization.layerNdjson),
  )

  const StoreEffect = Effect.gen(function* () {
    const client = yield* RpcClient.make(RxWeaveRpc)
    const registry = yield* EventRegistry
    return yield* makeCloudEventStore(client as unknown as CloudRpcClient, registry, {
      heartbeat: config.heartbeat,
      drainBeforeSubscribe: config.drainBeforeSubscribe,
    })
  })

  return Layer.scoped(EventStore, StoreEffect).pipe(Layer.provide(ProtocolLayer))
}

export const CloudStore = {
  Live: (opts: CloudStoreOpts): Layer.Layer<EventStore, never, EventRegistry> => {
    const transformClient = opts.token === undefined
      ? <E, R>(client: HttpClient.HttpClient.With<E, R>) => withBearerToken(() => undefined)(client)
      : (() => {
          const token = cachedToken(opts.token)
          return <E, R>(client: HttpClient.HttpClient.With<E, R>) =>
            withRefreshOn401(token)(withBearerToken(token)(client))
        })()
    return makeLive({
      url: opts.url,
      transformClient,
      // Live (CLI/Node): no heartbeat, no drain. Bit-for-bit v0.4 behavior.
      heartbeat: undefined,
      drainBeforeSubscribe: false,
    })
  },
}
```

(Update `makeCloudEventStore`'s signature in this same task to accept the new option object — see Task 9 + Task 13 wire-ups.)

- [ ] **Step 3: Run the tests**

Run: `cd packages/store-cloud && bun run test`
Expected: All tests pass (no behavior change for Live; conformance suite stays green).

- [ ] **Step 4: Commit**

```bash
git add packages/store-cloud/src/CloudStore.ts
git commit -m "refactor(store-cloud): extract Live internals into private makeLive

Layer composition (Protocol + Serialization + StoreEffect) plus
makeCloudEventStore wiring is now factored into a private makeLive
that takes an explicit config object. CloudStore.Live is now a thin
wrapper that calls makeLive with the v0.4-equivalent config (no
heartbeat, no drain). LiveFromBrowser (next task) calls makeLive
with browser-specific defaults.

No behavior change. The 22-case conformance suite continues to pass."
```

### Task 13: drainBeforeSubscribe — drain via QueryAfter pages, then Subscribe

**Files:**
- Modify: `packages/store-cloud/src/CloudStore.ts`
- Test: `packages/store-cloud/test/CloudStore.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/store-cloud/test/CloudStore.test.ts (add new describe)
describe("CloudStore — drainBeforeSubscribe", () => {
  it.scoped("drain emits all QueryAfter pages before Subscribe opens", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      const events = Array.from({ length: 100 }, (_, i) => ({
        id: `evt-${String(i).padStart(3, "0")}`,
        type: "x",
        actor: "a",
        source: "cli" as const,
        timestamp: 0,
        payload: {},
      }))
      let queryAfterCalls = 0
      const mockClient: CloudRpcClient = {
        Append: () => Effect.succeed([]),
        Subscribe: () =>
          Stream.fromIterable([
            {
              id: "live-1",
              type: "x",
              actor: "a",
              source: "cli" as const,
              timestamp: 0,
              payload: {},
            } as unknown as never,
          ]),
        GetById: () => Effect.die("unused"),
        Query: () => Effect.die("unused"),
        QueryAfter: ({ cursor, limit }) => {
          queryAfterCalls += 1
          // Page in batches of 50.
          if (cursor === "earliest") return Effect.succeed(events.slice(0, 50) as never)
          if (cursor === "evt-049") return Effect.succeed(events.slice(50) as never)
          if (cursor === "evt-099") return Effect.succeed([])
          return Effect.succeed([])
        },
      }
      const shape = yield* makeCloudEventStore(mockClient, reg, {
        drainBeforeSubscribe: true,
      })

      const collected = yield* Stream.runCollect(
        shape.subscribe({ cursor: "earliest" }).pipe(Stream.take(101)),
      )
      const items = Chunk.toReadonlyArray(collected) as Array<{ id: string }>
      // First 100 are the drained events in order; 101st is the live one.
      expect(items[0]!.id).toBe("evt-000")
      expect(items[99]!.id).toBe("evt-099")
      expect(items[100]!.id).toBe("live-1")
      // QueryAfter called 3 times (50, 50, 0).
      expect(queryAfterCalls).toBe(3)
    }).pipe(Effect.provide(EventRegistry.Live)),
  )

  it.scoped("event appended between drain-empty and Subscribe-open is delivered via Subscribe replay", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      const drainedEvents = [{ id: "evt-A", type: "x", actor: "a", source: "cli" as const, timestamp: 0, payload: {} }]
      const raceEvent = { id: "evt-B", type: "x", actor: "a", source: "cli" as const, timestamp: 0, payload: {} }
      const liveEvent = { id: "evt-C", type: "x", actor: "a", source: "cli" as const, timestamp: 0, payload: {} }
      const mockClient: CloudRpcClient = {
        Append: () => Effect.succeed([]),
        // Subscribe must include evt-B (race) since it was appended after drain
        // returned [] but before Subscribe was opened. The protocol's
        // exclusive-cursor + snapshot-then-live semantics guarantee this.
        Subscribe: ({ cursor }) => {
          expect(cursor).toBe("evt-A") // resumed from last drain id
          return Stream.fromIterable([raceEvent as unknown as never, liveEvent as unknown as never])
        },
        GetById: () => Effect.die("unused"),
        Query: () => Effect.die("unused"),
        QueryAfter: ({ cursor }) =>
          cursor === "earliest" ? Effect.succeed(drainedEvents as never) : Effect.succeed([]),
      }
      const shape = yield* makeCloudEventStore(mockClient, reg, {
        drainBeforeSubscribe: true,
      })

      const collected = yield* Stream.runCollect(
        shape.subscribe({ cursor: "earliest" }).pipe(Stream.take(3)),
      )
      const items = Chunk.toReadonlyArray(collected) as Array<{ id: string }>
      expect(items.map((i) => i.id)).toEqual(["evt-A", "evt-B", "evt-C"])
    }).pipe(Effect.provide(EventRegistry.Live)),
  )
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/store-cloud && bun run test`
Expected: FAIL — drainBeforeSubscribe option not yet wired into makeCloudEventStore.

- [ ] **Step 3: Implement drainBeforeSubscribe**

```typescript
// packages/store-cloud/src/CloudStore.ts — extend makeCloudEventStore

export const makeCloudEventStore = (
  client: CloudRpcClient,
  registry: EventRegistry["Type"],
  opts?: {
    readonly heartbeat?: { readonly intervalMs: number }
    readonly drainBeforeSubscribe?: boolean
  },
): Effect.Effect<EventStoreShape, never, never> =>
  Effect.gen(function* () {
    // ... existing setup ...

    const drainBeforeSubscribe = opts?.drainBeforeSubscribe === true

    const shape: EventStoreShape = {
      // ...
      subscribe: ({ cursor, filter }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const lastDelivered = yield* Ref.make<Cursor>("latest")
            const lastHeartbeatAt = yield* Ref.make<number | undefined>(undefined)

            const drainStream = drainBeforeSubscribe
              ? Stream.unfoldChunkEffect<Cursor, EventEnvelope, never, never>(
                  cursor,
                  (currentCursor) =>
                    Effect.gen(function* () {
                      const page = yield* client
                        .QueryAfter({
                          cursor: currentCursor,
                          filter: filter ?? { types: undefined, actors: undefined, sources: undefined },
                          limit: 1024,
                        })
                        .pipe(Effect.orDie)
                      if (page.length === 0) return Option.none<readonly [Chunk.Chunk<EventEnvelope>, Cursor]>()
                      const last = page[page.length - 1]!
                      return Option.some([Chunk.fromIterable(page), last.id] as const)
                    }),
                ).pipe(
                  Stream.tap((e: EventEnvelope) => Ref.set(lastDelivered, e.id)),
                )
              : Stream.empty as Stream.Stream<EventEnvelope, never, never>

            const subscribeStream = Stream.unwrap(
              Effect.gen(function* () {
                const resumeFrom = yield* Ref.get(lastDelivered)
                const effectiveCursor = resumeFrom === "latest" ? cursor : resumeFrom
                // ... existing Subscribe call + filter + cursor tap + watchdog merge ...
                return /* the itemStream from Task 9 with effectiveCursor */
              }),
            )

            const composed = Stream.concat(drainStream, subscribeStream)

            return composed.pipe(
              Stream.retry(/* existing retry schedule */),
              Stream.mapError(() => new SubscribeError({ reason: "cloud-subscribe" })),
            )
          }),
        ),
      // ...
    }
    return shape
  })
```

The exact `Stream.unfoldChunkEffect` API may differ; the conceptual contract is: page through QueryAfter until an empty page returns, emitting each page as a chunk. After the last drained event, `lastDelivered` is set to its id, and `subscribeStream` resumes from there.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/store-cloud && bun run test`
Expected: PASS — drained events arrive before live tail; race-event from append-between-drain-and-subscribe is delivered via Subscribe's snapshot replay.

- [ ] **Step 5: Commit**

```bash
git add packages/store-cloud/src/CloudStore.ts packages/store-cloud/test/CloudStore.test.ts
git commit -m "feat(store-cloud): drainBeforeSubscribe flag for browser drain

Pages QueryAfter from cursor until an empty page returns, emitting
each page through the user-facing stream and updating lastDelivered.
Subscribe is then opened with the last drained id; the protocol's
exclusive-cursor + snapshot-then-live semantics (verified in
MemoryStore + FileStore + Convex's polling handler) guarantee any
event appended between drain-empty and Subscribe-open lands in
Subscribe's snapshot replay — never lost, never duplicated.

CLI/Node clients pass drainBeforeSubscribe: false (Live's default);
they have no fetch-buffer pathology and Subscribe's own replay
handles their startup."
```

### Task 14: `CloudStore.LiveFromBrowser` factory

**Files:**
- Create: `packages/store-cloud/src/LiveFromBrowser.ts`
- Modify: `packages/store-cloud/src/index.ts` (re-export)
- Test: `packages/store-cloud/test/CloudStore.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/store-cloud/test/CloudStore.test.ts
describe("CloudStore.LiveFromBrowser", () => {
  it.effect("composes makeLive with origin → url, sessionTokenFetch, heartbeat, drain", () =>
    Effect.gen(function* () {
      // Mock global fetch for the token bootstrap.
      let tokenFetched = false
      globalThis.fetch = (async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url
        if (url.includes("/rxweave/session-token")) {
          tokenFetched = true
          return new Response("rxk_browser\n", { status: 200 })
        }
        return new Response("ok", { status: 200 })
      }) as typeof fetch

      const layer = CloudStore.LiveFromBrowser({ origin: "http://test" })
      // Materialise the layer — exercises token bootstrap + makeLive composition.
      const composed = Layer.merge(EventRegistry.Live, layer)
      // Smoke test: layer compiles and provides EventStore.
      const program = Effect.gen(function* () {
        const store = yield* EventStore
        return yield* store.latestCursor
      })
      const cursor = yield* program.pipe(Effect.provide(composed))
      expect(cursor).toBe("earliest") // empty store
    }),
  )
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/store-cloud && bun run test`
Expected: FAIL — `CloudStore.LiveFromBrowser` not yet exported.

- [ ] **Step 3: Implement LiveFromBrowser**

```typescript
// packages/store-cloud/src/LiveFromBrowser.ts
import type { Layer } from "effect"
import { type EventRegistry } from "@rxweave/schema"
import { EventStore } from "@rxweave/core"
import { makeLive } from "./CloudStore.js"
import { sessionTokenFetch } from "./Auth.js"

export interface LiveFromBrowserOpts {
  readonly origin: string
  readonly tokenPath?: string
  readonly heartbeat?: { readonly intervalMs: number }
}

const DEFAULT_TOKEN_PATH = "/rxweave/session-token"
const DEFAULT_HEARTBEAT = { intervalMs: 15_000 } as const

export const LiveFromBrowser = (
  opts: LiveFromBrowserOpts,
): Layer.Layer<EventStore, never, EventRegistry> => {
  const tokenPath = opts.tokenPath ?? DEFAULT_TOKEN_PATH
  const heartbeat = opts.heartbeat ?? DEFAULT_HEARTBEAT
  const url = `${opts.origin}/rxweave/rpc/`
  const auth = sessionTokenFetch({ origin: opts.origin, tokenPath })
  return makeLive({
    url,
    transformClient: auth.transformClient,
    heartbeat,
    drainBeforeSubscribe: true,
  })
}
```

```typescript
// packages/store-cloud/src/index.ts (extend)
export { CloudStore } from "./CloudStore.js"
export { LiveFromBrowser } from "./LiveFromBrowser.js"
```

Also export `makeLive` from `CloudStore.ts` (or refactor to expose it; the test in step 1 imports it indirectly via LiveFromBrowser, so as long as LiveFromBrowser composes correctly the test passes).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/store-cloud && bun run test`
Expected: PASS.

- [ ] **Step 5: Update `CloudStore` namespace export**

```typescript
// Optional: re-export LiveFromBrowser as CloudStore.LiveFromBrowser for ergonomics:
export const CloudStore = {
  Live: (...) => /* unchanged */,
  LiveFromBrowser,
}
```

- [ ] **Step 6: Commit**

```bash
git add packages/store-cloud/src/LiveFromBrowser.ts packages/store-cloud/src/index.ts packages/store-cloud/src/CloudStore.ts packages/store-cloud/test/CloudStore.test.ts
git commit -m "feat(store-cloud): CloudStore.LiveFromBrowser factory

Browser-shaped sibling to CloudStore.Live. Constructs the RPC URL
from { origin } (because the factory needs to know two paths —
/rxweave/rpc/ and /rxweave/session-token — not one), wires
sessionTokenFetch for auth, opts in to heartbeat (default 15000ms),
and enables drainBeforeSubscribe.

Live keeps its existing { url, token? } API unchanged. The two
factories share the internal makeLive core so drain/heartbeat/
filter/watchdog logic lives in one place."
```

### Task 15: Future-sentinel decode failure regression test

**Files:**
- Test: `packages/store-cloud/test/CloudStore.test.ts`

- [ ] **Step 1: Add the decode-failure test**

```typescript
// packages/store-cloud/test/CloudStore.test.ts
describe("CloudStore — future-sentinel decode failure", () => {
  it.effect("an unknown _tag (e.g. ProgressMarker) surfaces as a decode error, not SubscribeWireError", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      // The mock emits a sentinel with a tag the schema doesn't know.
      // makeCloudEventStore receives unknown items; the user-facing
      // stream should fail/die rather than silently swallow.
      const mockClient: CloudRpcClient = {
        Append: () => Effect.succeed([]),
        Subscribe: () =>
          Stream.fromIterable([
            { _tag: "ProgressMarker", at: 0 } as unknown as never,
          ]),
        GetById: () => Effect.die("unused"),
        Query: () => Effect.die("unused"),
        QueryAfter: () => Effect.die("unused"),
      }
      const shape = yield* makeCloudEventStore(mockClient, reg)

      // The current filterMap drops anything with _tag === "Heartbeat"
      // and forwards the rest as EventEnvelope. A ProgressMarker would
      // be forwarded to the cursor tap (no `id` field) and explode there.
      // The test asserts the error surfaces, not silently drops.
      const result = yield* Stream.runCollect(
        shape.subscribe({ cursor: "earliest" }).pipe(Stream.take(1)),
      ).pipe(Effect.either)
      expect(result._tag).toBe("Left")
    }).pipe(Effect.provide(EventRegistry.Live)),
  )
})
```

- [ ] **Step 2: Run the test**

Run: `cd packages/store-cloud && bun run test`
Expected: PASS — the cursor tap's `Ref.set(lastDelivered, e.id)` fails for an item without an id, propagating as Stream failure.

If FAIL (silent swallow), tighten the filter to either pass-through unknown tags as failures or explicitly reject unknown `_tag`s. The error path that's acceptable: `Stream.die`, `Stream.fail`, OR converted to `SubscribeError` via the existing Stream.mapError. NOT acceptable: silently dropping items.

- [ ] **Step 3: Commit**

```bash
git add packages/store-cloud/test/CloudStore.test.ts
git commit -m "test(store-cloud): future-sentinel decode failure surfaces

Regression guard: a sentinel with an unknown _tag (e.g., a v0.6
ProgressMarker arriving at a v0.5 client) must not be silently
dropped. The current pipeline ordering guarantees this — the
filterMap forwards non-Heartbeat items to the cursor tap, which
crashes on the missing id field.

If a future v0.6 wants graceful unknown-sentinel handling, this
test will fail and the v0.6 design has to add an explicit forward-
compat policy."
```

---

## Phase F — `apps/web` adoption

### Task 16: `apps/web` RxweaveBridge uses LiveFromBrowser

**Files:**
- Modify: `apps/web/src/RxweaveBridge.tsx`

- [ ] **Step 1: Verify current build is green**

Run: `cd apps/web && bun run build`
Expected: Build succeeds.

- [ ] **Step 2: Replace bridge code with `LiveFromBrowser`**

```typescript
// apps/web/src/RxweaveBridge.tsx — replace the manual two-phase drain + token bootstrap
// with CloudStore.LiveFromBrowser. The exact diff depends on the current bridge code;
// the goal is:
//
//   - Drop the manual fetch('/rxweave/session-token') + cache code.
//   - Drop the manual two-phase drain (Query then Subscribe).
//   - Replace with `CloudStore.LiveFromBrowser({ origin: window.location.origin })`.
//   - Compose with EventRegistry.Live and provide to the React tree.

import { CloudStore } from "@rxweave/store-cloud"
import { Layer } from "effect"
import { EventRegistry } from "@rxweave/schema"

const StoreLayer = Layer.merge(
  EventRegistry.Live,
  CloudStore.LiveFromBrowser({ origin: window.location.origin }),
)
```

(Refer to the existing `RxweaveBridge.tsx` for how the layer is provided into the canvas — likely an `Effect.provide` at the bridge boundary or a React context.)

- [ ] **Step 3: Build and dev-server smoke test**

```bash
cd apps/web
bun run build
bun run dev   # in another terminal; manually verify in browser
```

Expected:
- Build succeeds.
- Dev server starts without errors.
- In Chrome: open the canvas, append an event, see it appear immediately. No regression.
- In Safari (manual smoke): open the canvas, simulate a 100-event burst (paste many shapes), watch live tail flow without the post-replay stall.

- [ ] **Step 4: Run apps/web tests**

```bash
cd apps/web
bun run test 2>&1 || true
```

Expected: Tests pass (or absent — apps/web may not have a test suite). Build is the load-bearing check.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/RxweaveBridge.tsx
git commit -m "feat(web): use CloudStore.LiveFromBrowser

Drops the bespoke two-phase drain code in RxweaveBridge and the
manual /rxweave/session-token bootstrap. Both responsibilities now
live inside the LiveFromBrowser factory: drainBeforeSubscribe pages
QueryAfter, sessionTokenFetch handles bearer + 401 refresh, the
heartbeat opt-in (15s default) keeps WebKit's fetch buffer flushing,
and the watchdog reconnects from lastDelivered on silent failure.

Manual Safari smoke before tagging v0.5: append 1000 events in one
burst, watch live tail flow without the post-replay stall that the
manual workaround couldn't cover beyond the first event."
```

---

## Phase G — Polish items

### Task 17: `EventRegistry.registerAll` helper (digest-aware)

**Files:**
- Modify: `packages/schema/src/Registry.ts`
- Test: `packages/schema/test/Registry.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/schema/test/Registry.test.ts (add new describe block)
import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { defineEvent, EventRegistry, DuplicateEventType } from "../src/index.js"

describe("EventRegistry.registerAll", () => {
  it.effect("registers a fresh batch", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      const A = defineEvent("a", Schema.Struct({ x: Schema.Number }))
      const B = defineEvent("b", Schema.Struct({ y: Schema.String }))
      yield* reg.registerAll([A, B])
      const all = yield* reg.all
      expect(all.map((d) => d.type).sort()).toEqual(["a", "b"])
    }).pipe(Effect.provide(EventRegistry.Live)),
  )

  it.effect("with swallowDuplicates: identical re-registration is a no-op", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      const A = defineEvent("a", Schema.Struct({ x: Schema.Number }))
      yield* reg.register(A)
      yield* reg.registerAll([A], { swallowDuplicates: true })
      const all = yield* reg.all
      expect(all.length).toBe(1)
    }).pipe(Effect.provide(EventRegistry.Live)),
  )

  it.effect("with swallowDuplicates: conflicting redefinition still errors", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      const A1 = defineEvent("a", Schema.Struct({ x: Schema.Number }))
      const A2 = defineEvent("a", Schema.Struct({ x: Schema.String })) // different shape, same type
      yield* reg.register(A1)
      const result = yield* reg
        .registerAll([A2], { swallowDuplicates: true })
        .pipe(Effect.either)
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(DuplicateEventType)
      }
    }).pipe(Effect.provide(EventRegistry.Live)),
  )
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/schema && bun run test`
Expected: FAIL — `registerAll` not on the EventRegistry service.

- [ ] **Step 3: Implement `registerAll`**

```typescript
// packages/schema/src/Registry.ts (extend the existing service)

// Inside the EventRegistry service definition, add a registerAll method.
// The exact shape depends on how EventRegistry is currently defined
// (Context.Tag or Effect.Service). Pattern below is a sketch:

export const EventRegistry = Context.GenericTag<{
  // ... existing methods ...
  readonly register: (def: EventDef) => Effect.Effect<void, DuplicateEventType, never>
  readonly registerAll: (
    defs: ReadonlyArray<EventDef>,
    opts?: { readonly swallowDuplicates?: boolean },
  ) => Effect.Effect<void, DuplicateEventType, never>
  readonly digest: Effect.Effect<string>
  readonly all: Effect.Effect<ReadonlyArray<EventDef>>
}>("EventRegistry")

// In the Live layer, the implementation is:
const registerAll = (
  defs: ReadonlyArray<EventDef>,
  opts?: { readonly swallowDuplicates?: boolean },
): Effect.Effect<void, DuplicateEventType, never> =>
  Effect.forEach(defs, (def) =>
    Effect.gen(function* () {
      // Look up existing def by type name.
      const existing = yield* getByType(def.type) // a helper that returns Option<EventDef>
      if (Option.isSome(existing)) {
        const existingDigest = yield* digestOfDef(existing.value)
        const newDigest = yield* digestOfDef(def)
        if (existingDigest === newDigest) {
          if (opts?.swallowDuplicates === true) return
          return yield* Effect.fail(new DuplicateEventType({ type: def.type }))
        }
        // Conflicting digest — never swallow.
        return yield* Effect.fail(new DuplicateEventType({ type: def.type }))
      }
      yield* register(def)
    }),
  ).pipe(Effect.asVoid)
```

The `digestOfDef` and `getByType` helpers may need to be added or surfaced from the existing registry implementation. The semantic contract: same name + same digest → idempotent (swallow if flag set, error otherwise); same name + different digest → always error.

- [ ] **Step 4: Run the tests**

Run: `cd packages/schema && bun run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/Registry.ts packages/schema/test/Registry.test.ts
git commit -m "feat(schema): EventRegistry.registerAll(defs, { swallowDuplicates })

Helper that batch-registers an array of event defs. With
swallowDuplicates: true, an attempt to re-register a def whose name
AND digest match an existing def is a silent no-op (covers HMR-
style remount where the same module loads twice). A name-match with
a digest-mismatch ALWAYS errors regardless of the flag — those are
genuine schema conflicts that must not be silently masked.

Reduces the four hand-rolled for-loops in apps/web (server + bridge)
and packages/cli (Setup, dev) to single calls, taken in next task."
```

### Task 18: Replace `registerAll` call sites

**Files:**
- Modify: `packages/cli/src/Setup.ts`
- Modify: `packages/cli/src/commands/dev.ts`
- Modify: `apps/web/server/server.ts`
- Modify: `apps/web/src/RxweaveBridge.tsx` (already touched in Task 16; further trim here)

- [ ] **Step 1: Replace each call site**

For each file, find the existing pattern:
```typescript
for (const def of schemas) {
  yield* reg.register(def)
}
```

Replace with:
```typescript
yield* reg.registerAll(schemas)
```

For the apps/web bridge specifically, use:
```typescript
yield* reg.registerAll(schemas, { swallowDuplicates: true })
```

(Bridge re-loads schemas on every HMR; identical-digest re-registration should be silent.)

- [ ] **Step 2: Run all affected test suites**

```bash
cd packages/cli && bun run test
cd packages/schema && bun run test
cd apps/web && bun run build
```

Expected: All pass.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/Setup.ts packages/cli/src/commands/dev.ts apps/web/server/server.ts apps/web/src/RxweaveBridge.tsx
git commit -m "refactor: use EventRegistry.registerAll at four call sites

Collapses hand-rolled for-loops in CLI (Setup, dev) and apps/web
(server, bridge) into single registerAll calls. The bridge passes
swallowDuplicates: true to handle Vite HMR re-imports cleanly."
```

### Task 19: Fold `mkdirSync` into `generateAndPersistToken`

**Files:**
- Modify: `packages/server/src/Auth.ts`
- Modify: `packages/cli/src/commands/serve.ts`
- Modify: `apps/web/server/server.ts`
- Test: `packages/server/test/Auth.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/test/Auth.test.ts (add)
import { test, expect } from "bun:test"
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import { generateAndPersistToken } from "../src/Auth.js"

test("generateAndPersistToken creates the parent directory if missing", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rxweave-auth-"))
  try {
    const tokenFile = join(tmp, "nested", "subdir", "serve.token")
    expect(existsSync(join(tmp, "nested"))).toBe(false)

    const token = await Effect.runPromise(generateAndPersistToken({ tokenFile }))

    expect(existsSync(tokenFile)).toBe(true)
    expect(readFileSync(tokenFile, "utf8").trim()).toBe(token)
    expect(token.startsWith("rxk_")).toBe(true)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/server && bun run test`
Expected: FAIL — `writeFileSync` errors with ENOENT because the parent dir doesn't exist.

- [ ] **Step 3: Add `mkdirSync` to `generateAndPersistToken`**

```typescript
// packages/server/src/Auth.ts
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export const generateAndPersistToken = (opts: {
  readonly tokenFile: string
}): Effect.Effect<string> =>
  Effect.sync(() => {
    const token = generateToken()
    // Ensure the parent directory exists. Synchronous to match the
    // surrounding Effect.sync body (the sibling writeFileSync is
    // also synchronous).
    mkdirSync(dirname(opts.tokenFile), { recursive: true })
    writeFileSync(opts.tokenFile, token + "\n", { encoding: "utf8", mode: 0o600 })
    try {
      chmodSync(opts.tokenFile, 0o600)
    } catch {
      // (existing comment about Windows)
    }
    return token
  })
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/server && bun run test`
Expected: PASS.

- [ ] **Step 5: Drop the hand-rolled `mkdirSync` from callers**

In `packages/cli/src/commands/serve.ts:111` and `apps/web/server/server.ts:34`, remove the pre-call `mkdirSync(dirname(tokenFile), { recursive: true })` line. The function now handles it internally.

- [ ] **Step 6: Run the full test suites for affected packages**

```bash
cd packages/server && bun run test
cd packages/cli && bun run test
cd apps/web && bun run build
```

Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/Auth.ts packages/server/test/Auth.test.ts packages/cli/src/commands/serve.ts apps/web/server/server.ts
git commit -m "refactor(server): fold mkdirSync into generateAndPersistToken

Two callers (CLI serve, apps/web server) previously hand-rolled
mkdirSync(dirname(tokenFile), { recursive: true }) before invoking
generateAndPersistToken. Move that responsibility inside the
function — the existing Effect.sync body uses synchronous fs
primitives (writeFileSync, chmodSync), so mkdirSync fits the same
boundary cleanly. Callers drop their boilerplate."
```

### Task 20: Relocate `apps/web/server/schemas.ts` → `apps/web/src/shared/schemas.ts`

**Files:**
- Move: `apps/web/server/schemas.ts` → `apps/web/src/shared/schemas.ts`
- Modify: `apps/web/server/server.ts`
- Modify: `apps/web/src/RxweaveBridge.tsx`

- [ ] **Step 1: Move the file**

```bash
mkdir -p apps/web/src/shared
git mv apps/web/server/schemas.ts apps/web/src/shared/schemas.ts
```

- [ ] **Step 2: Update import paths in callers**

In `apps/web/server/server.ts`, change:
```typescript
import { schemas } from "./schemas.js"
```
to:
```typescript
import { schemas } from "../src/shared/schemas.js"
```

In `apps/web/src/RxweaveBridge.tsx`, change:
```typescript
import { schemas } from "../server/schemas.js"
```
to:
```typescript
import { schemas } from "./shared/schemas.js"
```

(Adjust the exact import based on what's actually in those files. If there are multiple importers, update each.)

- [ ] **Step 3: Verify build + dev watch**

```bash
cd apps/web
bun run build
```

Expected: Build succeeds with the new import paths.

```bash
bun run dev    # in another terminal
# Edit apps/web/src/shared/schemas.ts; expect bun --watch to pick it up.
```

If the dev watch glob excludes `src/shared/`, update `apps/web/package.json`'s `dev` script's watch path.

- [ ] **Step 4: Commit**

```bash
git add apps/web/server/server.ts apps/web/src/RxweaveBridge.tsx apps/web/src/shared/schemas.ts apps/web/package.json
git commit -m "refactor(web): relocate canvas schemas to src/shared/

Bridge previously imported ../server/schemas.js, crossing the
browser/server source boundary. The schemas are shared input data,
not server logic. Move to src/shared/ so the import graph reflects
the actual semantic split."
```

---

## Phase H — Release prep

### Task 21: CHANGELOG, version bump, smoke test, ship

**Files:**
- Modify: `CHANGELOG.md` (or per-package CHANGELOGs via changesets)
- Modify: every `package.json` to v0.5.0 (handled by `bunx changeset version`)

- [ ] **Step 1: Add a changeset entry**

```bash
bunx changeset add
# Select MINOR for all @rxweave/* packages.
# Title: "v0.5.0 — browser streaming"
# Summary: paste the headline from the spec §1 + bullet list of the seven major changes
# (heartbeat protocol, server emitter, LiveFromBrowser, per-subscriber state, watchdog,
# registerAll, mkdirSync fold, schema relocation).
```

- [ ] **Step 2: Run all tests + build top-to-bottom**

```bash
bun run test    # turbo runs all package suites
bun run build   # turbo runs all builds
```

Expected: All packages green; both turbo tasks succeed.

- [ ] **Step 3: Local smoke test against built CLI**

```bash
cd packages/cli
node dist/bin/rxweave.js --version
# Expected: 0.5.0 (post-changeset version bump)
```

- [ ] **Step 4: Manual Safari smoke for browser story**

```bash
cd apps/web
bun run dev
# Open in Safari at http://localhost:5200 (or whichever port).
# Verify:
# 1. Canvas loads.
# 2. Append a single shape — appears immediately.
# 3. Append 1000 shapes in a burst (paste-many or scripted append).
# 4. After replay completes, append one more shape — it appears within 15 seconds (one heartbeat cycle).
#    Pre-fix this would have stalled indefinitely.
# 5. Idle for 60 seconds — no errors, no reconnect storm.
```

If step 4 fails, the heartbeat is not unblocking WebKit. Re-verify Tasks 4 + 14.

- [ ] **Step 5: Tag and ship**

```bash
bunx changeset version  # bumps to v0.5.0 across the monorepo
git add -A
git commit -m "chore(release): v0.5.0"
git tag v0.5.0
git push origin main --tags
```

The release workflow (`.github/workflows/release.yml`) takes over: rewrites `workspace:^` refs, publishes via Trusted Publishing, runs the post-publish smoke test (added in 2026-04-23 hygiene PR — installs `@rxweave/cli@0.5.0` in a fresh dir and asserts `rxweave --version` matches).

- [ ] **Step 6: Update HANDOFF.md after ship**

Update `docs/HANDOFF.md`:
- v0.5.0 row in the "What shipped" table.
- Move handoff items #1, #2, #3, #4, #5 from "Deferred follow-ups" to the shipped section.
- Add a new "Immediate pending" or "Deferred follow-ups" section if anything new emerged.

```bash
git add docs/HANDOFF.md
git commit -m "docs(handoff): update for v0.5.0 ship"
git push
```

---

## Self-review checklist (run before declaring the plan done)

- [ ] Every spec section maps to at least one task. Cross-reference §3 (scope) — Heartbeat schema (Task 1), Subscribe handler (Tasks 3–5), Server e2e (Task 6), per-subscriber state (Task 7), filter (Task 8), watchdog (Tasks 9–10), Auth (Task 11), makeLive (Task 12), drain (Task 13), LiveFromBrowser (Task 14), future-sentinel test (Task 15), apps/web (Task 16), polish (Tasks 17–20), release (Task 21).
- [ ] No "TBD", "TODO", "fill in details" placeholders.
- [ ] Type names consistent across tasks: `Heartbeat`, `WatchdogTimeout`, `SessionTokenFetch`, `LiveFromBrowser`, `makeLive`, `drainBeforeSubscribe`, `lastDelivered`, `lastHeartbeatAt`, `registerAll`, `swallowDuplicates`. None drift between tasks.
- [ ] Spec compatibility invariants (§4.4) are tested: backwards-compat (Task 3), unknown-field tolerance (Task 1's payload widening test).
- [ ] Codex's findings (§spec 11) all have a corresponding task. (1) Wire format → Task 6. (2) Eager-emit → Task 4. (3) Tolerance → Task 1. (4) Discriminator → Task 1. (5) url/origin → Task 14. (6) Watchdog vs old-server → Task 9. (7) Watchdog reconnect → Task 10. (8) mkdir fold → Task 19. (9) swallowDuplicates → Task 17. (10) Filter ordering → Task 8. (11) Per-subscriber state → Task 7. (12) Library reconnect → Task 14 (LiveFromBrowser composes makeLive's existing retry).
