# Changelog

## v0.3.0

First public npm release. All packages published at `0.3.0` under the `@rxweave` scope.

- **New package `@rxweave/llm`** — LLM-backed agents via Vercel AI SDK. `defineLlmAgent` wraps `defineAgent` with a model + systemPrompt + tools config; tools carry Effect-Schema-validated args and return `EventInput[]`, which `supervise` stamps with `causedBy` the same way as hand-coded agents. Multi-step tool calling via `stopWhen: stepCountIs(5)` default.
- **Publishing infrastructure** — `changesets` for future coordinated releases, LICENSE files per package, npm metadata (description, repository, homepage, bugs, keywords, author) on all ten packages, per-package READMEs pointing back to the monorepo.
- **Workspace deps** — `workspace:*` migrated to `workspace:^` so published packages resolve to caret ranges on install.
- Demo — `apps/dev/agents/llm-task-from-speech.ts` shows the LLM pattern replacing the hardcoded trigger-word scan in the existing `task-from-speech.ts` (opt-in; requires `ANTHROPIC_API_KEY`).

## v0.2.0

Team CLOUD release. Ships:

- `@rxweave/store-cloud` — new package. `Live.Cloud` adapter over `@effect/rpc` with bearer-token auth, NDJSON HTTP transport, and reconnect-with-cursor subscription (exclusive cursor → no duplicates or gaps on retry).
- `@rxweave/schema` — new event type `system.agent.heartbeat` (`SystemAgentHeartbeat` export). Canonical registration point for runtime→cloud agent liveness signals.
- `@rxweave/runtime` — `supervise()` now forks a heartbeat fiber that emits `system.agent.heartbeat` per running agent every 10 seconds. Failures are swallowed (best-effort). Uses `Clock.currentTimeMillis` so tests driven by `TestClock` are deterministic.

## 0.1.0 (unreleased)

First public release. Ships:

- `@rxweave/schema` — event envelope, `EventId`/`ActorId`/`Source`, ULID factory (Clock+Random), `EventRegistry` + `defineEvent` + `EventDefWire`, `Cursor` + `Filter`, tagged errors.
- `@rxweave/core` — `EventStore` service tag + conformance harness.
- `@rxweave/store-memory` — `Live.Memory` adapter.
- `@rxweave/store-file` — `Live.File` adapter with cold-start recovery.
- `@rxweave/reactive` — Stream helpers.
- `@rxweave/runtime` — `defineAgent`, `supervise` via `FiberMap`, `AgentCursorStore` (Memory + File), `withIdempotence`.
- `@rxweave/protocol` — `@effect/rpc` group frozen as the cloud contract.
- `@rxweave/cli` — `init`, `dev`, `emit`, `stream`, `get`, `inspect`, `count`, `last`, `head`, `schema`, `agent`, `store`. NDJSON default; structured errors; exit codes 0/1/2/3/4/5/6.
- `apps/dev` — three example agents (counter, echo, task-from-speech).
