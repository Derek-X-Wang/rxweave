# RxWeave CLI + Unified Stream Server — Design Spec

**Date:** 2026-04-20
**Status:** Brainstorming phase complete. Two Codex review passes incorporated (2026-04-20). Awaiting final user review of revised spec, then writing-plans.
**Authors:** Derek Wang + Claude (brainstorming session) with Codex (three independent reviews: CLI surface, then full-spec P0/P1/P2 pass, then second-pass verification)

**Builds on:** `2026-04-18-rxweave-design.md` (v0.1 + v0.2 shipped), the `@rxweave/llm` + canvas demo work (v0.3.0 shipped 2026-04-20).

---

## 1. Overview

The current state: `@rxweave/*` packages at v0.3.0 on npm; `apps/canvas/` is a working tldraw demo with a local HTTP server and an LLM suggester agent. The canvas server speaks a bespoke `/api/events` + `/api/subscribe` SSE protocol.

This spec replaces that per-app protocol with a single, reusable event-stream server and wires the CLI into it so AI agents (Claude Code and others) can read from and write to the same stream as the browser UI.

**The pitch being realised here:** everything becomes an event in a shared, observable stream; the CLI is the primary interface for AI-agent collaboration. A human in the browser and Claude Code in a terminal both participate in the same stream, both as first-class actors.

---

## 2. Principles

- **One protocol, one stream.** `@rxweave/protocol`'s RpcGroup is the canonical event transport — cloud speaks it, the new local server speaks it, clients don't care which they connect to.
- **Flat CLI verbs.** No `read` / `write` grouping. Verbs (`emit`, `stream`, `get`, `inspect`, `fold`, `import`) already convey direction. Matches ecosystem norms (`git`, `docker`, `kubectl`).
- **Directionality via the actor field.** Events from the human, from Claude, from an on-device agent are all indistinguishable at the protocol level — they differ only in the `actor` tag. Identity is data, not transport.
- **Embed or serve — not both.** Apps either embed `@rxweave/server` (integrated UX — one process, one port) or connect to an externally-running `rxweave serve` (third-party tools, separate processes). The library is the same; the difference is who starts it.
- **Agent-ergonomic defaults.** `RXWEAVE_URL`, `RXWEAVE_ACTOR`, `RXWEAVE_TOKEN` env contracts. No interactive prompts. NDJSON stdout, tagged errors on stderr. Exit codes match v0.1.

---

## 3. Architecture

### 3.1 New package — `@rxweave/server`

```
packages/server/
├── package.json                 # depends on @rxweave/core, @rxweave/protocol,
│                                # @rxweave/schema, effect, @effect/platform,
│                                # @effect/rpc, @effect/platform-bun (default host)
├── src/
│   ├── index.ts
│   ├── Server.ts                # startServer({ store, registry, port, host, auth })
│   ├── Auth.ts                  # Bearer-token middleware + single-tenant stub
│   └── Tenant.ts                # Context tag wiring for shared handlers
└── test/
    └── Server.test.ts           # conformance harness + auth smoke tests
```

**Public API:**

```ts
export const startServer: (opts: {
  readonly store: Layer.Layer<EventStore>
  readonly registry?: Layer.Layer<EventRegistry>   // default: EventRegistry.Live
  readonly port?: number                            // default: 5300
  readonly host?: string                            // default: "127.0.0.1"
  readonly auth?: {
    readonly bearer: ReadonlyArray<string>          // hashes of accepted tokens
  }
}) => Effect<void, ServerStartError, Scope>
```

**Responsibilities:**

- Mounts the `RxWeaveRpc` RpcGroup (from `@rxweave/protocol`) at `/rxweave/rpc/*` using `@effect/rpc` NDJSON transport.
- Single-tenant locally: all connections resolve to a synthetic `Tenant` identity so handler code (shared with cloud) works unchanged.
- Optional Bearer-token auth for LAN exposure.
- Schema registry is in-memory by default; applications embedding the server can pass a pre-populated `Layer` to bootstrap known schemas at startup.

**Non-responsibilities:**

- Does not own persistence. Any `EventStore` layer (`FileStore`, `MemoryStore`, `CloudStore`) can be passed in.
- Does not run agents. Agents are the embedder's concern; `supervise([...])` is a separate Effect forked in the embedder's scope.
- Does not manage users, quotas, or billing — localhost model is single-user.

