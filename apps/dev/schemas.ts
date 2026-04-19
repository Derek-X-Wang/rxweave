import { Schema } from "effect"
import { defineEvent } from "@rxweave/schema"

export const CanvasNodeCreated = defineEvent(
  "canvas.node.created",
  Schema.Struct({ id: Schema.String, label: Schema.String }),
)

export const SpeechTranscribed = defineEvent(
  "speech.transcribed",
  Schema.Struct({ text: Schema.String, confidence: Schema.Number }),
)

export const TaskCreated = defineEvent(
  "task.created",
  Schema.Struct({ title: Schema.String, sourceText: Schema.String }),
)
