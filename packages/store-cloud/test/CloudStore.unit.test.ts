import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Chunk, Context, Effect, Exit, Fiber, Layer, Stream, TestClock } from "effect"
import { EventStore } from "@rxweave/core"
import { EventRegistry, SystemAgentHeartbeat, defineEvent } from "@rxweave/schema"
import { Schema } from "effect"
import {
  cachedToken,
  CloudStore,
  type CloudRpcClient,
  type LiveFromBrowserOpts,
  isRetryable,
  makeCloudEventStore,
  syncRegistry,
  withBearerToken,
} from "../src/index.js"

/**
 * Unit-level tests. We do NOT exercise the HTTP layer here — that's what
 * integration.test.ts is for. These tests assert the shape of the public
 * API: that constructors don't throw, that layers compose against the
 * minimum dependency set, and that helpers (like `syncRegistry`) behave
 * correctly given a stub RPC client.
 */

describe("CloudStore (unit)", () => {
  it.effect("Live is a function accepting { url, token }", () =>
    Effect.sync(() => {
      expect(typeof CloudStore.Live).toBe("function")
      const layer = CloudStore.Live({
        url: "http://example.invalid/rpc",
        token: () => "test-token",
      })
      // Construction must not throw; it should return a Layer. We can't
      // invoke layer.build() without providing EventRegistry, but the
      // return shape is enough of a smoke test here.
      expect(layer).toBeDefined()
      expect(typeof (layer as unknown as { pipe: unknown }).pipe).toBe("function")
    }),
  )

  it.effect("Layer.build(Live) requires EventRegistry", () =>
    Effect.gen(function* () {
      // Providing EventRegistry.Live should satisfy every requirement
      // except actually hitting the network (which we don't do until an
      // EventStore method is called).
      const base = CloudStore.Live({
        url: "http://example.invalid/rpc",
        token: () => Promise.resolve("async-token"),
      })
      const full = Layer.provide(base, EventRegistry.Live)
      const ctx = yield* Layer.build(full)
      const store = Context.get(ctx, EventStore)
      expect(store).toBeDefined()
      expect(typeof store.append).toBe("function")
      expect(typeof store.subscribe).toBe("function")
    }).pipe(Effect.scoped),
  )

  it.effect("withBearerToken returns a middleware function", () =>
    Effect.sync(() => {
      const mw = withBearerToken(() => "t")
      expect(typeof mw).toBe("function")
    }),
  )

  // v0.2.1: cachedToken wraps a TokenProvider in a TTL cache so the
  // underlying provider is called at most once per TTL window.
  it.effect("cachedToken reuses the cached value within TTL", () =>
    Effect.promise(async () => {
      let calls = 0
      const provider = () => {
        calls += 1
        return `t-${calls}`
      }

      // Pin `Date.now()` so we can control TTL expiry deterministically.
      // We advance `now` between calls to simulate wall-clock progress.
      const real = Date.now
      let now = 1_000_000_000_000
      Date.now = () => now
      try {
        const cached = cachedToken(provider, 300_000)

        const first = await cached()
        expect(first).toBe("t-1")
        expect(calls).toBe(1)

        // Within TTL → no new call to the underlying provider.
        now += 299_999
        const second = await cached()
        expect(second).toBe("t-1")
        expect(calls).toBe(1)

        // Just past TTL → underlying provider fires again.
        now += 2
        const third = await cached()
        expect(third).toBe("t-2")
        expect(calls).toBe(2)

        // invalidate() clears the cache unconditionally.
        cached.invalidate()
        const fourth = await cached()
        expect(fourth).toBe("t-3")
        expect(calls).toBe(3)
      } finally {
        Date.now = real
      }
    }),
  )

  it.effect("cachedToken exposes an invalidate() function", () =>
    Effect.sync(() => {
      const cached = cachedToken(() => "x")
      expect(typeof cached.invalidate).toBe("function")
    }),
  )

  it.effect("syncRegistry short-circuits when digests match", () =>
    Effect.gen(function* () {
      let diffCalls = 0
      let pushCalls = 0
      const stub = {
        RegistrySyncDiff: (_input: { readonly clientDigest: string }) =>
          Effect.sync(() => {
            diffCalls += 1
            return {
              upToDate: true,
              missingOnClient: [] as ReadonlyArray<never>,
              missingOnServer: [] as ReadonlyArray<string>,
            }
          }),
        RegistryPush: (_input: { readonly defs: ReadonlyArray<never> }) =>
          Effect.sync(() => {
            pushCalls += 1
          }),
      }
      const result = yield* syncRegistry(stub).pipe(
        Effect.provide(EventRegistry.Live),
      )
      expect(result.upToDate).toBe(true)
      expect(result.pushed).toBe(0)
      expect(diffCalls).toBe(1)
      expect(pushCalls).toBe(0)
    }),
  )

  it.effect("syncRegistry skips RegistryPush when digests differ but registry is empty", () =>
    Effect.gen(function* () {
      let pushCalls = 0
      let pushedDefs = 0
      const stub = {
        RegistrySyncDiff: (_input: { readonly clientDigest: string }) =>
          Effect.succeed({
            upToDate: false,
            missingOnClient: [] as ReadonlyArray<never>,
            missingOnServer: [] as ReadonlyArray<string>,
          }),
        RegistryPush: (input: { readonly defs: ReadonlyArray<unknown> }) =>
          Effect.sync(() => {
            pushCalls += 1
            pushedDefs = input.defs.length
          }),
      }
      // Registry is empty; nothing should be pushed even though digests
      // differ. This guards against sending an empty-array RegistryPush.
      const result = yield* syncRegistry(stub).pipe(
        Effect.provide(EventRegistry.Live),
      )
      expect(result.upToDate).toBe(false)
      expect(pushCalls).toBe(0)
      expect(pushedDefs).toBe(0)
      expect(result.pushed).toBe(0)
    }),
  )

  it.effect("syncRegistry pushes registered defs when digests differ", () =>
    Effect.gen(function* () {
      let pushCalls = 0
      let pushedDefs = 0
      const stub = {
        RegistrySyncDiff: (_input: { readonly clientDigest: string }) =>
          Effect.succeed({
            upToDate: false,
            missingOnClient: [] as ReadonlyArray<never>,
            missingOnServer: [] as ReadonlyArray<string>,
          }),
        RegistryPush: (input: { readonly defs: ReadonlyArray<unknown> }) =>
          Effect.sync(() => {
            pushCalls += 1
            pushedDefs = input.defs.length
          }),
      }
      const populate = Effect.gen(function* () {
        const registry = yield* EventRegistry
        yield* registry.register(SystemAgentHeartbeat)
      })
      const result = yield* populate.pipe(
        Effect.zipRight(syncRegistry(stub)),
        Effect.provide(EventRegistry.Live),
      )
      expect(result.upToDate).toBe(false)
      expect(pushCalls).toBe(1)
      expect(pushedDefs).toBe(1)
      expect(result.pushed).toBe(1)
    }),
  )

  // Fix 4 — High 3: when the server enumerates `missingOnServer`, push
  // should be the intersection of local defs and that list, not the
  // whole registry. Guards against spamming the server with defs it
  // already has (and against failing when a client holds a def the
  // server explicitly rejected).
  it.effect("syncRegistry filters push by diff.missingOnServer when non-empty", () =>
    Effect.gen(function* () {
      const TypeX = defineEvent("x", Schema.Struct({ v: Schema.String }))
      const TypeY = defineEvent("y", Schema.Struct({ v: Schema.String }))
      const TypeZ = defineEvent("z", Schema.Struct({ v: Schema.String }))

      let pushedTypes: ReadonlyArray<string> = []
      const stub = {
        RegistrySyncDiff: (_input: { readonly clientDigest: string }) =>
          Effect.succeed({
            upToDate: false,
            missingOnClient: [] as ReadonlyArray<never>,
            missingOnServer: ["x", "y"] as ReadonlyArray<string>,
          }),
        RegistryPush: (input: {
          readonly defs: ReadonlyArray<{ readonly type: string }>
        }) =>
          Effect.sync(() => {
            pushedTypes = input.defs.map((d) => d.type)
          }),
      }
      const populate = Effect.gen(function* () {
        const registry = yield* EventRegistry
        yield* registry.register(TypeX)
        yield* registry.register(TypeY)
        yield* registry.register(TypeZ)
      })
      const result = yield* populate.pipe(
        Effect.zipRight(syncRegistry(stub)),
        Effect.provide(EventRegistry.Live),
      )
      expect(result.pushed).toBe(2)
      // Exactly x and y, not z.
      expect(new Set(pushedTypes)).toEqual(new Set(["x", "y"]))
    }),
  )

  // Fix 1 — Critical 3: latestCursor must reflect the most recently
  // appended envelope's id (append-scoped), not the most recently
  // subscribe-delivered one. Uses a stubbed RPC client to avoid
  // standing up the HTTP/NDJSON transport.
  it.effect("latestCursor updates after append to the last envelope's id", () =>
    Effect.gen(function* () {
      const fakeEnvelope = {
        id: "01AAAAAAAAAAAAAAAAAAAAAAAA",
        type: "canvas.node.created",
        payload: {},
        time: 0,
        source: { kind: "human" as const },
        actor: "test",
        idempotencyKey: undefined,
      } as const

      const stub: CloudRpcClient = {
        Append: (_input) => Effect.succeed([fakeEnvelope as never]),
        Subscribe: () => Stream.empty,
        GetById: (_input) => Effect.succeed(fakeEnvelope as never),
        Query: (_input) => Effect.succeed([]),
        QueryAfter: (_input) => Effect.succeed([]),
      }

      const program = Effect.gen(function* () {
        const registry = yield* EventRegistry
        const store = yield* makeCloudEventStore(stub, registry)

        // Baseline: before any append, latestCursor is "earliest".
        const before = yield* store.latestCursor
        expect(before).toBe("earliest")

        // After a successful append, latestCursor reflects the envelope
        // returned by the server — NOT "latest" (the old bug) and NOT
        // whatever the subscribe stream delivered.
        yield* store.append([
          {
            type: "canvas.node.created",
            payload: {},
            source: { kind: "human" },
            actor: "test",
          } as never,
        ])
        const after = yield* store.latestCursor
        expect(after).toBe(fakeEnvelope.id)
      })

      yield* program.pipe(Effect.provide(EventRegistry.Live))
    }),
  )

  it.effect("latestCursor stays 'earliest' when append returns an empty batch", () =>
    Effect.gen(function* () {
      const stub: CloudRpcClient = {
        Append: (_input) => Effect.succeed([]),
        Subscribe: () => Stream.empty,
        GetById: (_input) => Effect.fail(new Error("unused")),
        Query: (_input) => Effect.succeed([]),
        QueryAfter: (_input) => Effect.succeed([]),
      }

      const program = Effect.gen(function* () {
        const registry = yield* EventRegistry
        const store = yield* makeCloudEventStore(stub, registry)
        yield* store.append([])
        const cursor = yield* store.latestCursor
        expect(cursor).toBe("earliest")
      })

      yield* program.pipe(Effect.provide(EventRegistry.Live))
    }),
  )

  // Fix 2 — High 1: retry classification. Permanent errors must fail
  // fast; only transient transport-layer errors consume the retry
  // budget. We stub Subscribe to fail with a NotFoundWireError-shaped
  // value, count the number of connection attempts, and assert the
  // stream terminates after exactly one attempt.
  it.effect("subscribe fails fast on NotFoundWireError without retrying", () =>
    Effect.gen(function* () {
      let subscribeCalls = 0
      const permanentError = {
        _tag: "NotFoundWireError",
        id: "01AAAAAAAAAAAAAAAAAAAAAAAA",
      }
      const stub: CloudRpcClient = {
        Append: (_input) => Effect.succeed([]),
        Subscribe: (_input) => {
          subscribeCalls += 1
          return Stream.fail(permanentError)
        },
        GetById: (_input) => Effect.fail(new Error("unused")),
        Query: (_input) => Effect.succeed([]),
        QueryAfter: (_input) => Effect.succeed([]),
      }

      const program = Effect.gen(function* () {
        const registry = yield* EventRegistry
        const store = yield* makeCloudEventStore(stub, registry)
        const exit = yield* Effect.exit(
          Stream.runCollect(store.subscribe({ cursor: "earliest" })),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        // Exactly one connect attempt — the retry schedule should
        // short-circuit via `isRetryable` returning false.
        expect(subscribeCalls).toBe(1)
      })

      yield* program.pipe(Effect.provide(EventRegistry.Live))
    }),
  )

  it.effect("subscribe fails fast on RegistryWireError without retrying", () =>
    Effect.gen(function* () {
      let subscribeCalls = 0
      const stub: CloudRpcClient = {
        Append: (_input) => Effect.succeed([]),
        Subscribe: (_input) => {
          subscribeCalls += 1
          return Stream.fail({ _tag: "RegistryWireError", reason: "digest-mismatch" })
        },
        GetById: (_input) => Effect.fail(new Error("unused")),
        Query: (_input) => Effect.succeed([]),
        QueryAfter: (_input) => Effect.succeed([]),
      }

      const program = Effect.gen(function* () {
        const registry = yield* EventRegistry
        const store = yield* makeCloudEventStore(stub, registry)
        const exit = yield* Effect.exit(
          Stream.runCollect(store.subscribe({ cursor: "earliest" })),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(subscribeCalls).toBe(1)
      })

      yield* program.pipe(Effect.provide(EventRegistry.Live))
    }),
  )

  // Sanity test for the classifier itself — these cases matter because
  // future wire errors might be added without remembering to keep the
  // classifier in sync.
  it.effect("isRetryable classifier matches the documented heuristic", () =>
    Effect.sync(() => {
      expect(isRetryable({ _tag: "RpcClientError", reason: "Protocol" })).toBe(true)
      expect(isRetryable({ _tag: "SubscribeWireError", lagged: true })).toBe(true)
      expect(isRetryable({ _tag: "SubscribeWireError", reason: "subscriber-lagged" })).toBe(true)
      expect(isRetryable({ _tag: "SubscribeWireError", reason: "invalid-cursor" })).toBe(false)
      expect(isRetryable({ _tag: "NotFoundWireError", id: "x" })).toBe(false)
      expect(isRetryable({ _tag: "RegistryWireError", reason: "foo" })).toBe(false)
      expect(isRetryable({ _tag: "WatchdogTimeout", idleMs: 45_000 })).toBe(true)
      expect(isRetryable({ status: 401 })).toBe(false)
      expect(isRetryable({ status: 503 })).toBe(true)
      expect(isRetryable({})).toBe(false)
      expect(isRetryable(null)).toBe(false)
      expect(isRetryable("string")).toBe(false)
    }),
  )
})

describe("CloudStore — per-subscriber cursor state", () => {
  it.effect("two concurrent subscribers don't share lastDelivered", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      const subscribeCalls: Array<string> = []
      const mockClient: CloudRpcClient = {
        Append: () => Effect.succeed([]),
        Subscribe: (input) => {
          subscribeCalls.push(input.cursor)
          return Stream.fromIterable([
            { id: `evt-after-${input.cursor}`, type: "x", actor: "a", source: "cli", timestamp: 0, payload: {} },
          ] as unknown as Array<never>)
        },
        GetById: () => Effect.die("unused"),
        Query: () => Effect.die("unused"),
        QueryAfter: () => Effect.die("unused"),
      }

      const shape = yield* makeCloudEventStore(mockClient, reg)

      yield* Stream.runCollect(shape.subscribe({ cursor: "cursor-A" }).pipe(Stream.take(1)))
      yield* Stream.runCollect(shape.subscribe({ cursor: "earliest" }).pipe(Stream.take(1)))

      expect(subscribeCalls[0]).toBe("cursor-A")
      expect(subscribeCalls[1]).toBe("earliest")
    }).pipe(Effect.provide(EventRegistry.Live)),
  )
})

