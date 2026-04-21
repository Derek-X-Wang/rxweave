import { Command, Options } from "@effect/cli"
import { Effect, Option } from "effect"
import { readFile } from "node:fs/promises"
import { EventStore } from "@rxweave/core"
import type { ActorId, EventInput, Source } from "@rxweave/schema"
import { Output } from "../Output.js"

/**
 * `rxweave import <file>` — inverse of `rxweave stream`. Reads an NDJSON
 * (`.jsonl`) or JSON-array (`.json`) file and appends each entry via the
 * configured EventStore. Used for seeding fixtures, migrating event
 * histories between backends, and restoring backups captured with
 * `rxweave stream >> backup.jsonl` (spec §9.1).
 *
 * Format detection is shape-based rather than extension-based: a file
 * whose trimmed contents start with `[` is parsed as a single JSON
 * array; otherwise we split on newlines and parse each non-empty line
 * as its own JSON object. That means `.json` arrays work even when the
 * filename has no extension, and a `.jsonl` file that happens to begin
 * with a `[` line will correctly fail to parse (the array close `]`
 * belongs on the same line or the JSON is malformed — NDJSON lines
 * must individually parse).
 *
 * Defaults: when a wire entry omits `actor`, fall back to `"cli"`
 * (matches emit.ts). When it omits `source`, also fall back to
 * `"cli"` — Source is a closed literal union of canvas/agent/system/
 * voice/cli/cloud and "import" is not a member, so we pick the
 * closest generic ("cli") and preserve whatever source the file
 * specified if it had one. Passing `--actor X` overrides the actor on
 * *every* event regardless of what the file says — that's the
 * intended semantic for migration recipes where the importer wants to
 * attribute the whole batch to itself. We deliberately do NOT offer a
 * `--source` override here; preserving the file's recorded source is
 * more useful than letting a caller rewrite history.
 */

const fileOpt = Options.file("file")
const dryRunOpt = Options.boolean("dry-run").pipe(Options.withDefault(false))
const actorOpt = Options.text("actor").pipe(Options.optional)

type WireInput = {
  readonly type: string
  readonly payload: unknown
  readonly actor?: string
  readonly source?: Source
}

const parseFile = (text: string): ReadonlyArray<WireInput> => {
  const trimmed = text.trim()
  if (trimmed.length === 0) return []
  // Shape-based detection. A leading `[` is the only legal start for a
  // JSON array of objects, so we try that branch first. JSON.parse
  // throws on malformed input, which becomes a fiber failure caught
  // by bin/rxweave.ts — same failure path emit.ts uses for a bad
  // --payload, exit code 1.
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown
    if (!Array.isArray(parsed)) {
      throw new Error("import: file starts with '[' but did not parse as a JSON array")
    }
    return parsed as ReadonlyArray<WireInput>
  }
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as WireInput)
}

export const importCommand = Command.make(
  "import",
  { file: fileOpt, dryRun: dryRunOpt, actor: actorOpt },
  ({ file: filePath, dryRun, actor }) =>
    Effect.gen(function* () {
      const out = yield* Output
      const text = yield* Effect.promise(() => readFile(filePath, "utf8"))
      const parsed = parseFile(text)

      const actorOverride = Option.isSome(actor) ? actor.value : null

      const events: Array<EventInput> = parsed.map((wire) => ({
        type: wire.type,
        actor: ((actorOverride ?? wire.actor ?? "cli") as ActorId),
        source: ((wire.source ?? "cli") as Source),
        payload: wire.payload,
      } as unknown as EventInput))

      if (dryRun) {
        yield* out.writeLine(
          `[import] dry-run: ${events.length} events from ${filePath}`,
        )
        for (const ev of events) yield* out.writeLine(`  ${ev.type}`)
        return
      }

      const store = yield* EventStore
      yield* store.append(events)
      yield* out.writeLine(
        `[import] appended ${events.length} events from ${filePath}`,
      )
    }),
)
