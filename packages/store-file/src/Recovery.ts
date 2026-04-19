import { Effect, Schema } from "effect"
import { FileSystem } from "@effect/platform"
import { EventEnvelope } from "@rxweave/schema"

export interface RecoveryResult {
  readonly events: ReadonlyArray<EventEnvelope>
  readonly skipped: number
  readonly truncatedBytes: number
  readonly validBytes: number
}

const decode = Schema.decodeUnknown(Schema.parseJson(EventEnvelope))

/**
 * Cold-start scan + recovery for a JSONL event log.
 *
 * Reads the file as UTF-8 text and splits by `"\n"`. For each line we try
 * to decode it as an EventEnvelope. Three outcomes per line:
 *
 *  - Decode succeeds: append to `events`, advance `validBytes` by
 *    `line.length + 1` (the +1 accounts for the newline we split on).
 *  - Decode fails on the final line AND the file does NOT end with `\n`:
 *    torn tail. Set `truncatedBytes = raw.length - validBytes` and do NOT
 *    advance `validBytes`. FileStore will `writer.truncate(validBytes)`
 *    to chop the torn tail back to the last valid newline.
 *  - Decode fails anywhere else: interior corruption. Bump `skipped` and
 *    keep going — we still advance `validBytes` because we intentionally
 *    retain the junk line rather than rewrite the file.
 *
 * v0.1 simplification: `raw.length` (bytes) vs `line.length + 1` (chars)
 * diverge for multi-byte UTF-8. For pure ASCII (the canonical kiosk
 * event log) they're identical. If non-ASCII content becomes common,
 * revisit to track byte offsets while splitting.
 * TODO(v0.2): byte-accurate scanner for multi-byte UTF-8.
 */
export const scanAndRecover = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const raw = yield* fs.readFile(path)
    const text = new TextDecoder().decode(raw)
    if (text.length === 0) {
      return {
        events: [],
        skipped: 0,
        truncatedBytes: 0,
        validBytes: 0,
      } satisfies RecoveryResult
    }

    const endsWithNewline = text.endsWith("\n")
    const lines = text.split("\n")
    if (endsWithNewline) lines.pop()

    const events: Array<EventEnvelope> = []
    let skipped = 0
    let validBytes = 0
    let truncatedBytes = 0

    for (let i = 0; i < lines.length; i++) {
      const isLast = i === lines.length - 1
      const line = lines[i]!
      const attempt = yield* Effect.either(decode(line))
      if (attempt._tag === "Right") {
        events.push(attempt.right)
        validBytes += line.length + 1
      } else if (isLast && !endsWithNewline) {
        truncatedBytes = raw.length - validBytes
      } else {
        skipped += 1
        validBytes += line.length + 1
      }
    }

    return {
      events,
      skipped,
      truncatedBytes,
      validBytes,
    } satisfies RecoveryResult
  })