describe("CloudStore — heartbeat watchdog", () => {
  it.scoped("watchdog fires after 3 × intervalMs of silence post-heartbeat", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      // First subscribe call: emit one heartbeat then hang forever.
      // Subsequent calls (retries): emit a permanent error so the retry
      // budget is spent immediately without needing further clock advances.
      let callCount = 0
      const mockClient: CloudRpcClient = {
        Append: () => Effect.succeed([]),
        Subscribe: () => {
          callCount++
          if (callCount === 1) {
            return Stream.concat(
              Stream.fromIterable([
                { _tag: "Heartbeat", at: 0 } as unknown as never,
              ]),
              Stream.never,
            )
          }
          // Non-retryable permanent error on reconnect → stream fails fast.
          return Stream.fail({ _tag: "NotFoundWireError", id: "x" })
        },
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
      // Phase 1: advance past 3 × intervalMs (3000ms) to the next 1Hz poll
      // tick. The schedule checks at t=0, 1000, 2000, 3000, 4000ms; at
      // 4000ms `4000 - 0 > 3000` fires WatchdogTimeout.
      yield* TestClock.adjust("4100 millis")
      // Phase 2: the retry schedule uses exponential backoff; advance
      // through the first retry delay (500ms) so the retry can reconnect
      // and hit the permanent error on the second Subscribe call.
      yield* TestClock.adjust("1000 millis")
      const exit = yield* Fiber.await(fiber)
      // WatchdogTimeout fired → retry → second connect emits permanent error
      // → stream fails (non-retryable).
      expect(exit._tag).toBe("Failure")
    }).pipe(Effect.provide(EventRegistry.Live)),
  )

  it.scoped("watchdog does NOT fire when no heartbeat ever observed (cloud-v0.2 path)", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      const mockClient: CloudRpcClient = {
        Append: () => Effect.succeed([]),
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
      yield* TestClock.adjust("60000 millis")
      const status = yield* Fiber.status(fiber)
      // Fiber should still be running (suspended on the never-stream)
      // because the watchdog never armed.
      expect(status._tag).toBe("Suspended")
      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.provide(EventRegistry.Live)),
  )
})

