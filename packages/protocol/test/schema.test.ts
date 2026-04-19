import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { Filter, Cursor } from "@rxweave/schema"

describe("protocol wire payloads", () => {
  it("encodes Cursor.earliest", () => {
    const encoded = Schema.encodeSync(Cursor)("earliest")
    expect(encoded).toBe("earliest")
  })

  it("round-trips a Filter with type globs", () => {
    const input = { types: ["canvas.*"] }
    const decoded = Schema.decodeUnknownSync(Filter)(input)
    expect(decoded.types).toEqual(["canvas.*"])
  })
})
