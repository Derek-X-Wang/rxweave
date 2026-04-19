import { Schema } from "effect"
import { defineEvent } from "@rxweave/schema"
import { defineConfig } from "@rxweave/cli"
import { MemoryStore } from "@rxweave/store-memory"

const TestWidget = defineEvent(
  "test.widget.created",
  Schema.Struct({ id: Schema.String }),
)

export default defineConfig({
  store: MemoryStore.Live,
  schemas: [TestWidget],
  agents: [],
})