describe("CloudStore — heartbeat filter ordering", () => {
  it.effect("heartbeats do not appear in user-facing stream", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
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
    // Intent: if heartbeats accidentally write to lastDelivered (which
    // has no `id`), the second subscribe would resume from `undefined`
    // instead of the original cursor. We verify this by:
    //   1. Running a subscribe over a [Heartbeat, Heartbeat, envelope] stream
    //      and collecting exactly the one envelope.
    //   2. Running a second subscribe with a *different* cursor.
    //   3. Asserting that the second subscribe call received that *different*
    //      cursor — not some heartbeat-corrupted value.
    // If heartbeats were writing to lastDelivered, step 2 would use the
    // corrupted cursor instead.
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      const subscribeCalls: Array<string> = []
      let callCount = 0
      const mockClient: CloudRpcClient = {
        Append: () => Effect.succeed([]),
        Subscribe: (input) => {
          subscribeCalls.push(input.cursor)
          callCount++
          if (callCount === 1) {
            // First subscription: two heartbeats then one real envelope
            return Stream.fromIterable([
              { _tag: "Heartbeat", at: 1 } as unknown as never,
              { _tag: "Heartbeat", at: 2 } as unknown as never,
              { id: "evt-after-heartbeats", type: "x", actor: "a", source: "cli", timestamp: 0, payload: {} } as unknown as never,
            ])
          }
          return Stream.empty
        },
        GetById: () => Effect.die("unused"),
        Query: () => Effect.die("unused"),
        QueryAfter: () => Effect.die("unused"),
      }
      const shape = yield* makeCloudEventStore(mockClient, reg)

      // Pull exactly one item from the first stream (the real envelope
      // after the heartbeats). The heartbeats are silently dropped.
      const first = yield* Stream.runCollect(
        shape.subscribe({ cursor: "earliest" }).pipe(Stream.take(1))
      )
      expect(Chunk.size(first)).toBe(1)

      // Second subscribe uses a new cursor — should NOT be overridden by
      // heartbeat-corrupted lastDelivered from the first call.
      // Use Stream.runDrain (not Stream.take(0)) to actually pull from
      // the stream so the connect Effect fires and Subscribe is called.
      yield* Stream.runDrain(shape.subscribe({ cursor: "cursor-B" }))

      // First call used "earliest"; second call used "cursor-B" (not
      // some undefined/corrupted cursor from the heartbeats).
      expect(subscribeCalls[0]).toBe("earliest")
      expect(subscribeCalls[1]).toBe("cursor-B")
    }).pipe(Effect.provide(EventRegistry.Live)),
  )
})

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
            // First connection: emit one envelope, one heartbeat, then go silent.
            // The envelope sets lastDelivered to "evt-A"; the heartbeat arms the
            // watchdog. After clock advances past 3 × intervalMs, WatchdogTimeout
            // fires, Stream.retry triggers a reconnect.
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
          // Reconnect: emit another envelope and complete so Stream.take(2) finishes.
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
      // Phase 1: advance past the watchdog threshold (3 × 1000ms = 3000ms strict).
      // The watchdog polls at 1Hz; at t=4000ms `4000 - 0 > 3000` fires WatchdogTimeout.
      yield* TestClock.adjust("4100 millis")
      // Phase 2: advance through the exponential backoff retry delay (500ms initial)
      // so the retry connects, the second Subscribe returns evt-B, and take(2) is
      // satisfied (evt-A from first attempt + evt-B from retry).
      yield* TestClock.adjust("1000 millis")
      const exit = yield* Fiber.await(fiber)

      // Two subscribe attempts: first opened at "cursor-init", reconnect
      // opened at "evt-A" (the lastDelivered as of WatchdogTimeout).
      expect(subscribeCalls.length).toBeGreaterThanOrEqual(2)
      expect(subscribeCalls[0]).toBe("cursor-init")
      expect(subscribeCalls[1]).toBe("evt-A")
      expect(exit._tag).toBe("Success")
    }).pipe(Effect.provide(EventRegistry.Live)),
  )
})

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
        QueryAfter: ({ cursor }) => {
          queryAfterCalls += 1
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
      expect(items[0]!.id).toBe("evt-000")
      expect(items[99]!.id).toBe("evt-099")
      expect(items[100]!.id).toBe("live-1")
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

describe("CloudStore — future-sentinel decode failure", () => {
  it.effect("an unknown _tag (e.g. ProgressMarker) surfaces as a decode error, not silently dropped", () =>
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

      // Result should be a Left (Stream failure) — the cursor tap
      // crashes on the missing id field, OR the filter explicitly
      // surfaces the unknown tag as an error. Acceptable: anything
      // that's NOT silent success.
      const result = yield* Stream.runCollect(
        shape.subscribe({ cursor: "earliest" }).pipe(Stream.take(1)),
      ).pipe(Effect.either)
      expect(result._tag).toBe("Left")
    }).pipe(Effect.provide(EventRegistry.Live)),
  )
})

