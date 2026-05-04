# RxWeave — Handoff

**Last updated:** 2026-05-04 after v0.5.1 ship to npm.
**Integration state:** 226 tests (11 packages) + 12 conformance passing. All 11 `@rxweave/*` packages live on npm at v0.5.1 (Trusted Publishing via tag push, verified `bun add @rxweave/cli@0.5.1` in a fresh `/tmp` dir → `bunx rxweave --version` → `0.5.1`). Cross-repo browser-streaming end-to-end verified against cloud-v0.3.0 dev deployment (`https://giant-caribou-833.convex.site`): low-level cadence probe shows 9 heartbeats / 10 s @ `intervalMs=1000` (server-clock gaps locked at 1002–1003 ms), and the `@rxweave/store-cloud` conformance suite is 52/52 green against live cloud (12 conformance + 11 Auth + 29 unit). v0.5.0's manual Safari smoke through cmux WKWebView remains valid for the rxweave-side path (`@rxweave/server` `dist/index.js` is byte-identical between v0.5.0 and v0.5.1).
**Read this first** if you're resuming work on RxWeave — in a fresh Claude Code session, from a different machine, or as a new contributor.

---

## What shipped

| Tag | Scope | Date |
|---|---|---|
| `v0.0.1-contract` | `@rxweave/schema` + `@rxweave/protocol` + `@rxweave/core` tags + types (no Live layers) — contract freeze that unblocked parallel work | 2026-04-18 |
| `v0.1.0` | Local stack: `store-memory`, `store-file`, `reactive`, `runtime`, `cli`, `apps/dev`. CLI compiled to single Bun binary. | 2026-04-18 |
| `v0.2.0` | `store-cloud` client adapter + `system.agent.heartbeat` emitter | 2026-04-18 |
| `v0.2.1` | Codex-review patches: polling-safe `Subscribe`, `QueryAfter` RPC, retry classification, digest memoization | 2026-04-19 |
| `v0.3.0` | `@rxweave/llm` — LLM-backed agents via Vercel AI SDK. Publishing infra: changesets, LICENSE, npm metadata, `workspace:^` refs | 2026-04-19 |
| `v0.4.0` | CLI + unified stream server: `@rxweave/server` (embeddable HTTP RPC over NDJSON, same wire as cloud), shared protocol handlers, `rxweave serve / import / cursor`, `stream --count|--last|--fold`, `agent run`→`exec`, `apps/canvas`→`apps/web` with embedded-server bridge, cookbooks, reliability tests. **Broken on npm** — see "Release pipeline gotchas" below. | 2026-04-22 |
| `v0.4.1` | Publish-pipeline fix: rewrite `"workspace:^"` → `"^<version>"` before `changeset publish`. Same code as 0.4.0, actually installable. | 2026-04-23 |
| `v0.5.0` | Browser streaming: protocol-level heartbeat sentinel (`Heartbeat` variant in Subscribe response union), `CloudStore.LiveFromBrowser({ origin, tokenPath?, heartbeat? })`, `drainBeforeSubscribe` via QueryAfter pagination, per-fiber liveness watchdog with first-heartbeat arming + reconnect from last-delivered cursor. `EventRegistry.registerAll(defs, { swallowDuplicates })` helper. `mkdirSync` folded into `generateAndPersistToken`. `apps/web` canvas schemas relocated from `server/` to `src/shared/`. WebKit fetch-buffer fix end-to-end (Safari works). Caught one ship-blocker during the WKWebView smoke: `sessionTokenFetch` did `text().trim()` on `/rxweave/session-token` but the endpoint returns `{ token: "..." }` JSON — fixed in `f21ad6e`, unit-test mocks updated to use the actual JSON shape. | 2026-04-30 |
| `v0.5.1` | Patch: promote `@rxweave/core` from devDep to runtime dep of `@rxweave/protocol` (`c8c36eb`). Fixes `Could not resolve "@rxweave/core"` errors when external consumers (esbuild via Convex) bundle protocol standalone — caught by team-cloud during cloud-v0.3 work. In-monorepo workspace consumers were unaffected; bun/npm workspace dedupe masked the misclassification. Behavioral diff zero; `dist/index.js` byte-identical to v0.5.0. CI release `25312147497` validated the bumped 10×15 s smoke retry budget (`3cc9f14`) — first run with the new budget, smoke step passed first-try, end-to-end 1 m 32 s. | 2026-05-04 |

