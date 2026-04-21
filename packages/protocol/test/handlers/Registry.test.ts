import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { EventRegistry, defineEvent, digestOne } from "@rxweave/schema"
import { registrySyncDiffHandler } from "../../src/handlers/RegistrySyncDiff.js"
import { registryPushHandler } from "../../src/handlers/RegistryPush.js"

describe("registrySyncDiffHandler", () => {
  it.effect("short-circuits to upToDate when digests match", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      const Ping = defineEvent("demo.ping", Schema.Struct({ n: Schema.Number }))
      yield* reg.register(Ping as never)
      const digest = yield* reg.digest
      const result = yield* registrySyncDiffHandler({ clientDigest: digest })
      expect(result.upToDate).toBe(true)
      expect(result.missingOnClient.length).toBe(0)
      expect(result.missingOnServer.length).toBe(0)
    }).pipe(Effect.provide(EventRegistry.Live)),
  )

  it.effect("returns wire EventDefWire list on digest mismatch", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      const Ping = defineEvent("demo.ping", Schema.Struct({ n: Schema.Number }))
      yield* reg.register(Ping as never)
      const result = yield* registrySyncDiffHandler({ clientDigest: "stale" })
      expect(result.upToDate).toBe(false)
      expect(result.missingOnClient.length).toBe(1)
      expect(result.missingOnClient[0]!.type).toBe("demo.ping")
      expect(typeof result.missingOnClient[0]!.digest).toBe("string")
      // missingOnServer stays empty — server doesn't know what client has.
      expect(result.missingOnServer.length).toBe(0)
    }).pipe(Effect.provide(EventRegistry.Live)),
  )
})

describe("registryPushHandler", () => {
  it.effect("registers new types (void return)", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      yield* registryPushHandler({
        defs: [
          { type: "demo.newthing", version: 1, payloadSchema: null, digest: "x" },
        ],
      })
      const all = yield* reg.all
      expect(all.some((d) => d.type === "demo.newthing")).toBe(true)
    }).pipe(Effect.provide(EventRegistry.Live)),
  )

  it.effect(
    "is silent when a duplicate def matches the local digest",
    () =>
      Effect.gen(function* () {
        const reg = yield* EventRegistry
        const Ping = defineEvent("demo.ping", Schema.Struct({ n: Schema.Number }))
        yield* reg.register(Ping as never)
        const localDigest = digestOne(Ping as never)
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
        try {
          yield* registryPushHandler({
            defs: [
              {
                type: "demo.ping",
                version: 1,
                payloadSchema: (Ping.payload as unknown as { ast: unknown }).ast,
                digest: localDigest,
              },
            ],
          })
          expect(warnSpy).not.toHaveBeenCalled()
        } finally {
          warnSpy.mockRestore()
        }
      }).pipe(Effect.provide(EventRegistry.Live)),
  )
})

describe("registryPushHandler observability", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it.effect("logs at warn on duplicate type with differing schemas", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      const Ping = defineEvent("demo.ping", Schema.Struct({ n: Schema.Number }))
      yield* reg.register(Ping as never)
      yield* registryPushHandler({
        defs: [
          {
            type: "demo.ping",
            version: 1,
            payloadSchema: { different: true },
            digest: "remote-different-digest",
          },
        ],
        callerActor: "test-client",
      })
      expect(warnSpy).toHaveBeenCalledOnce()
      const call = warnSpy.mock.calls[0]!.join(" ")
      expect(call).toContain("[registry] duplicate")
      expect(call).toContain("type=demo.ping")
      expect(call).toContain("caller=test-client")
    }).pipe(Effect.provide(EventRegistry.Live)),
  )
})
