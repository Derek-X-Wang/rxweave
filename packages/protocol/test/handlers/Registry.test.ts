import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { EventRegistry, defineEvent } from "@rxweave/schema"
import { registrySyncDiffHandler } from "../../src/handlers/RegistrySyncDiff.js"
import { registryPushHandler } from "../../src/handlers/RegistryPush.js"

describe("registry handlers", () => {
  it.effect("registrySyncDiffHandler returns server digest + diff sets", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      const Ping = defineEvent("demo.ping", Schema.Struct({ n: Schema.Number }))
      yield* reg.register(Ping as never)
      const result = yield* registrySyncDiffHandler({
        clientDigest: "stale-digest",
        clientTypes: ["demo.other"],
      })
      expect(typeof result.serverDigest).toBe("string")
      expect(result.missingOnClient).toContain("demo.ping")
      expect(result.missingOnServer).toContain("demo.other")
    }).pipe(Effect.provide(EventRegistry.Live)),
  )

  it.effect("registryPushHandler registers new types", () =>
    Effect.gen(function* () {
      const reg = yield* EventRegistry
      const result = yield* registryPushHandler({
        defs: [{ type: "demo.newthing", version: 1, payloadSchema: {}, digest: "x" }],
      })
      expect(result.accepted).toBeGreaterThanOrEqual(1)
      const all = yield* reg.all
      expect(all.some((d) => d.type === "demo.newthing")).toBe(true)
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
          // different "schema" (different placeholder) on same type
          { type: "demo.ping", version: 1, payloadSchema: { different: true }, digest: "remote-x" },
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
