import { Effect } from "effect"
import { EventStore } from "@rxweave/core"
import { EventRegistry } from "@rxweave/schema"
import type { EventEnvelope, EventInput } from "@rxweave/schema"
import { AppendWireError } from "../Errors.js"

/**
 * Pure-Effect append handler shared by Cloud (convex) and `@rxweave/server`.
 *
 * Semantics match `cloud/packages/backend/convex/rxweaveRpc.ts` (the shipped
 * wire contract) — specifically:
 *   - On digest mismatch, fail with `reason: "registry-out-of-date"` and
 *     `registryOutOfDate` set to the server's **full** list of registered
 *     event types. Clients set-subtract their own types to learn what to
 *     push via `RegistryPush`. This is the existing wire contract on npm;
 *     we're constrained to match.
 *   - On any `EventStore.append` failure, map `AppendError.reason` straight
 *     through into `AppendWireError.reason`.
 */
export const appendHandler = (args: {
  readonly events: ReadonlyArray<EventInput>
  readonly registryDigest: string
}): Effect.Effect<
  ReadonlyArray<EventEnvelope>,
  AppendWireError,
  EventStore | EventRegistry
> =>
  Effect.gen(function* () {
    const registry = yield* EventRegistry
    const serverDigest = yield* registry.digest
    if (serverDigest !== args.registryDigest) {
      const rows = yield* registry.all
      return yield* Effect.fail(
        new AppendWireError({
          reason: "registry-out-of-date",
          registryOutOfDate: rows.map((r) => r.type),
        }),
      )
    }
    const store = yield* EventStore
    return yield* store
      .append(args.events)
      .pipe(
        Effect.mapError((e) => new AppendWireError({ reason: e.reason })),
      )
  })