**Handler convergence with cloud (P1 from Codex review):** the cloud server (Convex) has accumulated subtle handler logic — subscribe polling invariants, QueryAfter semantics — through bug fixes. Re-implementing independently in `@rxweave/server` invites drift. The convergence strategy for this spec:

- Extract runtime-agnostic portions into a new module `packages/protocol/src/handlers/` (part of `@rxweave/protocol`). These take an `EventStore` + `EventRegistry` service and produce RpcGroup handler implementations in pure Effect, no backend-specific APIs.
- `@rxweave/server` (Bun) imports them directly.
- Cloud (Convex) imports them where possible, wraps them in Convex's `ctx.db.query`/`ctx.runMutation` adapters where not.
- Convergence gate: both servers pass the 10-case conformance harness (already exists in `@rxweave/core/testing/conformance.ts`). Any divergence in semantics surfaces as a conformance failure.
- Cloud-specific concerns (tenant resolution, rate-limits) stay in the cloud repo; they're not part of the shared handlers.

### 3.2 Topology

```
┌────────────────────── @rxweave/server (embedded or standalone) ─────────────────────┐
│                                                                                      │
│   canvas.shape.*           agent.*           user.presence.*      voice.*            │
│   canvas.edge.*            system.*          user.focus.*         video.*            │
│   (today)                  (today)           (future)             (future)           │
│                                                                                      │
└───────────────────────────────▲──────────────────────────────────────────────────────┘
       emits / subs            │                    subs / emits
                               │
   ┌───────┬──────┬────────────┴───────┬──────────┬──────────────────┐
   │       │      │                    │          │                  │
   ▼       ▼      ▼                    ▼          ▼                  ▼
 canvas   voice  perception         rxweave    claude            other
 (apps/  (future) (future)            CLI      code              agents
  web)                             (any shell) (via CLI)          (MCP, etc.)
```

Every box above the line is an RPC client of the server — there's no distinction at the protocol layer between an in-browser tldraw bridge and a Claude Code session running CLI commands in a terminal. They read and write the same stream.

### 3.3 Canvas refactor — `apps/canvas/` → `apps/web/`

The canvas demo becomes the first integrated-product seed. Rename to `apps/web/` — future `apps/mobile/`, `apps/tui/`, etc. sit alongside; feature verticals (voice, video, perception) land inside `apps/web/` rather than as separate apps.

Changes:

- **`server.ts`** — replaces the manual `Bun.serve` + `/api/events` + `/api/subscribe` block with a `startServer()` call from `@rxweave/server`. Same port (5301), but now the RPC protocol. Suggester agent wiring unchanged.
- **`RxweaveBridge.tsx`** — `fetch POST` + `EventSource` are swapped for `@rxweave/store-cloud` configured with `url: "http://localhost:5301"`. The bridge's tldraw↔rxweave glue (`store.listen({source:"user"})` → `append`; SSE → `mergeRemoteChanges`) stays identical because `@rxweave/store-cloud` exposes the same `EventStore` service tag as the server side uses.
- **`@rxweave/store-cloud` API change (prerequisite):** the current API requires `token: () => string` — mandatory bearer header on every request. Change to `token?: () => string | undefined` so `Authorization` headers are only emitted when the provider returns a defined value. Minor breaking change for existing cloud consumers; source-compatible because they already pass tokens. Needed for the canvas browser to connect in either authed or unauthed mode without duplicate adapter code.
- **Browser-token bootstrap:** the embedded server exposes `GET /rxweave/session-token` — a single unauthenticated endpoint that returns `{"token": "rxk_..."}` if auth is on, or `{"token": null}` if `--no-auth`. The browser fetches this on startup, stores it in-memory (not localStorage), and passes to `CloudStore.Live` as `token: () => sessionToken`. Rationale: keeps the token out of Vite's bundle / DOM / localStorage / cookies — it only exists in the JS heap of the live session. A malicious same-origin page can't grab it from storage; a malicious subprocess reading `.rxweave/serve.token` still needs to already have local FS access (same threat model as the token file itself). The endpoint's lack of auth is intentional and scoped: it returns the same token to anyone reaching the embedded server on loopback, which is exactly the trust boundary the token defends.
- **Schemas, suggester agent, tldraw, React, Vite, dev workflow** — unchanged.

Browser bundle grows by `@rxweave/store-cloud` + its transitive Effect-rpc deps (estimate ~80-150 KB gzipped). Acceptable for the demo; to be measured against a budget (see §11).

---

## 4. CLI surface

