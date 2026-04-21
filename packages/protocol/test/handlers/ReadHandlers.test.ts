import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { EventStore } from "@rxweave/core"
import { MemoryStore } from "@rxweave/store-memory"
import { getByIdHandler } from "../../src/handlers/GetById.js"
import { queryHandler } from "../../src/handlers/Query.js"
import { queryAfterHandler } from "../../src/handlers/QueryAfter.js"

describe("read handlers", () => {
  it.effect("getByIdHandler returns the event by id", () =>
    Effect.gen(function* () {
      const store = yield* EventStore
      const appended = yield* store.append([
        { type: "demo.ping", actor: "tester", source: "cli", payload: {} },
      ])
      const got = yield* getByIdHandler({ id: appended[0]!.id })
      expect(got.id).toBe(appended[0]!.id)
    }).pipe(Effect.provide(MemoryStore.Live)),
  )

  it.effect("queryHandler filters and limits", () =>
    Effect.gen(function* () {
      const store = yield* EventStore
      yield* store.append([
        { type: "demo.a", actor: "tester", source: "cli", payload: {} },
        { type: "demo.b", actor: "tester", source: "cli", payload: {} },
      ])
      const result = yield* queryHandler({ filter: { types: ["demo.a"] }, limit: 10 })
      expect(result.length).toBe(1)
      expect(result[0]!.type).toBe("demo.a")
    }).pipe(Effect.provide(MemoryStore.Live)),
  )

  it.effect("queryAfterHandler paginates after a cursor", () =>
    Effect.gen(function* () {
      const store = yield* EventStore
      const appended = yield* store.append([
        { type: "demo.ping", actor: "tester", source: "cli", payload: { n: 1 } },
        { type: "demo.ping", actor: "tester", source: "cli", payload: { n: 2 } },
      ])
      const result = yield* queryAfterHandler({
        cursor: appended[0]!.id,
        filter: { types: ["demo.ping"] },
        limit: 10,
      })
      expect(result.length).toBe(1)
      expect((result[0]!.payload as { n: number }).n).toBe(2)
    }).pipe(Effect.provide(MemoryStore.Live)),
  )
})
