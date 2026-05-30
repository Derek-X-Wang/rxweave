# OSS Adoption — `rxweave init --template full` collaboration-stream quickstart

**Date:** 2026-05-30
**Status:** Approved (brainstorming complete; Codex `/counsel`-reviewed twice)
**Repo:** `rxweave` (OSS monorepo). No cloud changes.

## Why

RxWeave is primarily an OSS toolkit; `cloud/` is private infra. There are **zero external users today.** Every recent cycle (v0.5.x + cloud-v0.3.x) polished cloud internals — the wrong target for a zero-user project. The limiting constraint is *adoption*: a stranger has to be able to go from nothing to a working RxWeave thing in ~60 seconds, or they bounce.

The project's reason to exist (author, verbatim intent): **multi-human + multi-agent collaboration.** Today AI collaboration means humans hand-relaying prompts — "paste this into your Claude." It's lossy: you can't see what a coworker's Claude did, you have to go ask the human. RxWeave's fix is one shared event stream where humans *and* their AI agents are all participants; a coworker's agent emits to the stream, your agent and you observe and react. Collaboration happens through the log — no prompt-passing.

The first adoption deliverable must therefore both (a) let a stranger succeed cold on first run, and (b) reflect the collaboration soul, not a disconnected mechanism demo.

### The concrete hole this closes

- `packages/cli/src/commands/init.ts` advertises `--template minimal|full` but the handler **ignores `template`** — both branches write an empty config (`schemas: []`, `agents: []`). The `full` option is a dead feature.
- `README.md` then tells outside users to "define your events + agents" before anything interesting happens. That is a library-assembly task, not an adoption surface.
- The README quickstart has **never been verified from a fresh outside install.**
- Working reference agents exist in `apps/dev/` but it is workspace-only — an outside user cannot run it against published npm packages.

## What we build

Implement the dead `--template full` branch so `rxweave init --template full` scaffolds a complete, runnable, zero-external-dependency local project that demonstrates a **shared collaboration stream** — "rung 1" of a collaboration ladder. Plus a fresh-install smoke script that proves the whole flow end-to-end, and a README quickstart rewrite that points at the template instead of punting to "define your own."

### Scenario: a shared collaboration stream (rung 1)

A teammate (`alice`, a human via CLI) posts a request to the shared log. A coworker's agent (`bob-assistant`) observes the stream and responds automatically. Everything lands on one log, each event tagged by `actor`, the response provenance-linked to the request.

**Events** (`schemas.ts`, via `defineEvent` from `@rxweave/schema`):
- `request.posted` — `Schema.Struct({ text: Schema.String })`
- `response.posted` — `Schema.Struct({ requestId: Schema.String, text: Schema.String })`

**Agent** (`agents/bob-assistant.ts`, via `defineAgent` from `@rxweave/runtime`):
```ts
defineAgent({
  id: "bob-assistant",
  on: { types: ["request.posted"] },
  handle: (event) =>
    Effect.succeed([
      { type: "response.posted",
        payload: { requestId: event.id, text: reply(event.payload.text) } },
    ]),
})
// reply(text) = `ack: ${text}` — a pure stub. NO LLM, NO API key, NO cloud.
```
The runtime auto-stamps the emitted `response.posted` with `actor = "bob-assistant"`, `source = "agent"`, and `causedBy = [event.id]` (see `packages/runtime/src/Supervisor.ts:187`), because it is emitted inside `handle(trigger)`.

`handle` (not `withIdempotence`, not `reduce`) is deliberate — minimum cognitive load for a first read. Idempotence and stateful `reduce` are pointed at as "next steps" in the scaffold README.

### The 60-second demo (what the scaffold README walks through)

```bash
rxweave init --template full
bun add @rxweave/schema @rxweave/store-file @rxweave/runtime effect   # effect is explicit
rxweave dev &                                                          # supervises bob-assistant
rxweave emit request.posted --actor alice --payload '{"text":"summarize the auth design"}'
rxweave stream            # shared log: alice's request + bob-assistant's response, each tagged by actor
rxweave inspect <response-id> --ancestry   # response.posted ← caused by alice's request.posted
```

The payoff line: **Bob's agent acted on the shared log, and Alice can see exactly what it did — and what caused it — without relaying a prompt or asking Bob.**

### Four teaching points

