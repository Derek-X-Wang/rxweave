import { Schema } from "effect"
import { defineEvent } from "@rxweave/schema"

// Canvas events carry tldraw's native record payloads verbatim. The
// tldraw store uses stable `id`s per shape/asset/etc., and its
// `toStorePageJson` / store.put / store.remove round-trip cleanly on
// any record that came out of its own store. Storing the full record
// (rather than a subset) keeps the bridge stateless — whoever replays
// an event just calls `editor.store.put([record])`.

// Shapes: `shape:xxx` records. Geometry + position + type-specific props.
export const CanvasShapeUpserted = defineEvent(
  "canvas.shape.upserted",
  Schema.Struct({ record: Schema.Unknown }),
)

export const CanvasShapeDeleted = defineEvent(
  "canvas.shape.deleted",
  Schema.Struct({ id: Schema.String }),
)

// Bindings: `binding:xxx` records (arrow→shape attachments in v3+).
export const CanvasBindingUpserted = defineEvent(
  "canvas.binding.upserted",
  Schema.Struct({ record: Schema.Unknown }),
)

export const CanvasBindingDeleted = defineEvent(
  "canvas.binding.deleted",
  Schema.Struct({ id: Schema.String }),
)
