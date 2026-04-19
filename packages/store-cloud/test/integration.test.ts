import { describe, it } from "vitest"
import { Layer } from "effect"
import { EventRegistry } from "@rxweave/schema"
import { runConformance } from "@rxweave/core/testing"
import { CloudStore } from "../src/index.js"

/**
 * Integration conformance suite — opt-in.
 *
 * Runs the shared `@rxweave/core/testing` conformance harness against a
 * live cloud deployment. Activation is strictly by env var so this file
 * stays a no-op in CI / local dev unless explicitly pointed at a target.
 *
 * Required env:
 *   RXWEAVE_CLOUD_URL  — full RPC endpoint URL, e.g. https://api.example.com/rxweave/rpc
 *   RXWEAVE_TOKEN      — bearer token with append+subscribe scopes for a test tenant
 *
 * Each conformance case gets a fresh layer from `fresh` — for cloud that's
 * the same layer (idempotent creation). Because the cases seed their own
 * events, hitting a shared deployment is OK, but the test tenant should
 * be one you're willing to pollute with `canvas.node.created` etc.
 */

const url = process.env.RXWEAVE_CLOUD_URL
const token = process.env.RXWEAVE_TOKEN

if (url && token) {
  const capturedUrl = url
  const capturedToken = token
  const make = () =>
    CloudStore.Live({ url: capturedUrl, token: () => capturedToken }).pipe(
      Layer.provide(EventRegistry.Live),
    )
  runConformance({ name: "CloudStore (integration)", layer: make(), fresh: make })
} else {
  describe("CloudStore integration (set RXWEAVE_CLOUD_URL + RXWEAVE_TOKEN)", () => {
    it.skip("skipped — env vars not set", () => undefined)
  })
}
