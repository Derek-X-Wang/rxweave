# OSS Adoption — `rxweave init --template full` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the dead `rxweave init --template full` so it scaffolds a runnable, zero-dependency "collaboration stream skeleton" (alice posts a request → `bob-assistant` agent responds on the shared log with auto-stamped provenance), rewrite the README quickstart to use it, and add a fresh-install smoke script that proves the flow end-to-end.

**Architecture:** Split init into a pure `templateFiles(template)` / `templateDirs(template)` (what to scaffold) and a thin handler (write it). `minimal` keeps today's empty-config behavior; `full` adds `schemas.ts` + `agents/bob-assistant.ts` + a collaboration-framed `README.md` + the wiring config. The agent uses a pure stub responder (no LLM, no cloud) and the runtime auto-stamps `actor` + `causedBy`. A `scripts/smoke-quickstart.sh` runs the whole thing in a throwaway temp dir against the local CLI build.

**Tech Stack:** TypeScript 5.9 (ESM), Effect 3.21, `@effect/cli`, `@effect/platform` FileSystem, Bun 1.3.5, Vitest 2.1 + `@effect/vitest`, oxlint/oxfmt.

**Branch:** create `feat/init-template-full` off `main` before Task 1.

---

## File Structure

- `packages/cli/src/commands/init.ts` — **modify.** Add exported pure `templateFiles` + `templateDirs`; rewrite handler to consume them and honor `opts.template`. Owns "what a scaffold contains."
- `packages/cli/test/init.test.ts` — **create.** Pure tests for `templateFiles`/`templateDirs` + a temp-dir handler integration test.
- `README.md` — **modify.** Quickstart section + install block.
- `scripts/smoke-quickstart.sh` — **create.** End-to-end fresh-install proof.

No other packages change — the scaffold only *uses* existing public API (`defineConfig`, `defineEvent`, `defineAgent`, `FileStore.Live`).

---

## Task 1: Extract pure `templateFiles` / `templateDirs` (minimal behavior unchanged)

**Files:**
- Modify: `packages/cli/src/commands/init.ts`
- Test: `packages/cli/test/init.test.ts` (create)

- [ ] **Step 1: Create the failing test**

Create `packages/cli/test/init.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { templateFiles, templateDirs } from "../src/commands/init.js"

describe("templateFiles / templateDirs", () => {
  it("minimal scaffolds exactly one file: rxweave.config.ts", () => {
    const files = templateFiles("minimal")
    expect(files.map((f) => f.path)).toEqual(["./rxweave.config.ts"])
    expect(files[0].content).toContain("defineConfig")
    expect(files[0].content).toContain("schemas: []")
    expect(files[0].content).toContain("agents: []")
  })

  it("minimal scaffolds no extra directories", () => {
    expect(templateDirs("minimal")).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --filter @rxweave/cli test init`
Expected: FAIL — `templateFiles` / `templateDirs` are not exported from `init.js`.

- [ ] **Step 3: Refactor `init.ts` to add the pure functions and route `minimal` through them**

In `packages/cli/src/commands/init.ts`, keep the imports and the existing `CONFIG_TEMPLATE` string. Add, above `initCommand`:

```ts
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
  // "full" fileset is added in Task 2.
  return [{ path: "./rxweave.config.ts", content: CONFIG_TEMPLATE }]
}

export const templateDirs = (
  template: "minimal" | "full",
): ReadonlyArray<string> => (template === "full" ? ["./agents"] : [])
```

