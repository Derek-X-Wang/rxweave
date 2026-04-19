import { describe, it } from "vitest"
import { Effect, Layer } from "effect"
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

  // `/rxweave/rpc` and the reset endpoint share a base — derive the
  // reset URL by stripping the `/rxweave/rpc` suffix (handles both with
  // and without a trailing slash).
  const resetUrl =
    capturedUrl.replace(/\/rxweave\/rpc\/?$/, "") + "/rxweave/test/reset"

  // Drain the tenant between cases. `wipeTenantEvents` on the server
  // deletes up to 1000 rows per call and returns `hasMore`; we loop
  // until drained with a sanity cap so a bug in the server-side
  // pagination can't spin forever. 100 × 1000 = 100k rows, well beyond
  // anything the suite can pollute a tenant with.
  const resetBetweenTests = Effect.gen(function* () {
    for (let i = 0; i < 100; i++) {
      const res = yield* Effect.promise(() =>
        fetch(resetUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${capturedToken}` },
        }),
      )
      const body = (yield* Effect.promise(() => res.json())) as {
        readonly deleted: number
        readonly hasMore: boolean
      }
      if (!body.hasMore) break
    }
  })

  runConformance({
    name: "CloudStore (integration)",
    layer: make(),
    fresh: make,
    resetBetweenTests,
    // Remote Convex: 2000 HTTP appends exceed 15s. 200 still exercises
    // the slow-subscriber-under-flood invariants (subscriber processed
    // > 0, store accepts writes after flood) within ~10s of network I/O.
    floodSize: 200,
    // Subscribe polls at ~1s; a 200ms post-flood wait lands between polls
    // so the subscriber sees zero events. 3000ms guarantees at least one
    // poll cycle fires after the flood completes.
    floodWaitMs: 3000,
  })
} else {
  describe("CloudStore integration (set RXWEAVE_CLOUD_URL + RXWEAVE_TOKEN)", () => {
    it.skip("skipped — env vars not set", () => undefined)
  })
}