Nine top-level commands plus two subcommand groups. Ordered by primary use case:

### 4.1 Setup / lifecycle

- **`rxweave init`** — scaffold `rxweave.config.ts`, `.rxweave/`, `.env.example`. Unchanged from v0.1.
- **`rxweave serve`** *(new)* — start a local `@rxweave/server` instance. Primitive, stable. Flags: `--port <n>` (default 5300), `--host <ip>` (default 127.0.0.1), `--store file|memory` (default file), `--path <file>` (default `./.rxweave/stream.jsonl`), `--no-auth` (explicit dev mode; otherwise a token is auto-generated — see §5.4), `--token <hash>` (use a caller-supplied token rather than auto-generated). Prints the URL + the recommended `RXWEAVE_URL` and `RXWEAVE_TOKEN` export lines on startup.
- **`rxweave dev`** — opinionated preset: `serve` + `supervise(config.agents)` + config hot-reload. Unchanged in semantics; now runs the unified server under the hood.

### 4.2 Writes

- **`rxweave emit <type>`** — append a single event. Flags: `--payload '<json>'`, `--actor <name>` (default from config or `RXWEAVE_ACTOR`). Prints the created event as JSON.
- **`rxweave import <file>`** *(new)* — apply events from NDJSON (`.jsonl`) or JSON array (`.json`). Flags: `--dry-run` (print what would be imported, don't write), `--actor <name>` (overrides actor in file entries). Events go through the same `Append` RPC as `emit`, so registry validation applies uniformly.

### 4.3 Reads

- **`rxweave stream`** — the read workhorse. Flags: `--types <t1,t2,...>`, `--actor <name>`, `--since <cursor>`, `--follow` (live tail, doesn't exit), `--limit <N>` (first N matching events, exits), `--last <N>` (last N matching events — replaces `--tail` for clarity, mirrors `--limit`), `--count` (terminal aggregation: emits `{"count": 42}` once and exits), `--fold <builtin|./reducer.ts>` (fold over events, emit final state as one JSON object).
- **`rxweave get <id>`** — single-event lookup by id. Frequent enough in agent workflows to deserve a dedicated command.
- **`rxweave inspect <id>`** — ancestry tree over `causedBy` edges. Flags: `--ancestry`, `--depth <N>` (default 3). Distinct from `get`: `get` = payload; `inspect` = provenance graph.
- **`rxweave cursor`** *(new)* — print the current head event-id as a single token. Lightweight; agents use it to establish `--since` baselines before doing work.

### 4.4 Introspection groups

- **`rxweave schema <list|show|validate>`** — unchanged from v0.1.
- **`rxweave agent <list|status|exec>`** — `run` renamed to `exec` to signal one-shot execution (vs. the managed lifecycle `dev` provides).

### 4.5 Dropped in this spec

- **`count`** — folded into `stream --count`.
- **`last`** — folded into `stream --last N`.
- **`head`** — folded into `stream --limit N`.
- **`store stats`** — no real standalone value once `rxweave serve`'s default store is well-documented.
- **`project`** — folded into `stream --fold <reducer>`. It's a fold over a filtered stream; composition with `--types` / `--since` is natural as a flag.

### 4.6 Agent-ergonomic grouping

`rxweave --help` groups commands by category (setup, writes, reads, introspection) in its output, but the CLI itself stays flat. No `rxweave read/write` nesting; verbs already convey direction and flat matches ecosystem norms.

---

## 5. Identity & config

### 5.1 Actor

- Type: branded string (`ActorId`). v0.3 schema is only `minLength(1)` — too permissive for the evolution path ahead.
- **New constraint (added by this spec):** `ActorId` pattern becomes `/^[a-zA-Z0-9_.-]+(:[a-zA-Z0-9_.-]+)?$/` — alphanum plus `_`, `.`, `-`, with one optional `:` separator reserved for the future `<user-id>:<agent-type>` convention. Reserved prefixes `human`, `system`, `rxweave` documented. Existing events are grandfathered (no migration required); new emits validate.
- v1 convention: free-form single tokens — `"human"`, `"claude-code"`, `"canvas-suggester"`, `"claude-reviewer"`.
- Sourced (per CLI invocation) from: `--actor` flag → `RXWEAVE_ACTOR` env → `defaultActor` in `rxweave.config.ts` → error if none.
- The canvas browser bridge stamps `actor: "human"` client-side on every emit. (In v1 localhost, the server can't distinguish clients; a `defaultActor` can be configured by the app. When cloud multi-user lands, the server will override client-supplied actors with a token-derived prefix per §5.2.)
- Server-side agents (like the suggester) stamp with their `agent.id` automatically via `supervise()`.

### 5.2 Multi-user identity (non-goal, evolution path)

- Not addressed in this spec.
- **Future direction:** when cloud multi-tenant lands, convention becomes `"<user-id>:<agent-type>"` e.g. `"derek:claude-code"`, `"derek:human"`, `"coworker:claude-code"`. The cloud server's Bearer-token → Tenant mapping supplies the `user-id` prefix; local mode stays unprefixed.
- No protocol changes required — `actor` is already a free-form string, so this is convention + cloud-side enforcement, not a schema migration.

### 5.3 Config & env

```ts
// rxweave.config.ts additions
defineConfig({
  store: ...,                    // unchanged
  agents: [...],                 // unchanged
  schemas: [...],                // unchanged
  defaultActor: "claude-code",   // NEW — default for emit/import when --actor unset
  serverUrl: "http://localhost:5300",  // NEW — default stream URL for read/write
})
```

Resolution order for URL: `RXWEAVE_URL` env → config `serverUrl` → `http://localhost:5300`.
For token: `RXWEAVE_TOKEN` env → config → auto-read from `.rxweave/serve.token` if present → none.

### 5.4 Auth (revised per Codex P1)

- **Default: on, with auto-generated ephemeral token.** `rxweave serve` generates a random 256-bit token at startup, writes it to `.rxweave/serve.token` with restrictive permissions (POSIX mode `0600`; on Windows, an ACL granting read/write only to the current user). If neither permission model can be applied, `rxweave serve` logs a warning and continues — best-effort file protection, not a hard gate. File added to `.gitignore` template by `rxweave init`. Server prints on startup:
  ```
  [rxweave] stream on http://localhost:5300
  [rxweave] export RXWEAVE_TOKEN=rxk_<hex>
  ```
  Rationale: any local process (including a malicious npm dep) can reach `127.0.0.1`. A write-capable event stream on the loopback interface is too open to default wide-open.
- **Explicit relaxed mode:** `rxweave serve --no-auth` skips token generation — for ephemeral dev sessions where the host is known-clean. Prints a warning at startup.
- **Fixed token:** `rxweave serve --token <hash>` uses a caller-supplied token (e.g. CI, shared dev envs).
- **Binding + auth interlock:** `127.0.0.1` default. `--host 0.0.0.0` requires auth to be on; the combo `--host 0.0.0.0 --no-auth` is an explicit startup error (no footgun).
- **Embedded mode (apps/web):** apps that embed `@rxweave/server` can pass `auth: { bearer: [hash(...)] }` at `startServer()` time, or read the ephemeral `.rxweave/serve.token` file for parity with the standalone `rxweave serve` UX. The canvas embedding reads the token file.
- **Client-side:** `RXWEAVE_TOKEN` env var adds `Authorization: Bearer ...`. With the `@rxweave/store-cloud` API change in §3.3 (token now optional), omitting the token = no Authorization header — which is how `--no-auth` server mode works end-to-end.

---

## 6. Schema registration

- Server starts with an empty `EventRegistry` (unless the embedder passes a pre-populated layer).
- **Required client behaviour (corrected per Codex P0):** clients call `registrySync({ push: [...mySchemas] })` explicitly on first connect, before any `Append`. The existing `@rxweave/store-cloud.append` path does **not** auto-retry on `AppendError.RegistryOutOfDate` — the helper in `@rxweave/store-cloud/src/RegistrySync.ts` is separate. Earlier spec text claiming auto-retry was wrong; correcting here. Explicit is the v1 contract.
- **Future enhancement (out of scope):** adding an auto-push-and-retry wrapper inside `CloudStore.append` would remove the need for explicit startup sync. Tracked as a follow-up; not required for this spec.
- **Observability requirement (per Codex P2 #6):** when the server rejects a duplicate registration with conflicting digests (`DuplicateEventType`), it MUST log at `warn` level with: event `type`, local digest, remote digest, and caller identity (actor if known, else source IP + user-agent). Accepted as a success-criteria gate in §11.
- **Pre-population at embed time:** apps embedding `@rxweave/server` can pre-populate the registry layer via `EventRegistry.Live.pipe(registerAll([...schemas]))` so the first `registrySync` push is a no-op and the server knows the full schema set from boot.

---

## 7. Agent collaboration workflow (illustrative)

```bash
# Human opens the integrated product — embeds @rxweave/server on :5301.
cd apps/web
bun run dev

# Terminal 2: Claude Code starts a collaboration session.
export RXWEAVE_URL=http://localhost:5301
export RXWEAVE_ACTOR=claude-code

# 1. Establish a baseline cursor so subsequent reads can skip replay.
cursor=$(rxweave cursor)

# 2. Read the canvas state. Built-in fold reduces canvas.* events to
#    a Map<shapeId, TLShape>. Dumps JSON on stdout.
rxweave stream --fold canvas

# 3. Live-tail further activity, filtered to human-authored shapes.
rxweave stream --follow --types canvas.shape.upserted --actor human &

# 4. Claude reasons over the current state (LLM call — not CLI).
#    Decides to add a note connecting two existing shapes.

# 5. Emit. Actor tag distinguishes Claude's contributions in the log
#    and optionally in the UI (different colour, etc.).
rxweave emit canvas.shape.upserted \
  --payload '{"record": { ...tldraw note record... }}'

# 6. (Optional) Trace what caused what.
rxweave inspect <event-id> --ancestry
```

Multi-agent is the same pattern with different `RXWEAVE_ACTOR` per session. Multi-user is the same pattern with a cloud URL and per-user tokens.

---

## 8. Testing

- **Conformance harness** (`@rxweave/core/testing/conformance.ts`, 10 cases) runs against `@rxweave/server` the same way it does against `store-memory` / `store-file` / `store-cloud`. Gate: 10/10 green.
- **Auth smoke tests** — `startServer({ auth: { bearer: [hash(...)] } })` rejects unauthenticated RPC calls with 401; accepts matching tokens.
- **CLI end-to-end** — a new test spawns `rxweave serve` in-memory as a subprocess, then exercises `rxweave import → stream --fold canvas → emit → inspect` through it.
- **Canvas refactor** — manual E2E: open `apps/web`, draw shapes, verify events land in `rxweave stream --follow` from another terminal, emit via CLI, verify the UI updates.

---

## 9. Non-goals (explicit)

- **Multi-user identity.** v1 stays constrained-but-free-form actor strings. Evolution path documented in §5.2.
- **Voice / video / perception event namespaces.** This spec delivers the transport. Domain schemas (`voice.*`, `video.*`, `user.presence.*`) get their own specs.
- **`rxweave replay <from> <to>`, `rxweave diff <a> <b>`, `rxweave drop --types ... --dry-run`.** Codex flagged these as genuinely useful; none are blocking CLI-agent collaboration. Parked — but see §9.1 for the recovery-docs obligation this creates.
- **MCP server / native Claude Code tools.** The CLI is sufficient for v1. If shell-out latency becomes a bottleneck, a thin MCP wrapper over the CLI's commands is a future add.
- **Auto-start-if-missing.** `rxweave stream` against a dead server returns a clean error rather than silently starting one. Phase 2 may add this behind a flag — explicit beats magic for v1.
- **Auto-retry on `RegistryOutOfDate` inside `CloudStore.append`.** Tracked as follow-up per §6; explicit startup `registrySync` is the v1 contract.

### 9.1 Obligation created by parking `replay`

Since `replay` is deferred, the cursor-recovery workflow must be first-class documentation with coverage:

- **Cookbook: "resume an agent after crash"** — agent saves `rxweave cursor` output at checkpoints; on restart runs `rxweave stream --since <saved-cursor> --follow` to resume without gaps or duplicates.
- **Cookbook: "back up and restore a local stream"** — copy `./.rxweave/stream.jsonl` to a backup path while the server is stopped; on restore, copy it back. The JSONL file is the canonical state; no snapshot-to-events transform is needed or supplied by v1. (The fold → import round-trip the earlier draft suggested is rejected here: `stream --fold canvas` outputs a projected state object, but `import` consumes events, so the round-trip is undefined without a projector-inverse transform. Punt that to a later spec if the use case surfaces.)
- **Integration test** covering the cursor-checkpoint recovery flow: emit N events → save cursor → emit M more → client restarts with saved cursor → receives exactly M events, no gaps, no dupes.

---

## 10. Scope summary

**New packages / modules:**
- `@rxweave/server` — local RPC server library.
- `packages/protocol/src/handlers/` — runtime-agnostic RpcGroup handler core extracted from what currently lives as independent implementations in cloud (Convex) and `@rxweave/server` (Bun). Shared by both to prevent drift.

**Package API changes:**
- `@rxweave/store-cloud`: `token` becomes optional. Minor breaking for source compat; existing cloud consumers continue to work.
- `@rxweave/schema`: `ActorId` gets a validation regex (see §5.1). Existing events grandfathered.

**CLI changes:** seven additions/renames (`serve`, `import`, `cursor`, `stream --fold`, `stream --count`, `stream --last` ← `--tail`, `agent exec` ← `agent run`); four drops (`count`, `last`, `head`, `store stats`).

**App refactor:** `apps/canvas/` → `apps/web/`, embeds `@rxweave/server`, browser switches to `@rxweave/store-cloud`.

**Zero schema changes at the event-envelope level** — `EventEnvelope` / `EventInput` / `Cursor` / `Filter` are unchanged.

**Obligations created:**
- Cursor-recovery cookbook + integration tests (§9.1) because `replay` is parked.
- Bundle-budget gate (§11) because adding `store-cloud` to the browser.
- Duplicate-schema observability test (§11) per Codex P2.

Roughly 1.5x the total surface area of v0.2.0 (cloud adapter) — larger than initially estimated due to shared handler extraction, browser-token bootstrap, cross-platform secret-file handling, and cursor-recovery docs. **Realistic estimate: 2.5-3 weeks** (Codex's second pass flagged the original 2-week estimate as optimistic given Convex-adapter ambiguity and the auth/bootstrap/test rewrites). One plan's worth of work, but scope implementers accordingly.

---

## 11. Success criteria

**Happy path:**
- `@rxweave/server` passes the 10-case conformance harness.
- `apps/web/` (renamed canvas) runs end-to-end with the unified server: browser draws → events in `stream --follow` → CLI `emit` renders in browser.
- `rxweave stream --fold canvas` against the running server outputs a valid tldraw store snapshot (nodes + bindings).
- `rxweave cursor` returns a non-empty `EventId`-formatted string on a non-empty stream.
- Claude Code can complete the §7 workflow end-to-end against a freshly-started `apps/web` instance without touching anything except its own shell.

**Reliability (added per Codex P2 #8, refined per second-pass P1):**

Split into two independent tests because "kill server and emit while down" is inherently self-contradictory (emits require the server).

- **Client-crash recovery:** with a running `rxweave serve`, emit N events → save the client's cursor position → emit M more events → restart the `stream --follow` client with `--since <saved-cursor>` → verify the client receives exactly M events, in order, no duplicates, no gaps.
- **Server-restart recovery:** `rxweave serve` with `FileStore` persists through a `SIGKILL` → restart from the same `.rxweave/stream.jsonl` → a `stream` call returns the exact event set that was there before the kill. (Leverages existing `@rxweave/store-file` cold-start-recovery coverage; add one server-layer test that exercises it end-to-end through the RPC transport.)
- **Cursor-recovery cookbooks:** both recipes in §9.1 have an executable integration test. The backup-and-restore recipe runs with the server stopped (copy + restart).

**Observability (added per Codex P2 #6):**
- When `DuplicateEventType` is rejected, the server log line includes `type`, local digest, remote digest, and caller identity (actor or source IP). Asserted in a server-level test.

**Compat / perf (added per Codex P2 #8):**
- **Browser bundle budget:** `apps/web`'s production build grows by at most **200 KB gzipped** due to `@rxweave/store-cloud` adoption. Measured via `vite build`'s reporter output; failing this gate is a blocker.
- **CLI payload budget:** `rxweave` binary (Bun-compiled) grows by at most **500 KB** due to server-library inclusion. Measured via `ls -l dist/rxweave`; failing this is a reviewable issue, not a blocker (server code only links when `serve`/`dev` subcommands are invoked, so size impact depends on bundler tree-shaking).

---

## 12. References

- `2026-04-18-rxweave-design.md` — the v0.1 + v0.2 design that established `@rxweave/protocol`, `EventStore` tag, cursor semantics.
- `2026-04-18-rxweave-v01-local-stack.md` — local stack implementation plan (reference for style of follow-up plan).
- `2026-04-18-cloud-v01-and-store-cloud.md` — cloud plan (shares protocol).
- `apps/canvas/` (to become `apps/web/`) — current canvas demo; template for the embedded-server refactor.
- Codex review of the CLI surface — verdicts on `count`/`last`/`head` merge, `project`→`fold`, `agent run`→`exec`, new `cursor` and `import` commands. Baked into §4.
