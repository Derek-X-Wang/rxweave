import { describe, expect, test } from "vitest"
import { isRetryable } from "../src/Retry.js"
import { WatchdogTimeout } from "../src/Errors.js"

describe("isRetryable", () => {
  test("WatchdogTimeout is retryable", () => {
    const err = new WatchdogTimeout({ idleMs: 45_000 })
    expect(isRetryable(err)).toBe(true)
  })
})