(Do not change the handler yet — it still writes `CONFIG_TEMPLATE` directly. Task 3 rewires it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --filter @rxweave/cli test init`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/init.ts packages/cli/test/init.test.ts
git commit -m "refactor(cli): extract pure templateFiles/templateDirs from init"
```

---

## Task 2: Add the `full` collaboration-stream fileset

**Files:**
- Modify: `packages/cli/src/commands/init.ts`
- Test: `packages/cli/test/init.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `describe("templateFiles / templateDirs", ...)` in `packages/cli/test/init.test.ts`:

```ts
  it("full scaffolds config + schemas + agent + readme", () => {
    const paths = templateFiles("full").map((f) => f.path)
    expect(paths).toEqual([
      "./rxweave.config.ts",
      "./schemas.ts",
      "./agents/bob-assistant.ts",
      "./README.md",
    ])
  })

  it("full config wires the request/response schemas + bob-assistant", () => {
    const byPath = Object.fromEntries(
      templateFiles("full").map((f) => [f.path, f.content]),
    )
    expect(byPath["./rxweave.config.ts"]).toContain("RequestPosted")
    expect(byPath["./rxweave.config.ts"]).toContain("ResponsePosted")
    expect(byPath["./rxweave.config.ts"]).toContain("bobAssistant")
    expect(byPath["./schemas.ts"]).toContain('defineEvent(\n  "request.posted"')
    expect(byPath["./schemas.ts"]).toContain('"response.posted"')
    expect(byPath["./agents/bob-assistant.ts"]).toContain('id: "bob-assistant"')
    expect(byPath["./agents/bob-assistant.ts"]).toContain("response.posted")
    expect(byPath["./README.md"]).toContain("collaboration stream skeleton")
    expect(byPath["./README.md"]).toContain("--actor alice")
  })

  it("full scaffolds the agents directory", () => {
    expect(templateDirs("full")).toEqual(["./agents"])
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --filter @rxweave/cli test init`
Expected: FAIL — `full` currently returns only the config file; `paths` mismatch.

- [ ] **Step 3: Implement the full fileset**

In `packages/cli/src/commands/init.ts`, add these template string constants below `CONFIG_TEMPLATE`:

```ts
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
```

Then replace the `templateFiles` body's `full` branch:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --filter @rxweave/cli test init`
Expected: PASS (all five cases incl. Task 1's).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/init.ts packages/cli/test/init.test.ts
git commit -m "feat(cli): full template scaffolds the collaboration stream skeleton"
```

---

## Task 3: Wire the handler to honor `--template` and write the fileset

**Files:**
- Modify: `packages/cli/src/commands/init.ts`
- Test: `packages/cli/test/init.test.ts`

- [ ] **Step 1: Add the failing handler integration test**

Append to `packages/cli/test/init.test.ts`. Add these imports at the top of the file (the pure tests from Tasks 1–2 keep using vitest's `it`; the handler tests use `@effect/vitest`'s under the alias `itEffect` to avoid a name collision):

```ts
import { Effect } from "effect"
import { it as itEffect } from "@effect/vitest"
import { BunContext } from "@effect/platform-bun"
import { mkdtempSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Output } from "../src/Output.js"
import { initCommand } from "../src/commands/init.js"
```

Then add the handler suite. `initCommand.handler({ … })` is the proven invocation pattern (see `packages/cli/test/emit.test.ts:33` — `emitCommand.handler({…}).pipe(Effect.provide(out))`). init needs `FileSystem`, provided by `BunContext.layer`; the cwd-relative writes are redirected with a `chdir` guard:

```ts
const runInit = (template: "minimal" | "full", dir: string) =>
  Effect.gen(function* () {
    const prev = process.cwd()
    process.chdir(dir)
    try {
      yield* initCommand.handler({ yes: true, template })
    } finally {
      process.chdir(prev)
    }
  }).pipe(Effect.provide(Output.Live("json")), Effect.provide(BunContext.layer))

describe("init handler", () => {
  itEffect.effect("full writes config + schemas + agent + readme", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "rxw-init-full-"))
      yield* runInit("full", dir)
      expect(existsSync(join(dir, "rxweave.config.ts"))).toBe(true)
      expect(existsSync(join(dir, "schemas.ts"))).toBe(true)
      expect(existsSync(join(dir, "agents/bob-assistant.ts"))).toBe(true)
      expect(existsSync(join(dir, "README.md"))).toBe(true)
      expect(existsSync(join(dir, ".rxweave"))).toBe(true)
    }),
  )

  itEffect.effect("minimal writes only the config + .rxweave", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "rxw-init-min-"))
      yield* runInit("minimal", dir)
      expect(existsSync(join(dir, "rxweave.config.ts"))).toBe(true)
      expect(existsSync(join(dir, "schemas.ts"))).toBe(false)
      expect(existsSync(join(dir, "agents"))).toBe(false)
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun --filter @rxweave/cli test init`
Expected: FAIL — handler still writes only `CONFIG_TEMPLATE`; `schemas.ts` / `agents/bob-assistant.ts` / `README.md` absent for `full`.

- [ ] **Step 3: Rewrite the handler body**

In `packages/cli/src/commands/init.ts`, replace the `Effect.gen` body of `initCommand` (the part after resolving `fs` + `out`) with:

```ts
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
```

The handler signature already destructures `opts` (`{ yes, template }`) via `Command.make("init", { yes: yesOpt, template: templateOpt }, (opts) => …)` — confirm the handler takes `opts` (rename the ignored arg if it is currently `() =>`). `opts.template` is the previously-unused choice.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun --filter @rxweave/cli test init`
Expected: PASS (handler + pure cases).

- [ ] **Step 5: Typecheck + lint + full CLI suite**

Run: `bun run typecheck && bun --filter @rxweave/cli test && bun run lint`
Expected: all green (251+ tests; new init tests included).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/init.ts packages/cli/test/init.test.ts
git commit -m "feat(cli): init handler honors --template full, writes the fileset"
```

---

## Task 4: Rewrite the README quickstart to use `--template full`

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the install block (add `effect`)**

In `README.md`, replace the `## Install` runtime line:

```
bun add @rxweave/schema @rxweave/core @rxweave/store-file @rxweave/runtime
```

with:

```
bun add @rxweave/schema @rxweave/store-file @rxweave/runtime effect
```

(`effect` is a direct import in the scaffold's `schemas.ts`/`agents`; `@rxweave/core` is transitive, not needed by the quickstart.)

- [ ] **Step 2: Replace the `## 5-minute quickstart` section**

Replace the entire current quickstart block (the `rxweave init --yes` / canvas-emit example through `See apps/dev/ for a working example.`) with:

````markdown
## 5-minute quickstart

```bash
rxweave init --template full     # scaffolds a runnable collaboration stream
bun add @rxweave/schema @rxweave/store-file @rxweave/runtime effect
rxweave dev &                    # supervises the bob-assistant agent

# a teammate posts a request to the shared stream:
rxweave emit request.posted --actor alice --payload '{"text":"summarize the auth design"}'

rxweave stream                   # one shared log: alice's request + bob-assistant's response
rxweave inspect <response-id> --ancestry   # the response, caused by alice's request
```

`bob-assistant` is a coworker's agent. It observed the stream and replied —
on the same log, stamped with its own `actor` and a `causedBy` link back to
Alice's request. That is RxWeave's core: humans and their agents collaborate
**through a shared event stream**, not by relaying prompts. The scaffold's
`README.md` walks the demo and shows how to swap the stub responder for a
real Claude agent (`@rxweave/llm`).
````

- [ ] **Step 3: Verify the README has no remaining stale pointer**

Run: `grep -n "init --yes\|See \`apps/dev/\`\|canvas.node.created" README.md`
Expected: no matches in the quickstart section (the canvas reference may remain elsewhere intentionally; the quickstart must not tell users to define their own events before anything works).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): quickstart uses rxweave init --template full"
```

---

## Task 5: Fresh-install end-to-end smoke script

**Files:**
- Create: `scripts/smoke-quickstart.sh`

- [ ] **Step 1: Write the smoke script**

Create `scripts/smoke-quickstart.sh` (make it `chmod +x`):

```bash
#!/usr/bin/env bash
# Proves the README quickstart works for an outside user, from a fresh dir,
# against the LOCAL workspace build. Reusable post-release by pointing
# RXWEAVE_CLI_SPEC at a published version (e.g. @rxweave/cli@0.5.4).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CLI_SPEC="${RXWEAVE_CLI_SPEC:-file:$REPO/packages/cli}"
DEPS_FROM="${RXWEAVE_DEPS_FROM:-file:$REPO/packages}"  # local store-file/runtime/schema

WORK="$(mktemp -d)"
cleanup() { [ -n "${DEV_PID:-}" ] && kill "$DEV_PID" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

cd "$WORK"
echo "{ \"name\": \"smoke\", \"type\": \"module\", \"private\": true }" > package.json

# Install CLI + the deps the scaffold imports. For local runs we install the
# built workspace packages; override the *_SPEC vars to test published npm.
bun add "$CLI_SPEC"
bun add \
  "${RXWEAVE_SCHEMA_SPEC:-$DEPS_FROM/schema}" \
  "${RXWEAVE_STORE_FILE_SPEC:-$DEPS_FROM/store-file}" \
  "${RXWEAVE_RUNTIME_SPEC:-$DEPS_FROM/runtime}" \
  effect

RX() { bun x rxweave "$@"; }

RX init --template full
test -f rxweave.config.ts
test -f schemas.ts
test -f agents/bob-assistant.ts

# Start the supervisor; wait for the dev-ready line before emitting.
RX dev > dev.log 2>&1 &
DEV_PID=$!
for i in $(seq 1 50); do
  grep -q '"kind":"dev-ready"' dev.log && break
  sleep 0.2
done
grep -q '"kind":"dev-ready"' dev.log || { echo "dev never became ready"; cat dev.log; exit 1; }

# Alice posts a request. emit prints the created envelope as JSON.
REQ_JSON="$(RX emit request.posted --actor alice --payload '{"text":"urgent: ship it"}')"
REQ_ID="$(printf '%s' "$REQ_JSON" | bun -e 'process.stdin.once("data",d=>process.stdout.write(JSON.parse(d.toString()).id))')"
[ -n "$REQ_ID" ] || { echo "no request id from emit: $REQ_JSON"; exit 1; }

# Give bob-assistant a moment to react, then read the shared stream history.
sleep 1
STREAM="$(RX stream)"
RESP="$(printf '%s\n' "$STREAM" | grep '"type":"response.posted"' | tail -1)"
[ -n "$RESP" ] || { echo "no response.posted on the stream"; echo "$STREAM"; exit 1; }

# Assert: response is bob-assistant's, links to alice's request via causedBy + payload.
printf '%s' "$RESP" | bun -e '
  const e = JSON.parse(require("fs").readFileSync(0,"utf8"));
  const reqId = process.argv[1];
  if (e.actor !== "bob-assistant") { console.error("actor:", e.actor); process.exit(1); }
  if (!Array.isArray(e.causedBy) || !e.causedBy.includes(reqId)) { console.error("causedBy:", e.causedBy); process.exit(1); }
  if (e.payload.requestId !== reqId) { console.error("payload.requestId:", e.payload.requestId); process.exit(1); }
  const RESP_ID = e.id;
  console.error("OK response", RESP_ID, "caused by", reqId);
' "$REQ_ID"

# Ancestry of the response includes alice's request.
RESP_ID="$(printf '%s' "$RESP" | bun -e 'process.stdin.once("data",d=>process.stdout.write(JSON.parse(d.toString()).id))')"
RX inspect "$RESP_ID" --ancestry | grep -q "$REQ_ID" || { echo "ancestry missing request"; exit 1; }

echo "SMOKE OK"
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/smoke-quickstart.sh`

- [ ] **Step 3: Build the workspace then run the smoke script**

Run: `bun run build && bash scripts/smoke-quickstart.sh`
Expected: ends with `SMOKE OK`. If `bun add file:…` cannot resolve a workspace package's own `workspace:^` deps, set the `*_SPEC` env vars to packed tarballs (`bun pm pack` each package, point at the `.tgz`) — note the working invocation in the script header comment.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-quickstart.sh
git commit -m "test(smoke): fresh-install end-to-end quickstart proof"
```

---

## Task 6: Final verification + branch wrap

**Files:** none (verification only)

- [ ] **Step 1: Full suite green**

Run: `bun run typecheck && bun run test && bun run lint`
Expected: all 251+ tests pass (now including the init tests), 0 type errors, 0 lint findings.

- [ ] **Step 2: Smoke green from a clean build**

Run: `bun run build && bash scripts/smoke-quickstart.sh`
Expected: `SMOKE OK`.

- [ ] **Step 3: Confirm the dead feature is gone**

Run: `rm -rf /tmp/rxw-manual && mkdir /tmp/rxw-manual && (cd /tmp/rxw-manual && bun x --bun "file:$PWD/packages/cli" init --template full && ls -R)`
Expected: `rxweave.config.ts schemas.ts agents/bob-assistant.ts README.md .rxweave/` present (no longer an empty config). (Adjust the cli spec to your build path; this is a sanity eyeball, not a gate.)

- [ ] **Step 4: Update HANDOFF "Immediate pending"**

In `docs/HANDOFF.md`, under "Immediate pending" item 1 (OSS adoption cycle), note the first deliverable shipped: `rxweave init --template full` scaffolds the collaboration stream skeleton; quickstart verified by `scripts/smoke-quickstart.sh`; next adoption rungs = real Claude agent (rung 2) + committed browsable `examples/` copy.

```bash
git add docs/HANDOFF.md
git commit -m "docs(handoff): init --template full shipped (OSS adoption rung 1)"
```

- [ ] **Step 5: Done — surface integration options**

The branch `feat/init-template-full` is ready. Do not merge or push without user authorization (the rxweave release/push gate). Report: tests, smoke result, and the diff summary.

---

## Notes for the implementer

- **ESM `.js` imports.** Scaffold templates import with `.js` extensions (`./schemas.js`) — that is the runtime ESM convention here, matching `apps/dev/`. The `.ts` source files resolve through it.
- **Registry enforcement.** Both `request.posted` and `response.posted` are registered in the scaffold config; emitting an unregistered type is a tagged runtime error, so the smoke `emit` would fail loudly if a type were missing.
- **`dev` readiness.** `rxweave dev` prints `{"kind":"dev-ready","agents":N}` once the supervisor attaches (`packages/cli/src/commands/dev.ts`). The smoke polls for that line — never a fixed sleep for readiness.
- **No public API change.** Only `@rxweave/cli`'s `init` command changes; no package version bump is required to land this on `main`, though a `@rxweave/cli` patch release makes the new template available to npm consumers (separate release decision).
