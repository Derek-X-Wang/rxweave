import { describe, expect, it } from "vitest"
import { EventStore } from "../src/index.js"

describe("EventStore tag", () => {
  it("is importable", () => {
    expect(typeof EventStore).toBe("function")
  })
})
