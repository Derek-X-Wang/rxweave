# RxWeave CLI + Unified Stream Server — Design Spec

**Date:** 2026-04-20
**Status:** Brainstorming phase complete. Awaiting user review of this spec, then writing-plans.
**Authors:** Derek Wang + Claude (brainstorming session) with Codex (independent review of CLI surface)

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
- **Schemas, suggester agent, tldraw, React, Vite, dev workflow** — unchanged.

Browser bundle grows by `@rxweave/store-cloud` + its transitive Effect-rpc deps (estimate ~80-150 KB gzipped). Acceptable for the demo; to be measured.

---

## 4. CLI surface

Nine top-level commands plus two subcommand groups. Ordered by primary use case:

### 4.1 Setup / lifecycle

- **`rxweave init`** — scaffold `rxweave.config.ts`, `.rxweave/`, `.env.example`. Unchanged from v0.1.
- **`rxweave serve`** *(new)* — start a local `@rxweave/server` instance. Primitive, stable. Flags: `--port <n>` (default 5300), `--host <ip>` (default 127.0.0.1), `--store file|memory` (default file), `--path <file>` (default `./.rxweave/stream.jsonl`), `--auth bearer --token <hash>` (opt-in). Prints `[rxweave] stream on http://<host>:<port>` and the recommended `RXWEAVE_URL` export.
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

- Type: branded string (`ActorId`), no schema-imposed structure.
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
For token: `RXWEAVE_TOKEN` env → config → none.

---

## 6. Schema registration

- Server starts with an empty `EventRegistry` (unless the embedder passes a pre-populated layer).
- Registration is lazy and driven by client emits: the existing `Append` RPC carries the client's registry digest. On divergence, the server responds `AppendError.RegistryOutOfDate { missingTypes }` and the client auto-pushes + retries once. This flow already exists in `@rxweave/store-cloud` / `@rxweave/protocol` v0.2 — it applies unchanged.
- Apps that want to pre-register (so the first emit doesn't pay a round-trip) call `registrySync({ push: [...mySchemas] })` explicitly at startup.
- Conflicts: two clients registering the same `type` with differing payload schemas → server returns `DuplicateEventType` with the colliding hash. Up to the clients to reconcile.

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

- **Multi-user identity.** v1 stays free-form actor strings. Evolution path documented in §5.2.
- **Voice / video / perception event namespaces.** This spec delivers the transport. Domain schemas (`voice.*`, `video.*`, `user.presence.*`) get their own specs.
- **`rxweave replay <from> <to>`, `rxweave diff <a> <b>`, `rxweave drop --types ... --dry-run`.** Codex flagged these as genuinely useful; none are blocking CLI-agent collaboration. Parked.
- **MCP server / native Claude Code tools.** The CLI is sufficient for v1. If shell-out latency becomes a bottleneck, a thin MCP wrapper over the CLI's commands is a future add.
- **Auto-start-if-missing.** `rxweave stream` against a dead server returns a clean error rather than silently starting one. Phase 2 may add this behind a flag — explicit beats magic for v1.

---

## 10. Scope summary

One new package: `@rxweave/server`.
Seven CLI changes: `serve`, `import`, `cursor`, `stream --fold`, `stream --count`, `stream --last` (renamed from `--tail`), `agent exec` (renamed from `agent run`).
Four CLI drops: `count`, `last`, `head`, `store stats`.
One app refactor: `apps/canvas/` → `apps/web/`, embeds the unified server, browser switches to `@rxweave/store-cloud`.
Zero schema changes; existing `@rxweave/protocol` + `@rxweave/schema` + `@rxweave/store-cloud` support this unchanged.

Roughly the same total surface area as v0.2.0 (the cloud adapter). Manageable for one plan + implementation pass.

---

## 11. Success criteria

- `@rxweave/server` passes the 10-case conformance harness.
- `apps/web/` (renamed canvas) runs end-to-end with the unified server: browser draws → events in `stream --follow` → CLI `emit` renders in browser.
- `rxweave stream --fold canvas` against the running server outputs a valid tldraw store snapshot (nodes + bindings).
- `rxweave cursor` returns a non-empty `EventId`-formatted string on a non-empty stream.
- Claude Code can complete the §7 workflow end-to-end against a freshly-started `apps/web` instance without touching anything except its own shell.

---

## 12. References

- `2026-04-18-rxweave-design.md` — the v0.1 + v0.2 design that established `@rxweave/protocol`, `EventStore` tag, cursor semantics.
- `2026-04-18-rxweave-v01-local-stack.md` — local stack implementation plan (reference for style of follow-up plan).
- `2026-04-18-cloud-v01-and-store-cloud.md` — cloud plan (shares protocol).
- `apps/canvas/` (to become `apps/web/`) — current canvas demo; template for the embedded-server refactor.
- Codex review of the CLI surface — verdicts on `count`/`last`/`head` merge, `project`→`fold`, `agent run`→`exec`, new `cursor` and `import` commands. Baked into §4.
