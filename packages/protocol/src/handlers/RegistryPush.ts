import { Effect, Schema } from "effect"
import { EventRegistry, defineEvent, digestOne } from "@rxweave/schema"
import type { EventDefWire } from "@rxweave/schema"
import { RegistryWireError } from "../Errors.js"

declare const console: { readonly warn: (...args: ReadonlyArray<unknown>) => void }

/**
 * Pure-Effect registry-push handler shared by Cloud and `@rxweave/server`.
 *
 * Accepts wire event definitions from a client and registers unknown
 * types. Spec §6 + Codex P2 require loud observability on duplicates
 * whose schemas don't match — we log at `warn` with type, the first 8
 * chars of the canonical sha256 digest (via `digestOne`) for local
 * and remote sides, and caller identity.
 *
 * Unknown types register under `Schema.Unknown` since we can't
 * reconstruct the client's precise Schema from the wire AST. The
 * server copy exists for the digest handshake, not payload validation
 * — the client's validation is authoritative.
 *
 * Uses `registry.lookup` per-def (Map-backed O(1)) rather than caching
 * a snapshot of `registry.all`, so duplicate entries within the same
 * `defs` array can't silently both land on the miss path.
 */
export const registryPushHandler = (args: {
  readonly defs: ReadonlyArray<EventDefWire>
  readonly callerActor?: string
}): Effect.Effect<void, RegistryWireError, EventRegistry> =>
  Effect.gen(function* () {
    const registry = yield* EventRegistry

    for (const def of args.defs) {
      const already = yield* registry.lookup(def.type).pipe(
        Effect.map((d) => d as { readonly type: string; readonly version?: number; readonly payload: unknown } | null),
        Effect.catchTag("UnknownEventType", () => Effect.succeed(null)),
      )
      if (already) {
        const localFull = digestOne(already as never)
        const remoteFull = def.digest
        if (localFull !== remoteFull) {
          const caller = args.callerActor ?? "unknown"
          console.warn(
            `[registry] duplicate type=${def.type} local=${localFull.slice(0, 8)} remote=${remoteFull.slice(0, 8)} caller=${caller}`,
          )
        }
        continue
      }
      const synthetic = defineEvent(
        def.type,
        Schema.Unknown as unknown as Schema.Schema<unknown, unknown>,
        def.version,
      )
      yield* registry.register(synthetic as never).pipe(
        Effect.catchTag("DuplicateEventType", () => Effect.void),
      )
    }
  })
