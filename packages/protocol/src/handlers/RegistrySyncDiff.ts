import { Effect } from "effect"
import { EventRegistry } from "@rxweave/schema"
import type { EventDefWire } from "@rxweave/schema"
import { RegistryWireError } from "../Errors.js"

/**
 * Pure-Effect registry-diff handler shared by Cloud and `@rxweave/server`.
 *
 * Wire shape matches `RxWeaveRpc.RegistrySyncDiff` at
 * `packages/protocol/src/RxWeaveRpc.ts`: payload is just the client's
 * digest; success is `{ upToDate, missingOnClient: EventDefWire[],
 * missingOnServer: string[] }`. `missingOnServer` stays empty here
 * because the server can't know what types the client has without
 * being told — the client inspects `missingOnClient` and pushes what
 * it needs via `RegistryPush`.
 *
 * Short-circuits on digest match — steady-state reconnects skip all
 * allocation.
 */
export const registrySyncDiffHandler = (args: {
  readonly clientDigest: string
}): Effect.Effect<
  {
    readonly upToDate: boolean
    readonly missingOnClient: ReadonlyArray<EventDefWire>
    readonly missingOnServer: ReadonlyArray<string>
  },
  RegistryWireError,
  EventRegistry
> =>
  Effect.gen(function* () {
    const registry = yield* EventRegistry
    const serverDigest = yield* registry.digest
    if (serverDigest === args.clientDigest) {
      return { upToDate: true, missingOnClient: [], missingOnServer: [] }
    }
    const wire = yield* registry.wire
    return { upToDate: false, missingOnClient: wire, missingOnServer: [] }
  })
