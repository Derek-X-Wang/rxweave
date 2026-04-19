import { Context, Effect, Layer, Ref, Schema } from "effect"
import { FileSystem } from "@effect/platform"
import { Cursor } from "@rxweave/schema"

export interface AgentCursorShape {
  readonly get: (agentId: string) => Effect.Effect<Cursor>
  readonly set: (agentId: string, cursor: Cursor) => Effect.Effect<void>
  readonly list: Effect.Effect<
    ReadonlyArray<{ readonly agentId: string; readonly cursor: Cursor }>
  >
}

const CursorMap = Schema.Record({ key: Schema.String, value: Cursor })
const decodeCursorMap = Schema.decodeUnknownSync(Schema.parseJson(CursorMap))
const encodeCursorMap = Schema.encodeSync(Schema.parseJson(CursorMap))

/**
 * Tracks per-agent resume cursors.
 *
 * `Memory` keeps state in a `Ref` and is ephemeral — a Scope ending (or a
 * process exit) forgets everything. Useful for tests and for short-lived
 * one-shot agent invocations.
 *
 * `File` persists the whole map as JSON on each `set()`. We use
 * `open({flag:"w"}) + writeAll + sync` (same fsync pattern as
 * `@rxweave/store-file`'s Writer) so that a cursor surfaced to the caller
 * has definitely survived to stable storage before we return — this is
 * the invariant the CLI relies on to not re-replay on restart.
 *
 * Unknown agents default to `"latest"` so a fresh agent skips existing
 * backlog; a caller who wants replay-from-earliest must set it explicitly.
 */
export class AgentCursorStore extends Context.Tag("rxweave/AgentCursorStore")<
  AgentCursorStore,
  AgentCursorShape
>() {
  static Memory = Layer.effect(
    AgentCursorStore,
    Effect.gen(function* () {
      const ref = yield* Ref.make<Record<string, Cursor>>({})
      return {
        get: (id) =>
          Ref.get(ref).pipe(Effect.map((r): Cursor => r[id] ?? "latest")),
        set: (id, cursor) => Ref.update(ref, (r) => ({ ...r, [id]: cursor })),
        list: Ref.get(ref).pipe(
          Effect.map((r) =>
            Object.entries(r).map(([agentId, cursor]) => ({ agentId, cursor })),
          ),
        ),
      }
    }),
  )

  static File = (opts: { readonly path: string }) =>
    Layer.scoped(
      AgentCursorStore,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const lock = yield* Effect.makeSemaphore(1)
        const exists = yield* fs.exists(opts.path)
        let initial: Record<string, Cursor> = {}
        if (exists) {
          const text = new TextDecoder().decode(yield* fs.readFile(opts.path))
          if (text.length > 0) {
            initial = decodeCursorMap(text) as Record<string, Cursor>
          }
        }
        const ref = yield* Ref.make(initial)

        // Persist failures (disk full, permission flip, etc.) are unrecoverable
        // for the cursor contract: if we can't fsync the new cursor, the caller
        // MUST NOT observe a successful `set` (otherwise they'd skip events on
        // restart). We turn them into defects so they surface as FiberFailure
        // rather than polluting the domain error channel — callers who want to
        // catch and recover can wrap with Effect.catchAllDefect.
        const persist = lock.withPermits(1)(
          Effect.scoped(
            Effect.gen(function* () {
              const map = yield* Ref.get(ref)
              const buf = new TextEncoder().encode(encodeCursorMap(map))
              const file = yield* fs.open(opts.path, { flag: "w" })
              yield* file.writeAll(buf)
              yield* file.sync
            }),
          ).pipe(Effect.orDie),
        )

        return {
          get: (id) =>
            Ref.get(ref).pipe(Effect.map((r): Cursor => r[id] ?? "latest")),
          set: (id, cursor) =>
            Ref.update(ref, (r) => ({ ...r, [id]: cursor })).pipe(
              Effect.zipRight(persist),
            ),
          list: Ref.get(ref).pipe(
            Effect.map((r) =>
              Object.entries(r).map(([agentId, cursor]) => ({
                agentId,
                cursor,
              })),
            ),
          ),
        }
      }),
    )
}
