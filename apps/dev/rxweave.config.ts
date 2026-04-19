import { Layer } from "effect"
import { defineConfig } from "@rxweave/cli"
import type { AgentDef } from "@rxweave/runtime"
import type { EventDef } from "@rxweave/schema"
import { FileStore } from "@rxweave/store-file"
import { CanvasNodeCreated, SpeechTranscribed, TaskCreated } from "./schemas.js"
import { counterAgent } from "./agents/counter.js"
import { echoAgent } from "./agents/echo.js"
import { taskFromSpeechAgent } from "./agents/task-from-speech.js"

// Why the casts? `RxWeaveConfig` in @rxweave/cli was typed before any
// concrete consumer exercised it. With `exactOptionalPropertyTypes: true`,
// three surfaces break at the call site:
//   1. `store: Layer.Layer<EventStore>` — FileStore.Live publishes
//      `Layer<EventStore, Error | PlatformError>` because Bun's
//      FileSystem errors surface through the layer's E channel. Squashed
//      with Layer.orDie so construction defects propagate as die()s.
//   2. `schemas: ReadonlyArray<EventDef>` — `EventDef` defaults to
//      `EventDef<unknown, unknown>` which is invariant in its payload
//      type parameter. Widened locally to `EventDef<any, any>` so the
//      concrete schemas with typed payloads fit.
//   3. `agents: ReadonlyArray<AgentDef<any>>` — `AgentDef<S>`'s optional
//      `reduce?: AgentReduce<S>` is contravariant in S and, under
//      exactOptionalPropertyTypes, requires exact S match — which fails
//      for AgentDef<never> (agents without initialState) assigned into
//      AgentDef<any>. Widened via `as unknown as`.
// These belong in @rxweave/cli's config typing as follow-ups — see
// commit message + report.
export default defineConfig({
  store: Layer.orDie(FileStore.Live({ path: ".rxweave/events.jsonl" })),
  schemas: [CanvasNodeCreated, SpeechTranscribed, TaskCreated] as ReadonlyArray<
    EventDef<any, any>
  >,
  agents: [counterAgent, echoAgent, taskFromSpeechAgent] as unknown as ReadonlyArray<
    AgentDef<any>
  >,
})