// Helper to install a mock global fetch and return a restore function.
function installMockFetch(
  handler: (req: Request) => Promise<Response>,
): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const req =
      input instanceof Request
        ? input
        : new Request(typeof input === "string" ? input : input.toString(), init)
    return handler(req)
  }
  return () => {
    globalThis.fetch = original
  }
}

describe("CloudStore.LiveFromBrowser", () => {
  it.effect("LiveFromBrowser is a function on CloudStore namespace", () =>
    Effect.sync(() => {
      expect(typeof CloudStore.LiveFromBrowser).toBe("function")
    }),
  )

  it.effect("LiveFromBrowserOpts type is exported (static check)", () =>
    Effect.sync(() => {
      // This test only verifies the type is importable (the import above
      // must compile). At runtime we just confirm the object is a function.
      const opts: LiveFromBrowserOpts = { origin: "http://example.invalid" }
      expect(opts.origin).toBe("http://example.invalid")
      // tokenPath and heartbeat are optional
      const full: LiveFromBrowserOpts = {
        origin: "http://example.invalid",
        tokenPath: "/custom/auth",
        heartbeat: { intervalMs: 5000 },
      }
      expect(full.tokenPath).toBe("/custom/auth")
    }),
  )

  it.effect("LiveFromBrowser returns a Layer (smoke test)", () =>
    Effect.sync(() => {
      const layer = CloudStore.LiveFromBrowser({ origin: "http://example.invalid" })
      expect(layer).toBeDefined()
      expect(typeof (layer as unknown as { pipe: unknown }).pipe).toBe("function")
    }),
  )

  it.effect("Layer.build(LiveFromBrowser) requires EventRegistry", () =>
    Effect.gen(function* () {
      const restore = installMockFetch(async (req) => {
        if (req.url.endsWith("/rxweave/session-token")) {
          return new Response("rxk_browser\n", { status: 200 })
        }
        return new Response("", { status: 200 })
      })
      try {
        const base = CloudStore.LiveFromBrowser({
          origin: "http://example.invalid",
        })
        const full = Layer.provide(base, EventRegistry.Live)
        const ctx = yield* Layer.build(full)
        const store = Context.get(ctx, EventStore)
        expect(store).toBeDefined()
        expect(typeof store.append).toBe("function")
        expect(typeof store.subscribe).toBe("function")
      } finally {
        restore()
      }
    }).pipe(Effect.scoped),
  )

  it.effect("LiveFromBrowser derives token URL from ${origin}/rxweave/session-token", () =>
    // Verify that the token-endpoint URL is constructed correctly from the
    // origin. We install a mock fetch that:
    //   1. Responds to the session-token endpoint, capturing its URL.
    //   2. Responds to the RPC endpoint with a valid NDJSON Exit frame
    //      so the append call completes without hanging.
    //
    // The request ID is extracted from the NDJSON request body so the
    // Exit frame can reference it — the @effect/rpc HTTP protocol waits
    // for a matching Exit before resolving the Append effect.
    Effect.gen(function* () {
      const origin = "http://test-origin.invalid"
      const tokenUrls: Array<string> = []
      const restore = installMockFetch(async (req) => {
        if (req.url.includes("/rxweave/session-token")) {
          tokenUrls.push(req.url)
          // Match the actual `@rxweave/server` SessionToken endpoint shape:
          // `{ token: string | null }`.
          return new Response(JSON.stringify({ token: "rxk_test" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
        // RPC endpoint: parse the request body to extract the requestId,
        // then return a valid NDJSON Exit frame so the @effect/rpc client
        // resolves the pending Append without hanging.
        if (req.url.includes("/rxweave/rpc/")) {
          const text = await req.text()
          // The NDJSON body is a single Request line; extract the id field.
          const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? ""
          let requestId = "1"
          try {
            const parsed = JSON.parse(firstLine) as { id?: string }
            if (typeof parsed.id === "string") requestId = parsed.id
          } catch {
            // leave requestId as "1"
          }
          // Emit a Success Exit frame: Append returns Array<EventEnvelope>,
          // so the success value is an empty array.
          const frame = JSON.stringify({
            _tag: "Exit",
            requestId,
            exit: { _tag: "Success", value: [] },
          })
          return new Response(`${frame}\n`, {
            status: 200,
            headers: { "Content-Type": "application/ndjson" },
          })
        }
        return new Response("", { status: 200 })
      })
      try {
        const layer = CloudStore.LiveFromBrowser({ origin })
        const full = Layer.provide(layer, EventRegistry.Live)
        const ctx = yield* Layer.build(full)
        const store = Context.get(ctx, EventStore)
        // Trigger the auth path: append fires mapRequestEffect → provider()
        // → fetch(tokenUrl). The mock RPC response is a valid Exit frame
        // so the append completes successfully.
        yield* store.append([])
      } finally {
        restore()
      }
      // The token fetch must have fired with the expected URL.
      expect(tokenUrls.length).toBeGreaterThan(0)
      expect(tokenUrls[0]).toBe("http://test-origin.invalid/rxweave/session-token")
    }).pipe(Effect.scoped),
  )

  it.effect("LiveFromBrowser accepts custom tokenPath and heartbeat", () =>
    Effect.sync(() => {
      // This is a static/type-level check that custom opts compile
      const layer = CloudStore.LiveFromBrowser({
        origin: "http://example.invalid",
        tokenPath: "/custom/auth",
        heartbeat: { intervalMs: 5000 },
      })
      expect(layer).toBeDefined()
    }),
  )
})
