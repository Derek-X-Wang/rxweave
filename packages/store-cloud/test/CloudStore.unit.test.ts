import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Context, Effect, Exit, Layer, Stream } from "effect"
import { EventStore } from "@rxweave/core"
import { EventRegistry, SystemAgentHeartbeat, defineEvent } from "@rxweave/schema"
import { Schema } from "effect"
import {
  cachedToken,
  CloudStore,
  type CloudRpcClient,
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
      expect(isRetryable({ status: 401 })).toBe(false)
      expect(isRetryable({ status: 503 })).toBe(true)
      expect(isRetryable({})).toBe(false)
      expect(isRetryable(null)).toBe(false)
      expect(isRetryable("string")).toBe(false)
    }),
  )
})
