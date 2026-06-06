# RxWeave Canvas

A shared whiteboard demo built on RxWeave: every action is an event in the stream; the UI reconstructs state from the log; LLM agents can observe and contribute to the same stream.

Two people can open the same URL and see one shared event stream live — canvas actions appear on both screens, and the provenance sidebar shows every event with its causal lineage.

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

## Shared Room — local two-tab check

The shared-room model is verified automatically by `test/sharedRoom.integration.test.ts` (two in-process subscribers against a local `@rxweave/server`). For the visual two-tab proof run the following steps:

```bash
# 1. Start the OSS server with a fixed token (skip the LLM agent to keep it simple).
cd apps/web
SUGGESTER_DISABLED=1 bun run dev
# The server prints the minted token:
#   [web] export RXWEAVE_TOKEN=rxk_<hex>

# 2. Open TWO browser windows pointed at the dev server with the room token in the hash.
#    Replace <token> with the value from the line above.
open "http://localhost:5173/#room=<token>"
open "http://localhost:5173/#room=<token>"

# 3. Draw something in window A — it should appear in window B within ~1 second,
#    and the provenance sidebar on both sides should show the event.
```

Expected latency: ~350ms (debounce) + ~1s (CloudStore heartbeat/poll) = ~1.3s end-to-end. Substantially faster than the previous ~2-3s (2000ms debounce + ~1s poll).

**Security note:** the room token in the URL hash grants full read+write to the shared event stream. Anyone with the link is in the room. This is intentional for a first dogfood among trusted people. Revocable/scoped invites are a deferred follow-up.

## Provenance sidebar

A live event list appears on the right edge of the canvas showing each event's type, actor, short id, and whether it has a causal ancestor (`causedBy`). Click any event to see its lineage (up to 5 levels of causal ancestry within the in-memory log).

- Heartbeat sentinels are filtered from the list.
- The sidebar accumulates the last 500 events in memory (ring buffer).
- Click the toggle button (`◀ / ▶`) to collapse or expand the sidebar.

## Known limitations

- Replays everything from `earliest` on each connect. Fine up to a few thousand events; beyond that, use cursor persistence in localStorage.
- tldraw's undo/redo acts on local state only. A future iteration could hoist undo into the event log (emit inverse events).
- The room token in `#room=` is shared in the URL — anyone with the link gets full read+write. Scoped/revocable invites are a deferred follow-up.
