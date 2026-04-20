import { Effect, Schema } from "effect"
import { EventRegistry, defineEvent } from "@rxweave/schema"
import type { EventDefWire } from "@rxweave/schema"

// `@types/node` isn't in this package's tsconfig `types: []`, so declare
// the single `console` surface we actually use. Keeping it local avoids
// pulling the whole DOM/Node lib just to emit a warn line.
declare const console: { readonly warn: (...args: ReadonlyArray<unknown>) => void }

/**
 * Pure-Effect registry-push handler shared by Cloud and `@rxweave/server`.
 *
 * Accepts wire event definitions from a client and registers unknown
 * types. Spec §6 + Codex P2 require loud observability on duplicates
 * whose schemas don't match — we log at `warn` with type, local digest,
 * remote digest, and caller identity (if provided). The server's RPC
 * plumbing passes `callerActor` so the log line can attribute the
 * conflict; unknown callers are logged as `"unknown"`.
 *
 * We can't reconstruct the client's precise `Schema` at the pure-effect
 * layer (the wire carries an arbitrary AST), so unknown types are
 * registered with a permissive `Schema.Unknown`. The wire roundtrip
 * keeps the client's validation authoritative; the server's copy is
 * for the registry digest handshake, not payload validation.
 */
export const registryPushHandler = (args: {
  readonly defs: ReadonlyArray<EventDefWire>
  readonly callerActor?: string
}): Effect.Effect<{ readonly accepted: number }, never, EventRegistry> =>
  Effect.gen(function* () {
    const registry = yield* EventRegistry
    const existing = yield* registry.all
    const existingByType = new Map(existing.map((d) => [d.type, d]))
    let accepted = 0

    for (const def of args.defs) {
      const already = existingByType.get(def.type)
      if (already) {
        // Compute a deterministic local digest to compare against the
        // client's `def.digest`. We use the server's stored payload AST
        // serialization as the canonical fingerprint (matches how
        // `Registry.digest` is computed in `@rxweave/schema`).
        const localAst = JSON.stringify(
          (already.payload as unknown as { ast: unknown }).ast ?? null,
        )
        const localDigest = `v${already.version ?? 1}/${hashForLog(localAst)}`
        const remoteDigest = def.digest ?? "<none>"
        const schemasDiffer = JSON.stringify(def.payloadSchema) !== localAst
        if (schemasDiffer) {
          console.warn(
            `[registry] duplicate type=${def.type} local=${localDigest} remote=${remoteDigest} caller=${args.callerActor ?? "unknown"}`,
          )
        }
        continue
      }
      // Unknown type — register under a permissive `Schema.Unknown`.
      const synthetic = defineEvent(
        def.type,
        Schema.Unknown as unknown as Schema.Schema<unknown, unknown>,
        def.version,
      )
      yield* registry.register(synthetic as never).pipe(
        Effect.catchTag("DuplicateEventType", () => Effect.void),
      )
      accepted++
    }

    return { accepted }
  })

// 8-char deterministic digest for log-readability only; NOT crypto. The
// `Registry.digest` pipeline in `@rxweave/schema` already uses sha256
// for the authoritative digest — this short hash is purely so warn
// lines stay scannable in a terminal.
function hashForLog(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 8)
}
