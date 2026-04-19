import { Schema } from "effect"
import { defineEvent } from "@rxweave/schema"

export const CanvasNodeCreated = defineEvent(
  "canvas.node.created",
  Schema.Struct({ id: Schema.String, label: Schema.String }),
)

export const CanvasNodeDeleted = defineEvent(
  "canvas.node.deleted",
  Schema.Struct({ id: Schema.String }),
)

export const SpeechTranscribed = defineEvent(
  "speech.transcribed",
  Schema.Struct({ text: Schema.String, confidence: Schema.Number }),
)

export const ALL = [CanvasNodeCreated, CanvasNodeDeleted, SpeechTranscribed] as const
