import { Schema } from "effect"
import { defineEvent, type EventDef } from "@rxweave/schema"

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

// Single source of truth both sides register — digest parity is the
// contract that lets the browser's `Append` RPC match the server's
// registry digest without an explicit `RegistryPush`.
export const CANVAS_SCHEMAS: ReadonlyArray<EventDef> = [
  CanvasShapeUpserted as EventDef,
  CanvasShapeDeleted as EventDef,
  CanvasBindingUpserted as EventDef,
  CanvasBindingDeleted as EventDef,
]
