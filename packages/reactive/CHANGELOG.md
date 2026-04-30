# @rxweave/reactive

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
  - @rxweave/schema@0.5.0