**v0.5.1 is the current npm install target** (verified `bun add @rxweave/cli@0.5.1` in a fresh `/tmp` dir; `bunx rxweave --version` → `0.5.1`). v0.5.0 is functionally equivalent for in-monorepo workspace consumers but breaks for external bundlers — see "Shipped in v0.5.1" below. All prior versions v0.1.0–v0.4.0 shipped with `workspace:^` in their `dependencies` (broken on `bun add @rxweave/cli` in a fresh dir). Per-user note from earlier: `npm deprecate` of v0.1.0–v0.5.0 is intentionally deferred — solo author, no external users today.

## Key design decisions (locked; do not relitigate without cause)

These are the eight architectural calls that shape the whole project. All are in the design spec (`docs/superpowers/specs/2026-04-18-rxweave-design.md`) with rationale.

1. **Scope C** — rxweave is OSS, cloud is optional/private. Cloud depends on `@rxweave/protocol`; rxweave has zero cloud deps. One-way dep graph, enforced.
2. **Schema registry (B)** — every event type is declared via `defineEvent(type, payloadSchema)`. Emitting an unregistered type is a tagged runtime error.
3. **Storage A3+R3** — pluggable `EventStore` Context.Tag; cursor-based exclusive subscribe is the primitive. ULID as event id.
4. **Stream-first reactive (A)** — Effect `Stream` directly, no custom DSL. Push-down filter at the subscribe boundary.
5. **Declarative agents (D)** — `defineAgent({id, on, handle | reduce})`. Runtime owns cursor persistence per id + provenance stamping on emits. `FiberMap` keyed by id.
6. **Semantic events = agents (A) + L2 lineage** — derivations are agents that emit events. Optional `causedBy: EventId[]` auto-stamped when emit happens inside `handle(trigger)`.
7. **Kitchen-sink AI-first CLI (C+C1)** — NDJSON stdout default, tagged-error NDJSON stderr, exit codes 0–6, no prompts. Config via `rxweave.config.ts`.
8. **`@effect/rpc` RpcGroup in `@rxweave/protocol` owned by rxweave (P3+S1)** — cloud implements handlers AND local `@rxweave/server` mounts the same RpcGroup. Bearer-token auth or no-auth (embedded loopback).

## Tooling baseline

- Bun 1.3.5 (pinned in root `packageManager`)
- Effect 3.21.x
- `@effect/rpc` 0.75.x (NDJSON transport, streaming responses)
- `@effect/platform` 0.96.x, `@effect/platform-bun` 0.89.x
- TypeScript 5.9.x
- Turborepo 2.9.x
- Vitest 2.1.x + `@effect/vitest` 0.17.x
- oxlint 0.13.x
- ESM-only — no CJS, no dual builds
- `@noble/hashes` for V8-isolate-safe sha256 (schema is portable across Node/Bun/browsers/Convex)

## Sub-project status (all at v0.5.1 — npm + workspace)

