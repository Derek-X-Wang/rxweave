import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { parseRoomHash, resolveRoomConfig } from "../src/roomToken.js"

// Unit tests for the URL-hash room-token resolution logic.
//
// These tests confirm the three key behavioral properties:
//   1. `#room=<token>` takes precedence over the env token.
//   2. A missing/empty hash falls back to VITE_RXWEAVE_TOKEN.
//   3. Malformed hashes (no `room=` key, empty value) are ignored.
//
// The token is intentionally never persisted — the helpers only
// return in-memory values. There is no localStorage interaction here.

describe("parseRoomHash", () => {
  it.effect("returns undefined for empty hash", () =>
    Effect.sync(() => {
      expect(parseRoomHash("")).toBeUndefined()
      expect(parseRoomHash("#")).toBeUndefined()
    }),
  )

  it.effect("parses a valid #room=<token> hash", () =>
    Effect.sync(() => {
      const token = parseRoomHash("#room=rxk_abc123")
      expect(token).toBe("rxk_abc123")
    }),
  )

  it.effect("returns undefined when room key is present but value is empty", () =>
    Effect.sync(() => {
      expect(parseRoomHash("#room=")).toBeUndefined()
      expect(parseRoomHash("#room=   ")).toBeUndefined()
    }),
  )

  it.effect("returns undefined when hash has no room key", () =>
    Effect.sync(() => {
      expect(parseRoomHash("#other=value")).toBeUndefined()
      expect(parseRoomHash("#foo=bar&baz=qux")).toBeUndefined()
    }),
  )

  it.effect("handles hash with extra params alongside room", () =>
    Effect.sync(() => {
      const token = parseRoomHash("#room=tok123&debug=1")
      expect(token).toBe("tok123")
    }),
  )

  it.effect("handles hash without leading #", () =>
    Effect.sync(() => {
      // Some implementations strip the # before passing; be tolerant.
      const token = parseRoomHash("room=rxk_nohash")
      expect(token).toBe("rxk_nohash")
    }),
  )
})

describe("resolveRoomConfig — hash > env precedence", () => {
  it.effect("hash token wins over env token", () =>
    Effect.sync(() => {
      const config = resolveRoomConfig(
        "#room=hash-token",
        "env-token",
        "http://rxweave.example.com",
        "http://localhost:5173",
      )
      expect(config.token).toBe("hash-token")
      expect(config.fromHash).toBe(true)
    }),
  )

  it.effect("falls back to env token when no hash", () =>
    Effect.sync(() => {
      const config = resolveRoomConfig(
        "",
        "env-token",
        "http://rxweave.example.com",
        "http://localhost:5173",
      )
      expect(config.token).toBe("env-token")
      expect(config.fromHash).toBe(false)
    }),
  )

  it.effect("returns undefined token when neither hash nor env token present", () =>
    Effect.sync(() => {
      const config = resolveRoomConfig("", undefined, undefined, "http://localhost:5173")
      expect(config.token).toBeUndefined()
      expect(config.fromHash).toBe(false)
    }),
  )

  it.effect("malformed hash (no room key) falls back to env token", () =>
    Effect.sync(() => {
      const config = resolveRoomConfig(
        "#other=value",
        "env-fallback",
        undefined,
        "http://localhost:5173",
      )
      expect(config.token).toBe("env-fallback")
      expect(config.fromHash).toBe(false)
    }),
  )

  it.effect("malformed hash (empty room value) falls back to env token", () =>
    Effect.sync(() => {
      const config = resolveRoomConfig(
        "#room=",
        "env-fallback",
        undefined,
        "http://localhost:5173",
      )
      expect(config.token).toBe("env-fallback")
      expect(config.fromHash).toBe(false)
    }),
  )

  it.effect("uses VITE_RXWEAVE_ORIGIN when provided", () =>
    Effect.sync(() => {
      const config = resolveRoomConfig(
        "#room=tok",
        undefined,
        "https://custom.rxweave.io",
        "http://localhost:5173",
      )
      expect(config.origin).toBe("https://custom.rxweave.io")
    }),
  )

  it.effect("falls back to windowOrigin when VITE_RXWEAVE_ORIGIN not set", () =>
    Effect.sync(() => {
      const config = resolveRoomConfig(
        "",
        undefined,
        undefined,
        "http://localhost:5173",
      )
      expect(config.origin).toBe("http://localhost:5173")
    }),
  )

  it.effect("empty env token string treated as absent (returns undefined)", () =>
    Effect.sync(() => {
      const config = resolveRoomConfig("", "", undefined, "http://localhost:5173")
      expect(config.token).toBeUndefined()
    }),
  )
})
