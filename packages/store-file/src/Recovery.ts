import { Effect, Schema } from "effect"
import { FileSystem } from "@effect/platform"
import { EventEnvelope } from "@rxweave/schema"

export interface RecoveryResult {
  readonly events: ReadonlyArray<EventEnvelope>
  readonly skipped: number
  readonly truncatedBytes: number
  readonly validBytes: number
}

export interface ScanResult {
  readonly events: ReadonlyArray<EventEnvelope>
  /** Complete lines that failed to decode (interior corruption — retained). */
  readonly skipped: number
  /**
   * Raw byte length of all COMPLETE (newline-terminated) lines, including each
   * trailing `\n`. A partial trailing line (no final `\n`) is NOT counted —
   * its bytes are left for the caller to handle.
   */
  readonly consumed: number
}

const decodeLine = Schema.decodeUnknown(Schema.parseJson(EventEnvelope))

/**
 * The single byte-exact JSONL line scanner, shared by cold-start recovery and
 * FileStore's live file-tail fiber so the byte-offset invariant lives in ONE
 * place.
 *
 * Splits the raw `bytes` on the `0x0A` (`\n`) byte and decodes each COMPLETE
 * line as an EventEnvelope. `consumed` counts the RAW bytes of complete lines
 * (+1 per `\n`) — it is never derived by re-encoding a decoded string, so it
 * can never overshoot `bytes.length` even if `bytes` happens to start
 * mid-codepoint. (A char-based or re-encoded count would seed/advance the tail
 * offset past the true file end and silently drop the next appended event.)
 * Splitting on `0x0A` is safe for UTF-8: `0x0A` never appears as a continuation
 * or lead byte of a multi-byte sequence. A partial trailing line (writer
 * mid-write, or a torn tail) is left unconsumed.
 */
export const scanLines = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    const decoder = new TextDecoder()
    const events: Array<EventEnvelope> = []
    let skipped = 0
    let consumed = 0
    let lineStart = 0
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== 0x0a) continue
      const lineBytes = bytes.subarray(lineStart, i)
      const attempt = yield* Effect.either(decodeLine(decoder.decode(lineBytes)))
      if (attempt._tag === "Right") events.push(attempt.right)
      else skipped += 1
      // Always advance past complete lines (valid or corrupt) so corrupt lines
      // don't block future reads. Byte-exact: raw segment length + 1 for the `\n`.
      consumed += lineBytes.length + 1
      lineStart = i + 1
    }
    return { events, skipped, consumed } satisfies ScanResult
  })

/**
 * Cold-start scan + recovery for a JSONL event log.
 *
 * Scans complete lines via the shared {@link scanLines}, then handles the
 * trailing bytes after the last `\n` (an unterminated final line). Because cold
 * start reads a STATIC file (no concurrent writer), we can try to decode that
 * trailing line:
 *
 *  - It decodes: a valid event whose trailing newline never flushed — keep it,
 *    and `validBytes` covers the whole file (nothing to truncate).
 *  - It does not decode: a torn tail — set `truncatedBytes = raw.length -
 *    validBytes`; FileStore `writer.truncate(validBytes)` chops it back to the
 *    last valid newline.
 *
 * (FileStore's live tail fiber, by contrast, uses {@link scanLines} bare: on a
 * file being actively written, a partial trailing line must wait for its
 * newline rather than be decoded.)
 */
export const scanAndRecover = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const raw = yield* fs.readFile(path)
    const scan = yield* scanLines(raw)

    const events: Array<EventEnvelope> = [...scan.events]
    let validBytes = scan.consumed
    let truncatedBytes = 0

    if (raw.length > scan.consumed) {
      const trailing = new TextDecoder().decode(raw.subarray(scan.consumed))
      const attempt = yield* Effect.either(decodeLine(trailing))
      if (attempt._tag === "Right") {
        events.push(attempt.right)
        validBytes = raw.length
      } else {
        truncatedBytes = raw.length - scan.consumed
      }
    }

    return {
      events,
      skipped: scan.skipped,
      truncatedBytes,
      validBytes,
    } satisfies RecoveryResult
  })
