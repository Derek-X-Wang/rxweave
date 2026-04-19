import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { EventEnvelope, EventInput } from "../src/Envelope.js"

describe("EventEnvelope", () => {
  const valid = {
    id: "01HXC5QKZ8M9A0TN3P1Q2R4S5V",
    type: "canvas.node.created",
    actor: "user_1",
    source: "cli",
    timestamp: 1,
    payload: { name: "n" },
  }

  it("round-trips a minimal envelope", () => {
    const decoded = Schema.decodeUnknownSync(EventEnvelope)(valid)
    expect(decoded.type).toBe("canvas.node.created")
  })

  it("carries optional causedBy", () => {
    const decoded = Schema.decodeUnknownSync(EventEnvelope)({
      ...valid,
      causedBy: ["01HXC5QKZ8M9A0TN3P1Q2R4S5V"],
    })
    expect(decoded.causedBy?.length).toBe(1)
  })
})

describe("EventInput", () => {
  it("accepts a minimal emit with only type + payload", () => {
    const decoded = Schema.decodeUnknownSync(EventInput)({
      type: "canvas.node.created",
      payload: {},
    })
    expect(decoded.type).toBe("canvas.node.created")
  })
})
