import { Effect } from "effect"
import { FileSystem } from "@effect/platform"

export interface Writer {
  readonly appendLines: (lines: ReadonlyArray<string>) => Effect.Effect<void, Error>
  readonly truncate: (bytes: number) => Effect.Effect<void, Error>
}

/**
 * Durable append writer for a JSONL event log.
 *
 * Each `appendLines` call opens the file in append mode, writes the batch,
 * and fsyncs via `File.sync` before releasing the handle. The Semaphore
 * serializes all writes so truncate vs append can't interleave.
 *
 * NOTE: The original plan passed `{ flag: "a", flush: true }` to
 * `fs.writeFile`, but `@effect/platform@0.96.0` `WriteFileOptions` only
 * exposes `flag` and `mode` — no `flush`/`fsync`. To get durable append
 * in this version we use `fs.open` + `file.writeAll` + `file.sync`.
 */
export const makeWriter = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const lock = yield* Effect.makeSemaphore(1)

    const appendLines: Writer["appendLines"] = (lines) =>
      lock.withPermits(1)(
        Effect.scoped(
          Effect.gen(function* () {
            const buf = new TextEncoder().encode(lines.join("\n") + "\n")
            const file = yield* fs.open(path, { flag: "a" })
            yield* file.writeAll(buf)
            yield* file.sync
          }),
        ),
      )

    const truncate: Writer["truncate"] = (bytes) =>
      lock.withPermits(1)(fs.truncate(path, bytes))

    return { appendLines, truncate } as Writer
  })
