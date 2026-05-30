# @rxweave/cli

## 0.5.5

### Patch Changes

- `rxweave init --template full` + store-file cross-process visibility, byte-exact recovery, and a stream-filter fix.

  - **`rxweave init --template full`** now scaffolds a runnable "collaboration stream skeleton" (a human posts `request.posted` via the CLI; a `bob-assistant` agent reacts with `response.posted` on the same shared log, auto-stamped `actor` + `causedBy`). The `--template full` flag was previously advertised but inert. README quickstart rewritten to use it; `scripts/smoke-quickstart.sh` proves it fresh-install end-to-end.
  - **`@rxweave/cli` filter fix:** an absent repeated `--types`/`--actors`/`--sources` option yields `Some([])` (not `None`) under `@effect/cli`, producing an empty-array filter that rejected _every_ event. Now guarded.
  - **`@rxweave/store-file` cross-process visibility:** `subscribe` only saw same-process appends, so the documented two-process flow (`rxweave dev &` then `rxweave emit`) never delivered. A byte-exact file-tail polling fiber now surfaces events written by other processes.
  - **`@rxweave/store-file` data-loss fix:** the cold-start recovery offset was computed in UTF-16 code units while the file-tail used it as a precise byte offset — a recovered file ending in multi-byte UTF-8 silently dropped the next appended event. Recovery and the tail now share one byte-exact line scanner (`scanLines`), and the latent multi-byte `truncate` mis-truncation is fixed too.

- Updated dependencies
  - @rxweave/store-file@0.5.5
  - @rxweave/core@0.5.5
  - @rxweave/reactive@0.5.5
  - @rxweave/runtime@0.5.5
  - @rxweave/schema@0.5.5
  - @rxweave/server@0.5.5
  - @rxweave/store-memory@0.5.5

## 0.5.4

### Patch Changes

- @rxweave/core@0.5.4
- @rxweave/reactive@0.5.4
- @rxweave/runtime@0.5.4
- @rxweave/schema@0.5.4
- @rxweave/server@0.5.4
- @rxweave/store-file@0.5.4
- @rxweave/store-memory@0.5.4

## 0.5.3

### Patch Changes

- @rxweave/core@0.5.3
- @rxweave/reactive@0.5.3
- @rxweave/runtime@0.5.3
- @rxweave/schema@0.5.3
- @rxweave/server@0.5.3
- @rxweave/store-file@0.5.3
- @rxweave/store-memory@0.5.3

## 0.5.1

### Patch Changes

- @rxweave/core@0.5.1
- @rxweave/reactive@0.5.1
- @rxweave/runtime@0.5.1
- @rxweave/schema@0.5.1
- @rxweave/server@0.5.1
- @rxweave/store-file@0.5.1
- @rxweave/store-memory@0.5.1

## 0.5.0

### Minor Changes

- 69b333a: v0.5.0 — browser streaming. Adds an opt-in heartbeat sentinel to the
  Subscribe RPC so browser clients (Safari/WebKit specifically) get
  sub-second live event delivery without WebKit's fetch-buffer stall.
  Introduces `CloudStore.LiveFromBrowser({ origin, tokenPath?, heartbeat? })`
  which composes session-token bootstrap, drainBeforeSubscribe via
  QueryAfter pagination, heartbeat default (15s), and a per-fiber
  liveness watchdog with first-heartbeat arming + reconnect from the
  last-delivered cursor.

  Polish bundled: `EventRegistry.registerAll(defs, { swallowDuplicates })`
  helper with digest-aware duplicate handling; `mkdirSync` folded into
  `generateAndPersistToken`; `apps/web` canvas schemas relocated from
  `server/` to `src/shared/`.

  Backwards-compatible. Old clients omit the heartbeat field; old
  servers tolerate it (Schema.Struct drops unknown keys). Cloud-v0.3
  adoption is a separate follow-up PR — until it ships, browser
  clients connected to cloud-v0.2 fall back to today's behavior
  (WebKit bug remains for that combination, but the protocol degrades
  cleanly).

  See `docs/superpowers/specs/2026-04-25-browser-streaming-design.md`
  for the full design.

### Patch Changes

- Updated dependencies [69b333a]
  - @rxweave/core@0.5.0
  - @rxweave/reactive@0.5.0
  - @rxweave/runtime@0.5.0
  - @rxweave/schema@0.5.0
  - @rxweave/server@0.5.0
  - @rxweave/store-file@0.5.0
  - @rxweave/store-memory@0.5.0