| Package | Tests | Notes |
|---|---|---|
| `@rxweave/schema` | 40 (5 files) | `EventInput` wire-safe Struct, `EventEnvelope` Class. ActorId regex, digest memoized, `registerAll(defs, { swallowDuplicates })` helper for batch registration with digest-aware duplicate handling. |
| `@rxweave/core` | 1 + 10 conformance | `EventStore` tag; `queryAfter` for exclusive-cursor paging. |
| `@rxweave/store-memory` | 12 | `PubSub.sliding(1024)` fan-out; snapshot-then-live under `Semaphore(1)`. |
| `@rxweave/store-file` | 16 | JSONL + fsync + cold-start recovery (truncate torn tail, skip interior corruption). |
| `@rxweave/store-cloud` | 40 + 1 skipped integration | `CloudStore.Live` + `CloudStore.LiveFromBrowser({ origin, tokenPath?, heartbeat? })`: session-token bootstrap, QueryAfter drain, heartbeat sentinel (15s default), per-fiber watchdog (first-heartbeat arm + reconnect from lastDelivered). |
| `@rxweave/reactive` | 3 | `whereType`, `byActor`, `bySource`, `withinWindow`, `decodeAs`. |
| `@rxweave/runtime` | 12 | `defineAgent`, `supervise` (`FiberMap`), `AgentCursorStore.Memory` + `.File` (fsync per `set()`), `withIdempotence`. |
| `@rxweave/llm` | 4 | `defineLlmAgent` wraps `defineAgent`. `tool()` helper → Schema → JSON Schema. Vercel AI SDK backend; tools return `EventInput[]`; multi-step via `stepCountIs`. |
| `@rxweave/protocol` | 28 | `RxWeaveRpc` RpcGroup; shared handlers including `subscribeHandler` (heartbeat injection via `intervalMs`); `Heartbeat` sentinel in Subscribe response union; `Paths`. |
| `@rxweave/server` | 21 bun + 12 conformance | Embeddable HTTP NDJSON server on Bun. Ephemeral `rxk_<hex>` token at `.rxweave/serve.token` (0600). `mkdirSync` now in `generateAndPersistToken`. `/rxweave/session-token` loopback bootstrap. `--host 0.0.0.0 --no-auth` interlock. |
| `@rxweave/cli` | 36 | `init`, `serve`, `dev`, `emit`, `import`, `stream`, `get`, `inspect`, `cursor`, `schema`, `agent`. BunRuntime.runMain entry. |

Workspace apps (private, not published):
- `apps/web/` (formerly `apps/canvas/`) — the canvas demo. Embeds `@rxweave/server`; browser bridge runs `CloudStore.LiveFromBrowser`. Schemas relocated to `src/shared/`. Bundle 658.2 KB gzip.
- `apps/dev/` — agent playground, LLM agent demo at `apps/dev/agents/llm-task-from-speech.ts`.

## Immediate pending (carry into the next session)

1. *(empty)* — the v0.5.0 cloud-v0.3 adoption item and the v0.5.1 CI smoke retry budget validation both shipped this cycle. See "Shipped in v0.5.1" below.

### Carried-over from prior HANDOFF (still applicable, lower priority)

2. **Manual Safari smoke** — *passed for v0.5.0 via cmux WKWebView*. Repeat for the next release that touches the browser path. The cmux-browser skill is the right tool: `cmux browser open http://localhost:5173/` then probe via `cmux browser surface:N eval "..."` against `/rxweave/session-token` + `/rxweave/rpc` (no trailing slash, `Content-Type: application/ndjson`, `Content-Length` set, body is a single `Request` line + `\n`).

3. **`npm deprecate` of v0.1.0–v0.5.0** — solo-author note: skip until external users exist. v0.5.0 specifically breaks for external bundlers (no `@rxweave/core` runtime dep) — fixed in v0.5.1; deprecate when an external user reports.

## Shipped in v0.5.1

1. **`@rxweave/protocol` packaging fix** — `@rxweave/core` promoted from devDependency to runtime dependency in `packages/protocol/package.json` (`c8c36eb`). Bug surfaced when team-cloud bundled `@rxweave/protocol@0.5.0` standalone via Convex/esbuild and got `Could not resolve "@rxweave/core"` — the published `dist/index.js` imports `EventStore` from `@rxweave/core` at module load (the handlers, all re-exported through the main entry, depend on the `EventStore` `Context.Tag`). In-monorepo workspace consumers never noticed because workspace dedupe resolves from root `node_modules` regardless. Behavioral diff is zero — `dist/index.js` is byte-identical to v0.5.0; only `package.json#dependencies` changes.

