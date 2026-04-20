import { Effect } from "effect"
import { EventRegistry } from "@rxweave/schema"

/**
 * Pure-Effect registry-diff handler shared by Cloud and `@rxweave/server`.
 *
 * Returns the server's digest + the symmetric difference between the
 * client's known types and the server's — the client uses
 * `missingOnServer` to decide what to `RegistryPush` next.
 *
 * The Convex-backed handler in `cloud/packages/backend/convex/rxweaveRpc.ts`
 * returns a richer `{ upToDate, missingOnClient: ReadonlyArray<EventDefWire>,
 * missingOnServer }` wire shape because Convex doesn't see the client's
 * type list (only the digest). At the pure-effect layer we DO accept the
 * client's `clientTypes`, so we return the cheaper `ReadonlyArray<string>`
 * symmetric-diff — callers that need the wire shape can build it from
 * `registry.all + missingOnClient` themselves.
 */
export const registrySyncDiffHandler = (args: {
  readonly clientDigest: string
  readonly clientTypes: ReadonlyArray<string>
}): Effect.Effect<
  {
    readonly serverDigest: string
    readonly missingOnClient: ReadonlyArray<string>
    readonly missingOnServer: ReadonlyArray<string>
  },
  never,
  EventRegistry
> =>
  Effect.gen(function* () {
    const registry = yield* EventRegistry
    const serverDigest = yield* registry.digest
    const all = yield* registry.all
    const serverTypes = all.map((d) => d.type)
    const clientSet = new Set(args.clientTypes)
    const serverSet = new Set(serverTypes)
    return {
      serverDigest,
      missingOnClient: serverTypes.filter((t) => !clientSet.has(t)),
      missingOnServer: args.clientTypes.filter((t) => !serverSet.has(t)),
    }
  })
