import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { defineAgent, validateAgent } from "../src/AgentDef.js"

describe("defineAgent", () => {
  it("rejects a definition with both handle and reduce", async () => {
    const def = defineAgent({
      id: "bad",
      on: {},
      handle: () => Effect.void,
      reduce: () => ({ state: 0 }),
      initialState: 0,
    })
    const result = await Effect.runPromise(Effect.flip(validateAgent(def)))
    expect(result._tag).toBe("InvalidAgentDef")
  })

  it("rejects a definition with neither", async () => {
    const def = defineAgent({ id: "bad", on: {} } as never)
    const result = await Effect.runPromise(Effect.flip(validateAgent(def)))
    expect(result._tag).toBe("InvalidAgentDef")
  })

  it("requires initialState when reduce is present", async () => {
    const def = defineAgent({
      id: "bad",
      on: {},
      reduce: () => ({ state: 0 }),
    } as never)
    const result = await Effect.runPromise(Effect.flip(validateAgent(def)))
    expect(result._tag).toBe("InvalidAgentDef")
  })

  it("accepts a valid handle-only agent", async () => {
    const def = defineAgent({ id: "ok", on: {}, handle: () => Effect.void })
    await Effect.runPromise(validateAgent(def))
  })
})