2. **cloud-v0.3 heartbeat adoption (cross-repo)** — listed as "Immediate pending #1" in the prior HANDOFF. Shipped as `cloud-v0.3.0`. Architectural insight worth carrying forward when designing future RPCs: `@effect/rpc`'s `RpcServer.toWebHandler` ↔ Convex V8-isolate `ReadableStream` conversion empirically collapses the response stream after the first chunk frame, and the rxweave-side conformance suite didn't catch it because each conformance case fits in one chunk. Cloud's resolution is a hand-rolled Subscribe handler that bypasses `@effect/rpc` for that one RPC while every other RPC still routes through `@effect/rpc`. Verified from rxweave-side end-to-end against the live dev deployment: cadence probe 9 heartbeats / 10 s @ `intervalMs=1000` (server-clock gaps 1002–1003 ms), `@rxweave/store-cloud` conformance 52/52 green. Deep dive — including the routing decision, wire-shape compatibility, and full bypass rationale — lives in `cloud/docs/HANDOFF.md` "Project memory: @effect/rpc bypass".

## Shipped in v0.5.0 (formerly "Deferred follow-ups")

These items were listed as "Deferred follow-ups" for v0.5.0 in the prior HANDOFF. All shipped:

1. **Server-side NDJSON heartbeat** — `Heartbeat` sentinel in Subscribe response union; `subscribeHandler` injects at configurable `intervalMs`; `CloudStore.Live` and `LiveFromBrowser` filter sentinels before user-facing stream.
2. **`EventRegistry.registerAll(defs, { swallowDuplicates })`** — helper in `packages/schema/src/Registry.ts`; all four hand-rolled loop sites converted.
3. **`mkdirSync` folded into `generateAndPersistToken`** — callers in CLI `serve.ts` and `apps/web/server/server.ts` drop the boilerplate pre-step.
4. **`CloudStore.LiveFromBrowser`** — reusable drain-then-subscribe-with-watchdog factory in `@rxweave/store-cloud`; `apps/web` bridge converted.
5. **Canvas schemas relocated** — moved from `apps/web/server/` to `apps/web/src/shared/`, removing the browser/server source boundary crossing.

## Release pipeline — gotchas (hard-won)

Three subtle bugs bit v0.4.0 → v0.5.0. Document all so the next release doesn't re-hit them.

### 1. `corepack prepare npm@11.5.1 --activate` does not actually activate npm on GitHub Actions Ubuntu runners.

Observed: `corepack prepare --activate` logs `Preparing npm@11.5.1 for immediate activation...` but `npm --version` in the same step still reports 10.9.7. Corepack's shim at `/usr/local/bin/npm` loses the PATH lookup to `actions/setup-node`'s `/opt/hostedtoolcache/node/22.22.2/x64/bin/npm`. Trusted Publishing requires ≥11.5.1; npm 10.9.7 silently falls back to NODE_AUTH_TOKEN, which is unset → uniform `E404 Not Found - PUT` across all packages.

**Fix (shipped in `f1f1c7d`):** install to a user prefix instead of self-replacing:
```yaml
- name: Install npm >= 11.5.1 (user-prefix to avoid self-replace)
  run: |
    npm config set prefix "$HOME/.npm-global"
    npm install -g npm@11.5.1
    echo "$HOME/.npm-global/bin" >> "$GITHUB_PATH"
- name: Verify npm version
  run: |
    which npm
    npm --version
```
npm 10.9.7 writes 11.5.1 into a fresh dir (no self-replace = no `promise-retry` MODULE_NOT_FOUND that `npm install -g npm@latest` hits), and `$GITHUB_PATH` makes subsequent steps resolve npm 11.5.1. Do not delete the verify step — it's the only proof the activation worked.

### 2. `bunx changeset publish` does NOT convert `workspace:^` refs.

`changeset publish` enters each package dir and runs `npm publish` there. npm's built-in workspace-protocol conversion only kicks in when publishing from the workspace root with `-w <pkg>`, so from a sub-package dir the `workspace:^` strings round-trip unchanged into the tarball. Consumers then fail on `bun add @rxweave/cli` with `workspace:^ failed to resolve`. **This bug shipped in v0.1.0 through v0.4.0** — nobody caught it because in-repo tests pass (the protocol resolves fine inside a workspace) and the packages had ~50 weekly downloads at the time.

