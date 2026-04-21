import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { generateAndPersistToken, generateToken, verifyToken } from "../src/Auth.js"

/**
 * Pure unit tests for the Auth primitives. These run on `bun:test`
 * (not vitest) to stay consistent with Server.test.ts — the server
 * package's runner is `bun test`. No HTTP sockets are opened here;
 * see AuthIntegration.test.ts for the round-trip middleware tests.
 */
describe("Auth", () => {
  it("generateToken returns rxk_<hex> of expected length", () => {
    const token = generateToken()
    // 256 bits of entropy -> 64 hex chars, prefixed with rxk_
    // so it's spottable in shell history, logs, and .npmrc files.
    expect(token).toMatch(/^rxk_[0-9a-f]{64}$/)
  })

  it("generateToken values are not predictable", () => {
    // Sanity: two calls must not collide. randomBytes(32) failure mode
    // would be catastrophic, but a smoke check guards against someone
    // accidentally swapping in Math.random() during a refactor.
    const a = generateToken()
    const b = generateToken()
    expect(a).not.toBe(b)
  })

  it("generateAndPersistToken writes token with 0600 mode on POSIX", async () => {
    const tmp = join(tmpdir(), `rxweave-auth-test-${Date.now()}-${Math.random()}`)
    try {
      const token = await Effect.runPromise(generateAndPersistToken({ tokenFile: tmp }))
      expect(existsSync(tmp)).toBe(true)
      expect(readFileSync(tmp, "utf8").trim()).toBe(token)
      if (process.platform !== "win32") {
        // POSIX: must match spec §5.4's 0600 requirement.
        expect((statSync(tmp).mode & 0o777).toString(8)).toBe("600")
      }
    } finally {
      if (existsSync(tmp)) rmSync(tmp)
    }
  })

  describe("verifyToken", () => {
    it("accepts matching tokens (constant-time)", () => {
      expect(verifyToken({ expected: ["abc"], provided: "abc" })).toBe(true)
    })
    it("rejects mismatched tokens", () => {
      expect(verifyToken({ expected: ["abc"], provided: "xyz" })).toBe(false)
      expect(verifyToken({ expected: ["abc"], provided: "abcd" })).toBe(false)
      expect(verifyToken({ expected: ["abc"], provided: "" })).toBe(false)
    })
    it("no-auth mode (empty expected list) accepts anything", () => {
      expect(verifyToken({ expected: [], provided: "any" })).toBe(true)
      expect(verifyToken({ expected: [], provided: "" })).toBe(true)
    })
    it("accepts any of several expected tokens", () => {
      expect(verifyToken({ expected: ["a", "b", "c"], provided: "b" })).toBe(true)
    })
  })
})
