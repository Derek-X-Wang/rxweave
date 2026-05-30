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
 *  - Decode succeeds: append to `events`, advance `validBytes` by the line's
 *    UTF-8 byte length + 1 (the +1 accounts for the newline we split on).
 *  - Decode fails on the final line AND the file does NOT end with `\n`:
 *    torn tail. Set `truncatedBytes = raw.length - validBytes` and do NOT
 *    advance `validBytes`. FileStore will `writer.truncate(validBytes)`
 *    to chop the torn tail back to the last valid newline.
 *  - Decode fails anywhere else: interior corruption. Bump `skipped` and
 *    keep going — we still advance `validBytes` because we intentionally
 *    retain the junk line rather than rewrite the file.
 *
 * Byte-exact offsets: `validBytes` is accumulated from each complete line's
 * UTF-8 byte length (`TextEncoder().encode(line).length`) + 1, NOT its
 * `String.length` (UTF-16 code units). The two diverge for any multi-byte
 * UTF-8 (CJK, emoji, …). A char-based count would seed FileStore's tail
 * `readBytes` LOWER than the true byte offset and mid-codepoint, causing the
 * first tail poll to over-count `consumed` and silently drop the next appended
 * event. It would also make `writer.truncate(validBytes)` chop at the wrong
 * byte for a torn multi-byte tail. Re-encoding a *complete* line is lossless
 * (the split point — the `\n` byte — is always a codepoint boundary), so this
 * exactly equals the raw byte offset of the end of the last valid line.
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

    const encoder = new TextEncoder()
    const events: Array<EventEnvelope> = []
    let skipped = 0
    let validBytes = 0
    let truncatedBytes = 0

    for (let i = 0; i < lines.length; i++) {
      const isLast = i === lines.length - 1
      const line = lines[i]!
      // Byte-exact: the raw byte length of this complete line + 1 for the '\n'
      // we split on. Equals the true file byte offset advance for this line.
      const lineByteLen = encoder.encode(line).length
      const attempt = yield* Effect.either(decode(line))
      if (attempt._tag === "Right") {
        events.push(attempt.right)
        validBytes += lineByteLen + 1
      } else if (isLast && !endsWithNewline) {
        truncatedBytes = raw.length - validBytes
      } else {
        skipped += 1
        validBytes += lineByteLen + 1
      }
    }

    return {
      events,
      skipped,
      truncatedBytes,
      validBytes,
    } satisfies RecoveryResult
  })