**Fix (shipped in `98c019d`):** pre-rewrite the refs before publish:
```yaml
- name: Rewrite workspace:^ to actual version
  run: |
    VERSION=$(node -p "require('./packages/cli/package.json').version")
    for f in packages/*/package.json; do
      sed -i 's/"workspace:\^"/"^'"$VERSION"'"/g' "$f"
    done
    if grep -l '"workspace:\^"' packages/*/package.json; then
      echo "::error::workspace:^ references remain after rewrite" >&2
      exit 1
    fi
```
The grep guard fails the workflow loudly if any reference survives — never ship a broken tarball again. The monorepo is version-locked (all `@rxweave/*` share one version), so a single substitution is safe.

### 3. npm registry propagation outpaces a 50 s smoke retry budget.

Observed v0.5.0: the publish step succeeded (all 11 packages were on npm), but the post-publish smoke step's `bun add @rxweave/cli@0.5.0` retry loop (5 attempts × 10 s sleep = 50 s) exhausted before propagation finished. A manual `bun add` from `/tmp` ~3 minutes post-publish succeeded on the first try. The publish was fine; the smoke budget was too tight.

**Fix (shipped in `3cc9f14`):** budget is now 10 attempts × 15 s = 150 s. That's still well under the Trusted Publishing OIDC token TTL and avoids burning a full hour on a stuck workflow. **Validated by v0.5.1 (CI run `25312147497`, end-to-end 1 m 32 s, smoke step exited clean on the first attempt)** — the bumped budget is sufficient.

### 4. First-time publish of a new package needs bootstrapping before Trusted Publishing can take over.

`@rxweave/server` is new in v0.4.0. npm's TP config is per-package, which means a brand-new package with no prior publish has no TP settings page — no way to point TP at the workflow. The first publish fails with `could not be found or you do not have permission to access it` (not a 404; a TP-rejection).

**Recovery path (one-time per new package):**
1. `cd packages/<newpkg> && bun run build && npm publish --access public` from local, with 2FA OTP.
2. After first publish succeeds, go to `npmjs.com/package/@rxweave/<newpkg>` → Settings → Trusted Publisher → add `Derek-X-Wang/rxweave` + `release.yml`.
3. Future CI releases via tag push work unchanged.

## How to resume work

### Fresh Claude Code session
```bash
cd /Users/derekxwang/Development/incubator/RxWeave/rxweave
claude
# Then: "Read docs/HANDOFF.md and the implementation plans, then tell me what to do next."
```

Auto-memory already loads project-specific feedback (cmux agent team flag, CLI-is-for-AI-agents).

### Resume a prior session
```bash
cd /Users/derekxwang/Development/incubator/RxWeave/rxweave
claude --continue    # resumes the most recent session in this cwd
# or: claude --resume    # picks from a list
```

### cmux panel for parallel team work
```bash
cmux new-pane --direction right --workspace workspace:4
cmux send --surface <id> "cd /Users/derekxwang/Development/incubator/RxWeave/<repo> && claude --dangerously-skip-permissions \"<briefing prompt>\""
cmux send-key --surface <id> Enter
```
The `--dangerously-skip-permissions` preference is saved in memory — always include it for agent-team panels.

## References

- Design spec: `docs/superpowers/specs/2026-04-18-rxweave-design.md`
- Browser streaming spec: `docs/superpowers/specs/2026-04-25-browser-streaming-design.md`
- v0.5 implementation plan: `docs/superpowers/plans/2026-04-25-browser-streaming-plan.md`
- v0.4 implementation plan (fully executed): `docs/superpowers/plans/2026-04-20-cli-agent-collaboration-plan.md`
- v0.1 local stack plan: `docs/superpowers/plans/2026-04-18-rxweave-v01-local-stack.md`
- Cloud plan: `docs/superpowers/plans/2026-04-18-cloud-v01-and-store-cloud.md`
- CHANGELOG: `CHANGELOG.md` (every version from v0.1.0 onwards)
- Cookbook: `docs/cookbook/cursor-recovery.md`, `docs/cookbook/backup-restore.md`
- Knowledge files (cross-project): `github.com/Derek-X-Wang/skills` — `repo-knowledge-share/knowledge/{rxweave,rxweave-cloud}.md`
- Cloud-specific handoff: `../cloud/docs/HANDOFF.md` (private repo)