1. **Shared stream, multiple actors.** `alice` (human via CLI) and `bob-assistant` (agent) both post to one log, each tagged by `actor`. The multi-participant primitive.
2. **Agent observes + reacts.** `bob-assistant` watches the stream and responds automatically — no prompt-passing.
3. **Provenance.** `response.posted` is auto-stamped `causedBy: [request.id]`; `inspect --ancestry` shows who-asked / what-caused-what.
4. **Agent identity *is* actor identity.** An agent's output is a first-class event with the same `actor` / `source` / `causedBy` fields as a human's CLI event. (Codex's added point — the conceptual unlock: agents are not a special channel, they are participants.)

### Honest framing (anti-theater)

Rung 1 is the **"collaboration stream skeleton"** — a local provenance loop. It is **not** an AI demo and the copy must never sell the `ack:` stub as the compelling Claude experience. The scaffold README and the repo README frame the ladder explicitly:

- **Rung 1 (this):** stub responder (`reply()`), one agent, local, zero deps. Teaches the protocol.
- **Rung 2:** swap `reply()` for a real Claude agent via `@rxweave/llm`'s `defineLlmAgent` (already proven in `packages/llm/test/LlmAgent.test.ts:55`; emits tool-result events with actor + causedBy). Intelligence enters here.
- **Rung 3:** a second human — `rxweave emit request.posted --actor bob …` with Bob's own agent on the same stream; you observe and react. The prompt-passing pain, gone.

## Files

Scaffolded by `init --template full` (written into the user's cwd):
- `rxweave.config.ts` — `defineConfig({ store: FileStore.Live({ path: ".rxweave/events.jsonl" }), schemas: [RequestPosted, ResponsePosted], agents: [bobAssistant] })`
- `schemas.ts` — the two `defineEvent`s above.
- `agents/bob-assistant.ts` — the agent above + `reply()`.
- `README.md` — what it is, the explicit `bun add … effect` line, the 60-second walkthrough, the four teaching points, the rung-2/rung-3 ladder.

`init --template full` does **not** write a `package.json` or install anything — it assumes the user is already in a bun project that has done `bun add @rxweave/cli` (the README quickstart flow), and the scaffold README tells them the remaining `bun add … effect` line. The smoke script (below) creates its own throwaway `package.json` because it simulates that pre-existing project.

Changed in the rxweave repo:
- `packages/cli/src/commands/init.ts` — implement the `full` branch (write the fileset above; `minimal` unchanged; keep the existing refuse-if-`rxweave.config.ts`-exists guard).
- `README.md` — rewrite the "5-minute quickstart" to use `rxweave init --template full`; replace the canvas-flavored emit examples with the working request/response flow; add `effect` to the install block (`README.md:11`); drop "See `apps/dev/`" in favor of the generated README.
- `scripts/smoke-quickstart.sh` — new. The end-to-end proof (below).
- `packages/cli/test/…` — extend the init unit test to assert the `full` fileset is written.

Untouched: `apps/dev/`, `apps/web/`, all non-CLI packages (no API changes — the template only *uses* existing public API), cloud.

## Verification — `scripts/smoke-quickstart.sh`

The gap being closed is "quickstart never verified from outside," so the script must run as an outside user would, against the **built/packed** CLI (not the workspace source):

1. Create a fresh temp dir (outside the monorepo).
2. Minimal `package.json`; install the CLI + runtime deps. For local dev iteration: install from the local workspace build (`bun add` against packed tarballs or `file:` to built packages). The same script form is reusable post-release against npm (`@rxweave/cli@<version>`).
3. `rxweave init --template full`.
4. `rxweave dev` in the background; wait for the supervisor to be ready.
5. `rxweave emit request.posted --actor alice --payload '{"text":"urgent: ship it"}'`.
6. Assert: a `response.posted` event appears in `rxweave stream`; its `payload.requestId` equals the request's id; its `actor` is `bob-assistant`; its `causedBy` is non-empty and contains the request id.
7. `rxweave inspect <response-id> --ancestry` shows the `request.posted`.
8. Tear down (kill `dev`, remove temp dir).

A missing-dependency regression (e.g. `effect` not installed) must make the script fail at step 4/5, not pass silently — this is what catches the `README.md:11` install-block gap.

## Testing

- **Unit:** extend the existing `init` test — `--template full` writes `rxweave.config.ts` + `schemas.ts` + `agents/bob-assistant.ts` + `README.md`; `--template minimal` still writes the empty config.
- **Integration:** `scripts/smoke-quickstart.sh` is the real test. Manual to run this cycle; CI wiring is optional follow-up (run post-release against the published package).
- All 251 existing tests stay green. No public API changes, so no conformance impact.

## Scope boundaries (explicitly OUT of this cut — YAGNI)

- No real LLM agent (rung 2).
- No real second human / multi-process (rung 3).
- No cloud.
- No committed browsable `examples/` copy of the scaffold (`init --template full` *is* the example; committing the generated output for GitHub browsing is a later follow-up — the "option C" combine).
- No CI wiring required (smoke script first; CI is optional follow-up).
- `apps/dev` left as-is.

## Open risks / notes

- **Registry enforcement on emit.** Every event type the agent emits must be registered (design decision: emitting an unregistered type is a tagged runtime error). The template registers both `request.posted` and `response.posted` in `schemas`. The smoke test exercises the real emit path and would surface any gap.
- **`rxweave dev` readiness timing.** The smoke script must wait for the supervisor to attach before emitting, or the first event can be missed. Poll for readiness rather than a fixed sleep.
- **Local-vs-npm install in the smoke script.** This cycle targets the local workspace build so it can be run before a release. The script should parameterize the install source so the same file works post-release against npm.
