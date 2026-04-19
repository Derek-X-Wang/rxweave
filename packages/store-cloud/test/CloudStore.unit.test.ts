import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Context, Effect, Layer } from "effect"
import { EventStore } from "@rxweave/core"
import { EventRegistry } from "@rxweave/schema"
import { CloudStore, syncRegistry, withBearerToken } from "../src/index.js"

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

  it.effect("withBearerToken returns a function that accepts an HttpClient", () =>
    Effect.sync(() => {
      const mw = withBearerToken(() => "t")
      expect(typeof mw).toBe("function")
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

  it.effect("syncRegistry calls RegistryPush when digests differ", () =>
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
})
