import { defineConfig } from "@rxweave/cli"
import { FileStore } from "@rxweave/store-file"
import { RequestPosted, ResponsePosted } from "./schemas.js"
import { bobAssistant } from "./agents/bob-assistant.js"

export default defineConfig({
  store: FileStore.Live({ path: ".rxweave/events.jsonl" }),
  schemas: [RequestPosted, ResponsePosted],
  agents: [bobAssistant],
})
