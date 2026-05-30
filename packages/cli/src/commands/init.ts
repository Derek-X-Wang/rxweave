import { Command, Options } from "@effect/cli"
import { Effect } from "effect"
import { FileSystem } from "@effect/platform"
import { Output } from "../Output.js"

const yesOpt = Options.boolean("yes").pipe(Options.withDefault(false))
const templateOpt = Options.choice("template", ["minimal", "full"] as const).pipe(
  Options.withDefault("minimal" as const),
)

// v0.1 template — keeps `schemas` and `agents` empty so `rxweave dev`
// starts cleanly in a freshly-initialized project. The `FileStore.Live`
// path is intentionally relative to cwd so `.rxweave/events.jsonl` sits
// next to the config file.
const CONFIG_TEMPLATE = `import { defineConfig } from "@rxweave/cli"
import { FileStore } from "@rxweave/store-file"

export default defineConfig({
  store: FileStore.Live({ path: ".rxweave/events.jsonl" }),
  schemas: [],
  agents: [],
})
`

const FULL_CONFIG_TEMPLATE = `import { defineConfig } from "@rxweave/cli"
import { FileStore } from "@rxweave/store-file"
import { RequestPosted, ResponsePosted } from "./schemas.js"
import { bobAssistant } from "./agents/bob-assistant.js"

export default defineConfig({
  store: FileStore.Live({ path: ".rxweave/events.jsonl" }),
  schemas: [RequestPosted, ResponsePosted],
  agents: [bobAssistant],
})
`

const SCHEMAS_TEMPLATE = `import { Schema } from "effect"
import { defineEvent } from "@rxweave/schema"

// A human (or their tool) posts a request to the shared stream.
export const RequestPosted = defineEvent(
  "request.posted",
  Schema.Struct({ text: Schema.String }),
)

// An agent's reply — a first-class event on the same stream, with the same
// actor / causedBy / source fields a human event has.
export const ResponsePosted = defineEvent(
  "response.posted",
  Schema.Struct({ requestId: Schema.String, text: Schema.String }),
)
`

const AGENT_TEMPLATE = `import { Effect } from "effect"
import { defineAgent } from "@rxweave/runtime"
import type { EventEnvelope } from "@rxweave/schema"

// rung 1: a STUB responder. It teaches the protocol, not intelligence.
// rung 2: swap \`reply\` for a real Claude agent via @rxweave/llm's
// \`defineLlmAgent\` — that is where actual intelligence enters.
const reply = (text: string): string => \`ack: \${text}\`

// "bob-assistant" = a coworker's agent. When it emits below, the runtime
// stamps the new event with actor="bob-assistant", source="agent", and
// causedBy=[event.id] — so Alice can see what Bob's agent did, and what
// caused it, without relaying a prompt or asking Bob.
export const bobAssistant = defineAgent({
  id: "bob-assistant",
  on: { types: ["request.posted"] },
  handle: (event: EventEnvelope) =>
    Effect.succeed([
      {
        type: "response.posted",
        payload: {
          requestId: event.id,
          // event.payload is \`unknown\` at the type level; the \`on.types\`
          // filter above guarantees this is a request.posted, so the cast is safe.
          text: reply((event.payload as { text: string }).text),
        },
      },
    ]),
})
`

const FULL_README_TEMPLATE = `# RxWeave collaboration stream skeleton

A 60-second, zero-dependency demo of the RxWeave idea: humans **and** their
agents are all participants on one shared event stream. Here, a teammate
(\`alice\`) posts a request; a coworker's agent (\`bob-assistant\`) observes the
stream and replies — on the same log, with full provenance.

This is **rung 1**: the responder is a pure stub (\`ack: <text>\`). It teaches
the protocol, not intelligence. See "Next steps" for where a real Claude
agent comes in.

## Run it

\`\`\`bash
bun add @rxweave/schema @rxweave/store-file @rxweave/runtime effect
rxweave dev &                 # supervises bob-assistant
rxweave emit request.posted --actor alice --payload '{"text":"summarize the auth design"}'
rxweave stream                # the shared log: alice's request + bob-assistant's response
rxweave inspect <response-id> --ancestry   # the response, caused by alice's request
\`\`\`

## What you just saw

1. **Shared stream, multiple actors.** \`alice\` (a human via the CLI) and
   \`bob-assistant\` (an agent) both posted to one log, each tagged by \`actor\`.
2. **The agent observed and reacted** — no prompt-passing.
3. **Provenance.** \`response.posted\` is stamped \`causedBy: [<request id>]\`;
   \`inspect --ancestry\` shows who-asked / what-caused-what.
4. **Agent identity is just actor identity.** The agent's output is a
   first-class event with the same \`actor\` / \`source\` / \`causedBy\` fields a
   human's event has. Agents are participants, not a special channel.

## Next steps

- **Rung 2 — a real Claude agent.** Replace \`reply()\` in
  \`agents/bob-assistant.ts\` with \`@rxweave/llm\`'s \`defineLlmAgent\`. Now
  bob-assistant actually thinks.
- **Rung 3 — a second human.** \`rxweave emit request.posted --actor bob …\`
  with Bob's own agent on the same stream. You observe and react. The
  "paste this prompt into your Claude" relay is gone.
- **Make the agent idempotent** with \`withIdempotence\`, or stateful with
  \`reduce\` — see the \`@rxweave/runtime\` docs.
`

export interface ScaffoldFile {
  readonly path: string
  readonly content: string
}

export const templateFiles = (
  template: "minimal" | "full",
): ReadonlyArray<ScaffoldFile> => {
  if (template === "minimal") {
    return [{ path: "./rxweave.config.ts", content: CONFIG_TEMPLATE }]
  }
  return [
    { path: "./rxweave.config.ts", content: FULL_CONFIG_TEMPLATE },
    { path: "./schemas.ts", content: SCHEMAS_TEMPLATE },
    { path: "./agents/bob-assistant.ts", content: AGENT_TEMPLATE },
    { path: "./README.md", content: FULL_README_TEMPLATE },
  ]
}

export const templateDirs = (
  template: "minimal" | "full",
): ReadonlyArray<string> => (template === "full" ? ["./agents"] : [])

export const initCommand = Command.make(
  "init",
  { yes: yesOpt, template: templateOpt },
  (opts) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const out = yield* Output
      const configPath = "./rxweave.config.ts"
      const exists = yield* fs.exists(configPath)
      if (exists) {
        yield* out.writeError({ _tag: "AlreadyInitialized", path: configPath })
        return yield* Effect.fail(new Error("config exists"))
      }
      for (const dir of templateDirs(opts.template)) {
        yield* fs.makeDirectory(dir, { recursive: true })
      }
      const files = templateFiles(opts.template)
      for (const f of files) {
        yield* fs.writeFileString(f.path, f.content)
      }
      yield* fs.makeDirectory(".rxweave", { recursive: true })
      const created = files.map((f) => f.path).concat(".rxweave/")
      if (opts.template === "full") {
        yield* out.writeLine({
          created,
          next: [
            "bun add @rxweave/schema @rxweave/store-file @rxweave/runtime effect",
            "rxweave dev",
            "rxweave emit request.posted --actor alice --payload '{\"text\":\"hello\"}'",
          ],
        })
      } else {
        yield* out.writeLine({ created })
      }
    }),
)
