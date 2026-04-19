# RxWeave — Handoff

**Last updated:** 2026-04-19 after v0.2.1 ship.
**Integration state:** 26/26 conformance cases green against live Convex dev; 88 local tests + 18 turbo tasks green.
**Read this first** if you're resuming work on RxWeave — in a fresh Claude Code session, from a different machine, or as a new contributor.

---

## What shipped

| Tag | Scope | Date |
|---|---|---|
| `v0.0.1-contract` | `@rxweave/schema` + `@rxweave/protocol` + `@rxweave/core` (tags + types, no Live layers) — the contract freeze that unblocked parallel team work | 2026-04-18 |
| `v0.1.0` | Local stack: `store-memory`, `store-file`, `reactive`, `runtime`, `cli`, `apps/dev`. CLI compiled to single Bun binary. | 2026-04-18 |
| `v0.2.0` | `store-cloud` client adapter + `system.agent.heartbeat` emitter | 2026-04-18 |
| `v0.2.1` | Codex-review patches: polling-safe `Subscribe` + `QueryAfter` RPC, retry classification, digest memoization, polling-adapter-friendly flood test + `EventInput: Schema.Struct` over the wire | 2026-04-19 |

Companion repo (`cloud/`, private) shipped `cloud-v0.1.0` and `cloud-v0.2.1` in the same windows. Full dashboard (events list, inspect + lineage, agents, API keys) live at the dev deployment.

**Per spec §15 success criteria — all green.**

## Key design decisions (locked; do not relitigate without cause)

These are the eight architectural calls that shape the whole project. All are in the design spec (`docs/superpowers/specs/2026-04-18-rxweave-design.md`) with rationale.

1. **Scope C** — rxweave is OSS, cloud is optional/private. Cloud depends on `@rxweave/protocol`; rxweave has zero cloud deps. One-way dep graph, enforced.
2. **Schema registry (B)** — every event type is declared via `defineEvent(type, payloadSchema)`. Emitting an unregistered type is a tagged runtime error.
3. **Storage A3+R3** — pluggable `EventStore` Context.Tag; cursor-based exclusive subscribe is the primitive. ULID as event id.
4. **Stream-first reactive (A)** — Effect `Stream` directly, no custom DSL. Push-down filter at the subscribe boundary.
5. **Declarative agents (D)** — `defineAgent({id, on, handle | reduce})`. Runtime owns cursor persistence per id + provenance stamping on emits. `FiberMap` keyed by id.
6. **Semantic events = agents (A) + L2 lineage** — derivations are agents that emit events. Optional `causedBy: EventId[]` auto-stamped when emit happens inside `handle(trigger)`.
7. **Kitchen-sink AI-first CLI (C+C1)** — NDJSON stdout default, tagged-error NDJSON stderr, exit codes 0–6, no prompts. Config via `rxweave.config.ts`.
8. **`@effect/rpc` RpcGroup in `@rxweave/protocol` owned by rxweave (P3+S1)** — cloud implements handlers. Bearer-token auth.

## Tooling baseline

- Bun 1.3.5 (pinned in root `packageManager`)
- Effect 3.21.x (peer-dep floor set by `@effect/rpc`)
- `@effect/rpc` 0.75.x (NDJSON transport, streaming responses)
- TypeScript 5.9.x
- Turborepo 2.9.x
- Vitest 2.1.x + `@effect/vitest` 0.17.x
- oxlint 0.13.x
- ESM-only — no CJS, no dual builds
- `@noble/hashes` for V8-isolate-safe sha256 (schema is portable across Node/Bun/browsers/Convex)

## Sub-project status

