# RxWeave — Handoff

**Last updated:** 2026-04-23 after v0.4.1 ship.
**Integration state:** 31 server tests + 22 turbo tasks green at 0.4.1. All 11 `@rxweave/*` packages on npm, installable from a fresh dir (smoke-verified).
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

**v0.4.1 is the recommended install target.** All prior versions shipped with `workspace:^` in their `dependencies` (broken on `bun add @rxweave/cli` in a fresh dir). Deprecation via `npm deprecate` across 0.1.0 – 0.4.0 is the one remaining post-ship step that needs the user's 2FA.

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

## Sub-project status (all at v0.4.1)

| Package | Tests | Notes |
|---|---|---|
| `@rxweave/schema` | ✓ | `EventInput` wire-safe Struct, `EventEnvelope` Class. ActorId regex (`^[a-zA-Z0-9_.-]+(:[a-zA-Z0-9_.-]+)?$`), digest memoized, canvas `defineEvent` schemas registered by both bridge + server for digest-parity. |
| `@rxweave/core` | ✓ conformance harness (10 cases) | `EventStore` tag; `queryAfter` for exclusive-cursor paging. |
| `@rxweave/store-memory` | 12 | `PubSub.sliding(1024)` fan-out; snapshot-then-live under `Semaphore(1)`. |
| `@rxweave/store-file` | 16 | JSONL + fsync + cold-start recovery (truncate torn tail, skip interior corruption). |
| `@rxweave/store-cloud` | 22 + 1 skipped integration | Bearer token optional (embedded no-auth path); NDJSON over `@effect/rpc`; retry classification; polling-safe Subscribe. |
| `@rxweave/reactive` | 3 | `whereType`, `byActor`, `bySource`, `withinWindow`, `decodeAs`. |
| `@rxweave/runtime` | 12 | `defineAgent`, `supervise` (`FiberMap`), `AgentCursorStore.Memory` + `.File` (fsync per `set()`), `withIdempotence`. |
| `@rxweave/llm` | 4 | `defineLlmAgent` wraps `defineAgent`. `tool()` helper → Schema → JSON Schema. Vercel AI SDK backend; tools return `EventInput[]`; multi-step via `stepCountIs`. |
| `@rxweave/protocol` | 12 | `RxWeaveRpc` RpcGroup; shared handlers (`appendHandler`, `subscribeHandler`, `getByIdHandler`, `queryHandler`, `queryAfterHandler`, `registrySyncDiffHandler`, `registryPushHandler`); `Paths` (`RXWEAVE_RPC_PATH`, `SESSION_TOKEN_PATH`). |
| `@rxweave/server` | 19 bun + 12 conformance | Embeddable HTTP NDJSON server on Bun. Ephemeral `rxk_<hex>` token at `.rxweave/serve.token` (0600). `/rxweave/session-token` loopback bootstrap. `--host 0.0.0.0 --no-auth` interlock. |
| `@rxweave/cli` | 35 | `init`, `serve`, `dev`, `emit`, `import`, `stream`, `get`, `inspect`, `cursor`, `schema`, `agent`. BunRuntime.runMain entry. |

Workspace apps (private, not published):
- `apps/web/` (formerly `apps/canvas/`) — the canvas demo. Embeds `@rxweave/server`; browser bridge runs `@rxweave/store-cloud` over NDJSON RPC. Bundle 658.9 KB gzip.
- `apps/dev/` — agent playground, LLM agent demo at `apps/dev/agents/llm-task-from-speech.ts`.

## Immediate pending (carry into the next session)

