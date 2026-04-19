import { Effect, Schema } from "effect"
import { defineAgent } from "@rxweave/runtime"
import type { EventEnvelope } from "@rxweave/schema"
import { SpeechTranscribed } from "../schemas.js"

const TRIGGER_WORDS = ["todo", "task", "remind me"]

export const taskFromSpeechAgent = defineAgent({
  id: "task-from-speech",
  on: { types: ["speech.transcribed"] },
  handle: (event: EventEnvelope) =>
    Effect.gen(function* () {
      const payload = yield* Schema.decodeUnknown(SpeechTranscribed.payload)(event.payload)
      const lower = payload.text.toLowerCase()
      if (!TRIGGER_WORDS.some((w) => lower.includes(w))) return
      return [
        {
          type: "task.created",
          payload: { title: payload.text.slice(0, 80), sourceText: payload.text },
        },
      ]
    }),
})