| Package | Version | Tests | Notes |
|---|---|---|---|
| `@rxweave/schema` | 0.1.0 | 22 | `EventInput` is `Schema.Struct` (wire-safe); `EventEnvelope` is `Schema.Class`. Digest memoized. |
| `@rxweave/core` | 0.1.0 | 1 + conformance harness (10 cases) | `EventStore` tag; `queryAfter` added v0.2.1 for exclusive-cursor paging. |
| `@rxweave/store-memory` | 0.1.0 | 12 | `PubSub.sliding(1024)` fan-out; snapshot-then-live handoff under `Semaphore(1)` |
| `@rxweave/store-file` | 0.1.0 | 16 | JSONL + fsync + cold-start recovery (truncate torn tail, skip interior corruption) |
| `@rxweave/store-cloud` | 0.1.0 | 14 + 1 opt-in integration (12 cases) | Bearer token + `HttpClient.mapRequestEffect` refresh-on-401; polling-safe `Subscribe`; retry classification |
| `@rxweave/reactive` | 0.1.0 | 3 | `whereType`, `byActor`, `bySource`, `withinWindow` (uses `Clock`), `decodeAs` |
| `@rxweave/runtime` | 0.1.0 | 12 | `defineAgent`, `supervise` via `FiberMap`, `AgentCursorStore` Memory+File, `withIdempotence` (local mode; store mode is pass-through — see TODO) |
| `@rxweave/llm` | 0.1.0 | 4 | `defineLlmAgent` wrapping `defineAgent`; `tool()` helper with Effect Schema args → JSON Schema; Vercel AI SDK backend; tools return `EventInput[]`; multi-step via `stepCountIs`. Opt-in demo at `apps/dev/agents/llm-task-from-speech.ts`. |
| `@rxweave/protocol` | 0.1.0 | 2 | `RxWeaveRpc` RpcGroup. `QueryAfter` added v0.2.1. |
| `@rxweave/cli` | 0.1.0 | 7 | All commands, exit codes + stderr routing, config loader for all commands (not just `dev`). Compiled via `bun build --compile`. |

## Fix-forward — small gaps documented in the spec

Deferred on purpose, not broken. Each is bounded in scope; any contributor can pick one up.

- **`withIdempotence("store")` store-backed dedupe** (§7.4; `packages/runtime/src/Dedupe.ts`) — currently pass-through. Spec promises both "local" + "store" modes. "store" should write dedupe keys to a dedicated `agent.dedupe.<id>` sub-log (or a sibling JSON file) so dedup survives restarts.
- **`inspect --depth > 1` traversal** (§8; `packages/cli/src/commands/inspect.ts`) — default depth is 3 per the spec's CLI table; v0.1 ships depth=1 only. Needs a simple recursive walk up (ancestors) and down (descendants) with the `--depth` limit.
- **`store-file` edge-case test coverage** (`packages/store-file/test/`) — happy path covered. Missing: truncate-torn-tail then append cycle, N-event replay after recovery, `since` filter, multi-byte UTF-8 recovery math (offset calculation when mid-char truncation happens).
- **Extract `matchFilter` + envelope-construction duplication** — `packages/store-memory/src/MemoryStore.ts` and `packages/store-file/src/FileStore.ts` contain the same ~15-line helpers verbatim. Extract to `@rxweave/core` as internal utilities; both adapters import. Cloud adapter correctly delegates server-side so doesn't duplicate.

## Medium-term — next capabilities (explicit v0.1 non-goals from spec §13)

These are the product surfaces named but deferred.

- **`@rxweave/ingest-voice`** — voice → transcript → `speech.transcribed` events. Envelope already supports `source: "voice"`. `apps/dev/agents/task-from-speech.ts` is the downstream demo already wired. Build: pick an ASR provider (Deepgram, Whisper), wrap in an Effect service with streaming output, emit one `speech.transcribed` event per utterance with `{text, confidence, durationMs, audioUri?}` payload.
- **`@rxweave/llm` — LLM agents** — currently `defineAgent.handle` is pure TypeScript. Spec frames LLM agents as a *specialization* via `defineLlmAgent({model, systemPrompt, tools, handle: (event, ctx) => Effect<Event[]>})` that wraps `defineAgent` with an LLM-backed implementation. This is the biggest lever for the original pitch (human+AI teammates on a shared stream).
- **Payload predicates in `Filter`** (§4.2) — v0.1 explicitly rejected; spec says add a capability-negotiated filter AST later. Memory+File can do full predicates locally; cloud declares what it can push down to Convex via a capability exchange on subscribe.
- **Per-agent concurrency > 1** — runtime ships serial-only. `defineAgent({concurrency: {max: 8}})` needs a bounded channel in `Supervisor.ts` — each event claims a slot; slot release on handler completion.
- **Cron / scheduled agents** — spec's answer: emit `system.tick` events from a scheduler Layer; agents react normally. A separate `@rxweave/scheduler` package with `defineSchedule({every, on, emit})`.
- **Cycle detection for `causedBy`** — optional. A helper that walks lineage and warns on `a → b → a` patterns in dev mode. Not needed for correctness; useful for debugging.

