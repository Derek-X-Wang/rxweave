# RxWeave Canvas

A shared whiteboard demo built on RxWeave: every action is an event in the stream; the UI reconstructs state from the log; LLM agents can observe and contribute to the same stream.

## Run

```bash
cd apps/web
bun install
bun run dev
```

- **Web UI:** http://localhost:5173 (Vite dev server)
- **Event log:** `.rxweave/canvas.jsonl` (JSONL, tail-able)
- **Auth token:** `.rxweave/serve.token` (POSIX 0600) — minted fresh on each server start
- **HTTP surface** (provided by `@rxweave/server`):
  - `GET /rxweave/session-token` — returns `{ token: string | null }` so same-origin browser code can bootstrap its bearer
  - `POST /rxweave/rpc` — `@effect/rpc` over NDJSON, same shape cloud speaks (Append / Subscribe / GetById / Query / QueryAfter / RegistrySyncDiff / RegistryPush)

## Architecture

```
Browser (tldraw + @rxweave/store-cloud)
        │                     ▲
   Append(events)         Subscribe (NDJSON stream)
        ▼                     │
        └────────  /rxweave/rpc  ────────┐
                                         │
                              @rxweave/server
                                         │
                                         ▼
                              @rxweave/store-file
                                         │
                                         ▼
                        supervise([suggesterAgent])
                  (shares the same EventStore instance)
```

- tldraw store changes marked `source: 'user'` → `CloudStore.append` via the embedded RPC server.
- Server hands the append to the single `FileStore` instance (shared with the suggester) and re-publishes through its `PubSub`; the subscriber on the other end of the same RPC connection sees it come back.
- Browser applies echoed events via `mergeRemoteChanges`, which marks the store edits as `source: 'remote'` — outgoing listener ignores them. No sync loop.
- tldraw records flow through the log verbatim; the bridge is record-agnostic.

## LLM suggester (opt-in)

Either provider works; OpenRouter is preferred when both env vars are set.

```bash
# OpenRouter (recommended — one key, usage caps)
OPENROUTER_API_KEY=sk-or-... bun run dev

# Anthropic direct
ANTHROPIC_API_KEY=sk-ant-... bun run dev
```

The server forks `supervise([suggesterAgent])` when either key is present. The agent watches `canvas.shape.upserted` events; when a user creates a text-labelled shape it proposes related concept notes and emits them back through the stream — they appear in the browser with no special path.

## Events

| Type | Payload |
|------|---------|
| `canvas.shape.upserted` | `{ record: TLShape }` |
| `canvas.shape.deleted` | `{ id: TLShapeId }` |
| `canvas.binding.upserted` | `{ record: TLBinding }` |
| `canvas.binding.deleted` | `{ id: TLBindingId }` |

## Bundle size budget

Spec §11 caps Phase F's growth in the `apps/web` production bundle at **200 KB gzipped** over the pre-Phase-F baseline (the `@rxweave/store-cloud` adoption is the only meaningful new weight).

To measure:

```bash
cd apps/web
bun run bundle:measure
```

This runs `vite build` and then `scripts/bundle-report.ts`, which walks `dist/` and prints raw + gzipped totals for every JS/CSS asset plus a grand total. Per-file gzip is not the same as a single concatenated gzip stream, so treat it as an upper-bound estimate.

Today most of the weight (~650 KB gzipped) is tldraw + React + Effect + `ai` + `@rxweave/store-cloud`'s effect-rpc client. The growth check is against the stored baseline captured in the git log for the commit that introduced this script, not against the absolute total.

## Known limitations

- Single-user. Multi-user requires pointing the bridge at RxWeave Cloud instead of the local server — trivial schema-wise, needs a cloud deployment.
- Replays everything from `earliest` on each connect. Fine up to a few thousand events; beyond that, use cursor persistence in localStorage.
- tldraw's undo/redo acts on local state only. A future iteration could hoist undo into the event log (emit inverse events).
