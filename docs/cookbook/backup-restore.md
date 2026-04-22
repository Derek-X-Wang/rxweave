# Cookbook: Back up and restore a local stream

The `.rxweave/stream.jsonl` file is the canonical state of a local
server — append-only NDJSON, one event per line. A byte-for-byte copy
round-trips cleanly.

```bash
# 1. Stop the server so the copy captures a consistent snapshot.
#    (An in-flight append is a partial line the scanner will truncate
#    on recovery — safe but ambiguous for backups.)
pkill -TERM -f "rxweave serve"

# 2. Copy the log file.
cp .rxweave/stream.jsonl backups/stream-$(date +%Y%m%d-%H%M%S).jsonl

# 3. Restart.
rxweave serve
```

## Restore

```bash
pkill -TERM -f "rxweave serve"
cp "$(ls -t backups/stream-*.jsonl | head -1)" .rxweave/stream.jsonl
rxweave serve
```

Recovery on the next `serve` boot scans the file and truncates any
torn last line — so even if you missed step 1 on the backup side,
the server self-heals rather than refusing to start.

## Why not a snapshot-then-import round-trip?

`rxweave stream --fold canvas > snapshot.json` projects the event
log into an aggregate state object:

```json
{ "shapes": { "shape:abc": { ... } }, "bindings": { ... } }
```

`rxweave import` consumes event NDJSON, not projections. The fold is
**one-way by design** — there's no general inverse that re-emits the
events a projection was built from, because a projection discards
the timeline (ordering, actors, timestamps, causality).

Back up the raw stream file. Projections are for reading.

## What to commit vs. what to gitignore

- **Commit:** `rxweave.config.ts`, agent definitions, schema files.
  These are code — they describe the system's shape.
- **Gitignore:** `.rxweave/` entirely.
  - `.rxweave/stream.jsonl` is runtime state, not code.
  - `.rxweave/serve.token` is a secret (0600-permissioned, regenerated
    on every `rxweave serve` unless `--token <fixed>` is passed).

## Exporting a stream for portability

If you need a stream that isn't tied to a specific machine's local
file (e.g. to hand off to a teammate), use `rxweave stream` to
serialize — the output is NDJSON, identical to the on-disk format:

```bash
# Export.
rxweave stream > portable.jsonl

# Import on the other side.
rxweave import portable.jsonl
```

`rxweave import` appends each event through the configured store,
minting fresh event ids as it goes. That means the imported stream
will have **new** cursors — any consumer tracking cursors from the
original stream won't find matches on the copy. For cursor-
preserving archival, copy the `.jsonl` file directly.
