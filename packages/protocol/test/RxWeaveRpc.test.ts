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
    // RxWeaveRpc.requests is a ReadonlyMap<string, Rpc>.
    // For stream RPCs, successSchema is RpcSchema.Stream<A, E>, which has a
    // .success property holding the actual per-chunk schema.
    const subscribeRpc = RxWeaveRpc.requests.get("Subscribe") as {
      successSchema: { success: Schema.Schema<unknown, unknown> }
    }
    const successSchema = subscribeRpc.successSchema.success
    const decoded = Schema.decodeUnknownSync(successSchema)({
      _tag: "Heartbeat",
      at: 1700000000000,
    })
    expect((decoded as { _tag: string })._tag).toBe("Heartbeat")
  })

  test("Subscribe.success still decodes an EventEnvelope", () => {
    const subscribeRpc = RxWeaveRpc.requests.get("Subscribe") as {
      successSchema: { success: Schema.Schema<unknown, unknown> }
    }
    const successSchema = subscribeRpc.successSchema.success
    const decoded = Schema.decodeUnknownSync(successSchema)({
      id: "01HX0000000000000000000000",
      type: "item.created",
      actor: "user:1",
      source: "canvas",
      timestamp: 1700000000000,
      payload: {},
    })
    expect((decoded as { type: string }).type).toBe("item.created")
  })
})
