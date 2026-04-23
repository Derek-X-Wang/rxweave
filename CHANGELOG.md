# Changelog

## v0.4.0

CLI + unified stream server release. Ships the local counterpart to RxWeave Cloud: the same `@effect/rpc` protocol over NDJSON, just bound to `127.0.0.1` instead of a hosted URL. Agents speak one protocol regardless of where the stream lives.

- **New package `@rxweave/server`** — embeddable local HTTP event-stream server. Hosts `@rxweave/protocol`'s RpcGroup over NDJSON on Bun, mints an ephemeral `rxk_<hex>` bearer token per boot (persisted to `.rxweave/serve.token` at 0600), exposes a `/rxweave/session-token` loopback endpoint so browser code can bootstrap without shipping the token in the bundle. Hardens `--host 0.0.0.0 --no-auth` as a CLI-layer interlock (refuses to bind).
- **Shared handlers in `@rxweave/protocol`** — `packages/protocol/src/handlers/` now exports `appendHandler`, `subscribeHandler`, `getByIdHandler`, `queryHandler`, `queryAfterHandler`, `registrySyncDiffHandler`, `registryPushHandler`. Cloud and local servers call the same code; conformance harness runs against both.
- **`@rxweave/store-cloud` token optional** — browser-on-localhost embedded path works without a bearer header.
- **`@rxweave/schema` ActorId validation** — regex `/^[a-zA-Z0-9_.-]+(:[a-zA-Z0-9_.-]+)?$/` enforced at `decodeUnknown`, with structured `{_tag: "InvalidActorId", reason}` errors on failure.
- **CLI additions:**
  - `rxweave serve` — bind the local HTTP RPC server.
  - `rxweave import <file>` — bulk-load events from NDJSON / JSON array, `--dry-run` for validation-only.
  - `rxweave cursor` — print current head cursor (empty string when store is empty).
  - `rxweave stream --count` — print match count and exit.
  - `rxweave stream --last N` — print the last N matches.
  - `rxweave stream --fold <name>` — print the projected state from a named fold; ships with `canvas` built in, custom folds loaded from config.
- **CLI renames:** `agent run` → `agent exec`. The old name continues to work this release; `run` is removed in v0.5.
- **CLI drops:** top-level `count`, `last`, `head`, `store` commands — subsumed by `stream` flags.
- **`apps/canvas` → `apps/web`** — the canvas demo now embeds `@rxweave/server` + the browser bridge runs `@rxweave/store-cloud` over NDJSON RPC. Same wire as cloud, same conformance gate. Bundle: 658.9 KB gzip (within spec §11's 200 KB growth budget).
- **Cookbooks** — `docs/cookbook/cursor-recovery.md` (resume agents from a saved cursor) and `docs/cookbook/backup-restore.md` (local stream file round-trip).
- **Reliability gates** — spec §11 tests in `packages/server/test/`: client-crash + resume (strict cursor-exclusive semantics; no gaps, no dupes) and server-restart recovery (FileStore round-trip across a process boundary). Plus an HTTP subscribe replay→live regression test that fills a gap the conformance harness skipped.
- **WebKit fetch-buffer workaround** — the `apps/web` bridge uses a two-phase drain (paginated `queryAfter` for history, then `subscribe` from the last-drained cursor) because Safari/WebKit's `fetch` reader buffers aggressively after a replay burst. Bun, Node, and Chrome-family browsers aren't affected; the workaround is isolated to the app. Sustained cross-tab live sync in WebKit still needs a server-side NDJSON heartbeat — deferred.

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
