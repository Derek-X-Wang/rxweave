# Changelog

## 0.1.0 (unreleased)

First public release. Ships:

- `@rxweave/schema` — event envelope, `EventId`/`ActorId`/`Source`, ULID factory (Clock+Random), `EventRegistry` + `defineEvent` + `EventDefWire`, `Cursor` + `Filter`, tagged errors.
- `@rxweave/core` — `EventStore` service tag + conformance harness.
- `@rxweave/store-memory` — `Live.Memory` adapter.
- `@rxweave/store-file` — `Live.File` adapter with cold-start recovery.
- `@rxweave/reactive` — Stream helpers.
- `@rxweave/runtime` — `defineAgent`, `supervise` via `FiberMap`, `AgentCursorStore` (Memory + File), `withIdempotence`.
- `@rxweave/protocol` — `@effect/rpc` group frozen as the cloud contract.
- `@rxweave/cli` — `init`, `dev`, `emit`, `stream`, `get`, `inspect`, `count`, `last`, `head`, `schema`, `agent`, `store`. NDJSON default; structured errors; exit codes 0/1/2/3/4/5/6.
- `apps/dev` — three example agents (counter, echo, task-from-speech).
