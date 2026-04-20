# RxWeave Canvas

A shared whiteboard demo built on RxWeave: every action is an event in the stream; the UI reconstructs state from the log; LLM agents can observe and contribute to the same stream.

## Run

```bash
cd apps/canvas
bun install
bun run dev
```

- **Web UI:** http://localhost:5173 (Vite dev server)
- **Event log:** `.rxweave/canvas.jsonl` (JSONL, tail-able)
- **HTTP API:**
  - `POST /api/events` — `{ type, payload, actor?, source? }` → appends
  - `GET /api/subscribe` — SSE stream, replays from earliest

## Architecture

```
Browser (tldraw)  ─user edits──▶  POST /api/events   ┐
       ▲                                              ▼
       │                                      @rxweave/store-file
   SSE (replays everything)                           │
       │                                              ▼
       └──────────────────────────  /api/subscribe ──┘
                                          │
                                          ▼
                               supervise([suggesterAgent])
```

- tldraw's store changes marked `source: 'user'` → POST to the server.
- Server appends to `FileStore`, echoes back via `subscribe`.
- Browser applies echoed events via `mergeRemoteChanges`, marked `source: 'remote'` — outgoing listener ignores them. No sync loop.
- tldraw records flow through the log verbatim — the bridge is record-agnostic.

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

## Known limitations

- Single-user. Multi-user requires pointing the bridge at RxWeave Cloud instead of the local server — trivial schema-wise, needs a cloud deployment.
- Replays everything from `earliest` on each connect. Fine up to a few thousand events; beyond that, use cursor persistence in localStorage.
- tldraw's undo/redo acts on local state only. A future iteration could hoist undo into the event log (emit inverse events).
