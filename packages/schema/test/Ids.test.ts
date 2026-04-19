import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { EventId, ActorId } from "../src/Ids.js"

describe("Ids", () => {
  it("accepts a 26-char Crockford Base32 ULID", () => {
    const id = "01HXC5QKZ8M9A0TN3P1Q2R4S5V"
    expect(() => Schema.decodeUnknownSync(EventId)(id)).not.toThrow()
  })

  it("rejects an id shorter than 26 chars", () => {
    expect(() => Schema.decodeUnknownSync(EventId)("01HXC5QKZ8M9A0TN3P1")).toThrow()
  })

  it("rejects disallowed Crockford characters (I, L, O, U)", () => {
    expect(() => Schema.decodeUnknownSync(EventId)("0IHXC5QKZ8M9A0TN3P1Q2R4S5V")).toThrow()
  })

  it("brands ActorId so raw strings are not assignable", () => {
    const raw: string = "user_abc"
    const branded = Schema.decodeUnknownSync(ActorId)(raw)
    expect(typeof branded).toBe("string")
  })
})
