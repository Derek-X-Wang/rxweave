# RxWeave

A reactive event system for human + AI collaboration. Event log + reactive streams + agent runtime + CLI. Local-first, cloud-optional, Effect-native.

## Why

Today, human+agent collaboration is fragmented. Humans talk in meetings, agents operate in isolated contexts, shared tools are passive. RxWeave unifies them: everything becomes an event in a shared, observable stream; agents observe the stream and react, rather than relying on prompts.

## Install

```bash
bun add -d @rxweave/cli
bun add @rxweave/schema @rxweave/core @rxweave/store-file @rxweave/runtime
```

Requires Node 22+ or Bun 1.1+. ESM-only.

## 5-minute quickstart

```bash
rxweave init --yes
# define your events + agents in rxweave.config.ts
rxweave dev

# in another shell:
rxweave emit canvas.node.created --payload '{"id":"n1","label":"Hello"}'
rxweave stream --follow
rxweave inspect <eventId> --ancestry
```

See `apps/dev/` for a working example.

## Packages

- `@rxweave/schema` — event envelope, registry, ULID factory, cursor, filter
- `@rxweave/core` — `EventStore` service tag + conformance harness
- `@rxweave/store-memory` / `@rxweave/store-file` / `@rxweave/store-cloud` — store adapters (in-memory, JSONL file, and RxWeave Cloud over `@effect/rpc`)
- `@rxweave/reactive` — Stream helpers (whereType, byActor, bySource, withinWindow, decodeAs)
- `@rxweave/runtime` — `defineAgent`, `supervise`, `AgentCursorStore`, `withIdempotence`
- `@rxweave/llm` — `defineLlmAgent`, `tool()` — LLM-backed agent on top of runtime (Vercel AI SDK)
- `@rxweave/protocol` — `@effect/rpc` group shared with cloud + local servers
- `@rxweave/server` — embeddable local HTTP event-stream server hosting `@rxweave/protocol` RPC over NDJSON (same wire as cloud)
- `@rxweave/cli` — `rxweave` binary

## CLI commands

`@effect/cli` prints commands alphabetically in its generated help. The groupings below are the intended mental model:

- **Setup:** `init` (scaffold a project), `serve` (bind the HTTP RPC server, mint an ephemeral bearer token), `dev` (supervise agents from `rxweave.config.ts`).
- **Writes:** `emit <type> --payload <json>` (single event), `import <file>` (bulk load NDJSON / JSON array, `--dry-run` available).
- **Reads:** `stream [--follow|--count|--last N|--fold <name>|--from-cursor <id>|--since <ms>]` (history + live subscribe), `get <id>` (single envelope), `inspect <id> [--ancestry|--descendants|--lineage]` (causal graph), `cursor` (current head, empty string if store is empty — use `[ -z "$cursor" ]` to branch).
- **Admin:** `schema list|show|validate`, `agent list|status|exec`.

See the cookbook for end-to-end recipes:
- `docs/cookbook/cursor-recovery.md` — resume an agent after crash.
- `docs/cookbook/backup-restore.md` — back up / restore a local stream file.

## Docs

- **Handoff (start here if resuming work):** `docs/HANDOFF.md`
- Design: `docs/superpowers/specs/2026-04-18-rxweave-design.md`
- Implementation plan: `docs/superpowers/plans/2026-04-18-rxweave-v01-local-stack.md`

## License

MIT.
