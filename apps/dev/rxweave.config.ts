import { defineConfig } from "@rxweave/cli"
import { FileStore } from "@rxweave/store-file"
import { CanvasNodeCreated, SpeechTranscribed, TaskCreated } from "./schemas.js"
import { counterAgent } from "./agents/counter.js"
import { echoAgent } from "./agents/echo.js"
import { taskFromSpeechAgent } from "./agents/task-from-speech.js"

export default defineConfig({
  store: FileStore.Live({ path: ".rxweave/events.jsonl" }),
  schemas: [CanvasNodeCreated, SpeechTranscribed, TaskCreated],
  agents: [counterAgent, echoAgent, taskFromSpeechAgent],
})