## Long-term — the actual pitch from the brain prompt

Once the above land, rxweave is a capable event-sourced framework. The original pitch goes further:

- **Canvas / whiteboard UI** — `apps/dev` is console-only by spec mandate. The OG demo is a shared canvas that emits `canvas.node.*` / `canvas.edge.*` events and re-renders from subscribe. Pairs with multi-user (cloud) beautifully.
- **Video / perception → events** — `source: "video"` isn't in the envelope's source literal yet; adding it is a schema bump. Perception pipeline: per-frame detections → filtered/debounced → `perception.*` events.
- **Browser runtime** — `@rxweave/store-idb` (IndexedDB-backed) unlocks client-side rxweave inside React/Vue/etc apps. Schema is V8-safe (hence `@noble/hashes`); store-memory would also run. Needs a browser-adapted `@effect/platform-browser` for the CLI wire equivalent.
- **Shared cognition / blackboard** — multi-agent coordination where agents build a shared semantic index that other agents query. `@rxweave/cognition` — stores derived projections (entity graphs, timelines, task states) that any agent can read.

## Operational — not product, but needed to actually ship

- **Push to remote** — both repos are local-only right now. Create `github.com/Derek-X-Wang/rxweave` (public) and push. Cloud lives in a private repo.
- **npm publish** — scoped to `@rxweave/*`. Order: `schema`, `core`, `protocol` first (they're depended on); then adapters (`store-memory`, `store-file`, `store-cloud`); then `reactive`, `runtime`, `cli`. Use `changesets` or similar for version coordination.
- **Public docs site** — README is a 5-min quickstart. Full docs (concept guides, API ref, cookbook) belong in `docs/` with TypeDoc-generated API pages + hand-written guides. VitePress or Docusaurus both fit.
- **Real external users** — nobody's run this outside this machine. Blog post + two motivating demos (task tracker from voice, collaborative canvas) would kick adoption off.

## How to resume work

### Fresh Claude Code session
```bash
cd /Users/derekxwang/Development/incubator/RxWeave/rxweave
claude
# Then: "Read docs/HANDOFF.md and the spec, then tell me what to do next."
```

The auto-memory system already loads the project-specific feedback (cmux agent team flag, CLI is for AI agents) automatically.

### Resume a prior Team RX / Team CLOUD session
Those sessions are saved on disk.
```bash
cd /Users/derekxwang/Development/incubator/RxWeave/rxweave
claude --continue    # resumes the most recent session in this cwd
# or: claude --resume    # picks from a list
```
Same from `cloud/`.

### cmux panel for parallel team work
When a future sprint needs parallel teams again:
```bash
cmux new-pane --direction right --workspace workspace:4
cmux send --surface <id> "cd /Users/derekxwang/Development/incubator/RxWeave/<repo> && claude --dangerously-skip-permissions \"<briefing prompt>\""
cmux send-key --surface <id> Enter
```
The `--dangerously-skip-permissions` preference is saved in memory — always include it for agent-team panels.

## References

- Design spec: `docs/superpowers/specs/2026-04-18-rxweave-design.md`
- Implementation plans: `docs/superpowers/plans/2026-04-18-rxweave-v01-local-stack.md`, `docs/superpowers/plans/2026-04-18-cloud-v01-and-store-cloud.md`
- CHANGELOG: `CHANGELOG.md` (v0.1.0, v0.2.0) + `git tag -n v0.2.1` for the latest
- Knowledge files (cross-project): `github.com/Derek-X-Wang/skills` — `repo-knowledge-share/knowledge/{rxweave,rxweave-cloud}.md`
- Cloud-specific handoff: `../cloud/docs/HANDOFF.md` (private repo — dev URL + cloud roadmap there)
