import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { Cursor } from "../src/Cursor.js"
import { Filter } from "../src/Filter.js"

describe("Cursor", () => {
  it("accepts 'earliest' and 'latest' literals", () => {
    expect(() => Schema.decodeUnknownSync(Cursor)("earliest")).not.toThrow()
    expect(() => Schema.decodeUnknownSync(Cursor)("latest")).not.toThrow()
  })

  it("accepts a valid EventId", () => {
    const id = "01HXC5QKZ8M9A0TN3P1Q2R4S5V"
    expect(() => Schema.decodeUnknownSync(Cursor)(id)).not.toThrow()
  })

  it("rejects a bad string", () => {
    expect(() => Schema.decodeUnknownSync(Cursor)("nope")).toThrow()
  })
})

describe("Filter", () => {
  it("accepts an empty filter", () => {
    expect(Schema.decodeUnknownSync(Filter)({})).toEqual({})
  })

  it("accepts types, actors, sources, since", () => {
    const decoded = Schema.decodeUnknownSync(Filter)({
      types: ["canvas.*"],
      actors: ["user_1"],
      sources: ["cli", "agent"],
      since: 1,
    })
    expect(decoded.types).toEqual(["canvas.*"])
  })

  it("rejects unknown sources", () => {
    expect(() =>
      Schema.decodeUnknownSync(Filter)({ sources: ["bogus"] }),
    ).toThrow()
  })
})