1. **Run `npm deprecate` loop** to mark v0.1.0 – v0.4.0 as broken with a pointer at 0.4.1+. Requires 2FA per package. CHANGELOG v0.4.1 already promises this; just needs the commands executed:
    ```bash
    for pkg in cli core llm protocol reactive runtime schema server store-cloud store-file store-memory; do
      npm deprecate "@rxweave/$pkg@<=0.4.0" "workspace:^ refs shipped verbatim; use 0.4.1+"
    done
    ```
    (`@rxweave/server`'s only old version is 0.4.0 — the manual-bootstrap publish I did before TP took over. That one was actually built correctly because I rebuilt dist locally, but deprecating it keeps the "only 0.4.1+" message consistent.)

2. **Fix the stale `rxweave 0.1.0` string** in the CLI's `--help` banner. Hardcoded constant, not tracking the actual package version. Spotted during the v0.4.1 smoke test. Small fix, probably in `packages/cli/src/bin/rxweave.ts` or similar.

3. **Add a post-publish smoke test** to `.github/workflows/release.yml`: after `bunx changeset publish`, spin up a fresh `/tmp` dir, `bun add @rxweave/cli@<new-version>`, and run `bunx rxweave serve --help`. Catches the next `workspace:^`-class regression in CI instead of by users. 10-line addition.

## Deferred follow-ups (v0.5 / Phase I candidates)

Explicitly named in Phase F, G, H CHANGELOG entries as "deferred." In rough priority order:

1. **Server-side NDJSON heartbeat** on the `Subscribe` response so WebKit's `fetch` reader receives sustained live events after a large replay burst. Today the `apps/web` bridge's two-phase drain handles refresh-state + the FIRST live event, but subsequent trickle events stay stuck in WebKit's fetch buffer. Bun, Node, and Chrome-family browsers aren't affected. **Protocol-level change** — needs `Subscribe`'s `success` schema widened to accept either `EventEnvelope` or a sentinel, plus client-side filter. Medium effort.
2. **`EventRegistry.registerAll(defs)` helper** — 4 sites (`apps/web` server + bridge, `packages/cli/src/commands/dev.ts`, `packages/cli/src/Setup.ts`) each hand-roll `for (const def of schemas) yield* reg.register(def)`. Single helper in `packages/schema/src/Registry.ts`, optional `swallowDuplicates` flag for the browser-remount case. Small.
3. **Fold `mkdirSync(dirname(tokenFile), { recursive: true })` into `generateAndPersistToken`** — CLI `serve.ts` and `apps/web/server/server.ts` both hand-roll the parent-dir pre-step. Move into `packages/server/src/Auth.ts`, callers drop the boilerplate. Small.
4. **`CloudStore.LiveFromBrowser({ origin, tokenPath })`** + reusable drain-then-subscribe helper in `@rxweave/store-cloud`. Moves the WebKit workaround from `apps/web/src/RxweaveBridge.tsx` into the reusable library. Ships after #1 (the heartbeat) for complete browser story. Medium.
5. **Move canvas schemas out of `apps/web/server/`** — the bridge imports `../server/schemas.js`, crossing the browser/server source boundary. Cosmetic; relocate into `apps/web/src/shared/` or similar. Trivial.

## Release pipeline — gotchas (hard-won)

Two subtle bugs bit v0.4.0 before v0.4.1 unstuck them. Document both so the next release doesn't re-hit them.

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

### 3. First-time publish of a new package needs bootstrapping before Trusted Publishing can take over.

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
- v0.4 implementation plan (mostly executed, Phase H done): `docs/superpowers/plans/2026-04-20-cli-agent-collaboration-plan.md`
- v0.1 local stack plan: `docs/superpowers/plans/2026-04-18-rxweave-v01-local-stack.md`
- Cloud plan: `docs/superpowers/plans/2026-04-18-cloud-v01-and-store-cloud.md`
- CHANGELOG: `CHANGELOG.md` (every version from v0.1.0 onwards)
- Cookbook: `docs/cookbook/cursor-recovery.md`, `docs/cookbook/backup-restore.md`
- Knowledge files (cross-project): `github.com/Derek-X-Wang/skills` — `repo-knowledge-share/knowledge/{rxweave,rxweave-cloud}.md`
- Cloud-specific handoff: `../cloud/docs/HANDOFF.md` (private repo)
