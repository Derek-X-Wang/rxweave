# RxWeave — Design Spec

**Date:** 2026-04-18
**Status:** Approved (brainstorming phase complete; revised 2026-04-18 per Codex review + Option X scope)
**Authors:** Derek Wang + Claude (brainstorming session) with Codex (independent review)

---

## 1. Overview

RxWeave is an open-source reactive event system for human + AI collaboration. Everything that happens — human actions, agent actions, canvas changes, future voice/video signals — becomes an event in a shared, observable stream. Agents observe the stream and react, rather than relying on prompts or direct orchestration.

The project ships as two independent repositories:

- **`rxweave`** (this repo) — OSS, local-first, backend-agnostic. Event log + reactive streams + agent runtime + CLI.
- **`cloud`** (separate repo, private) — Hosted sync and dashboard, optional. Depends on `@rxweave/protocol` + `@rxweave/schema`. Rxweave core has zero cloud dependencies.

This spec covers the `rxweave` repo design. Cloud gets its own spec once the event contract is frozen here.

**Versioning:** v0.1 ships the rxweave local stack (memory + file stores, runtime, CLI, apps/dev) with a frozen `@rxweave/protocol`. v0.2 ships the cloud repo + `@rxweave/store-cloud` client + minimal dashboard. See §12 for the execution plan and §15 for per-version success criteria.

---

## 2. Principles

- **Minimal primitives, maximal composition.** Event log + `Stream` + Agent. No custom abstractions over what Effect already gives us.
- **Effect-native.** Services via `Context.Tag`, errors via `Schema.TaggedError`, streams via `Stream`, concurrency via `Fiber`. Match the patterns already in use in maitred.
- **Deterministic first.** Rule-based agents, cursor-persistent state, reproducible replay. LLM agents are a later specialization, not a core primitive.
- **AI-first CLI.** NDJSON default output, structured tagged errors on stderr, zero interactive prompts, inspection as a first-class surface.
- **Cloud is optional.** Core has zero cloud deps. Cloud is a `Live.Cloud` adapter implementing the same `EventStore` tag, consuming a `RpcGroup` rxweave publishes.
- **Local-first, schema-first.** The event store runs on the user's laptop by default. The schema registry is the source of truth for event types; cloud inherits it.

---

## 3. Monorepo Structure

```
rxweave/
├── package.json                 # bun workspaces root
├── turbo.jsonc                  # turborepo task orchestration
├── tsconfig.base.json
├── bun.lockb
├── .rxweave/                    # runtime data (gitignored): events.jsonl, cursors.json
├── docs/
│   └── superpowers/specs/       # design docs
├── packages/
│   ├── schema/                  # @rxweave/schema        — envelope, registry, EventId, Cursor, Filter (depends only on `effect`)
│   ├── core/                    # @rxweave/core          — EventStore Tag + conformance harness (no Live layers)
│   ├── store-memory/            # @rxweave/store-memory  — Live.Memory
│   ├── store-file/              # @rxweave/store-file    — Live.File (deps: @effect/platform-bun)
│   ├── store-cloud/             # @rxweave/store-cloud   — Live.Cloud (deps: @effect/rpc client) — built in v0.2
│   ├── reactive/                # @rxweave/reactive      — Stream helpers
│   ├── runtime/                 # @rxweave/runtime       — defineAgent, supervisor, lineage stamping
│   ├── protocol/                # @rxweave/protocol      — @effect/rpc RpcGroup (depends on schema + @effect/rpc; shared with cloud)
│   └── cli/                     # @rxweave/cli           — rxweave binary (bun --compile)
└── apps/
    └── dev/                     # playground: example agents, console demos
```

### Dep Graph (strict, no cycles)

```
schema ← core ← store-memory
                store-file      ← runtime ← cli
                store-cloud
schema ← protocol ← store-cloud

schema ← reactive ← runtime
runtime ← apps/dev
```

Cloud repo's only rxweave deps are `@rxweave/schema` + `@rxweave/protocol`. Clean one-way dependency.

**Why `Cursor`/`Filter` live in `schema` (not `core`):** `@rxweave/protocol` must import them to type the RPC payloads. `protocol` cannot depend on `core` (that would force cloud to pull in core), so the shared wire types belong in `schema`. `core` owns the `EventStore` Tag and conformance harness; it depends on `schema` for those types.

---

## 4. Event Model (`@rxweave/schema`)

This package is the wire contract. Everything here is serializable, portable, and version-pinned.

### Envelope

Every event carries an identical envelope regardless of type:

```ts
export const EventId = Schema.String.pipe(
  Schema.pattern(/^[0-9A-HJKMNP-TV-Z]{26}$/),  // ULID
  Schema.brand("EventId"),
)
export type EventId = typeof EventId.Type

export const ActorId = Schema.String.pipe(Schema.brand("ActorId"))
export const Source = Schema.Literal("canvas", "agent", "system", "voice", "cli", "cloud")

export class EventEnvelope extends Schema.Class<EventEnvelope>("EventEnvelope")({
  id: EventId,                                     // ULID
  type: Schema.String,                              // dot-namespaced: "canvas.node.created"
  actor: ActorId,                                   // who emitted this
  source: Source,                                   // where emission originated
  timestamp: Schema.Number,                         // epoch ms
  causedBy: Schema.optional(Schema.Array(EventId)), // L2 lineage (optional; see §4.4)
  payload: Schema.Unknown,                          // decoded per-type via registry
}) {}
```

### 4.1 ULID and ordering invariants

- **Within a single store**, ULID ids are monotonically increasing: the next-appended event's id is strictly greater (lex order) than any already-appended event's id. The store enforces this on append; if system clock skews backward, the store uses `max(Clock.now, lastAppendedTimestamp)` as the ULID timestamp component.
- **Across stores** (e.g., two devices, or local + cloud merge), ULIDs are unique but ordering reflects wall-clock-at-emit, not strict causal order. Consumers that need causal order use `causedBy` lineage.
- **Deterministic in tests**: ULID generation takes both a `Clock` service and a seedable entropy source via Effect's `Random`. Tests provide `TestClock` + seeded `Random` → fully reproducible ids.

### 4.2 Cursor and Filter (shared wire types)

```ts
export const Cursor = Schema.Union(
  EventId,                          // resume strictly AFTER this id (exclusive)
  Schema.Literal("earliest"),        // from position 0, inclusive
  Schema.Literal("latest"),          // live only; no historical replay
)
export type Cursor = typeof Cursor.Type

export const Filter = Schema.Struct({
  types:   Schema.optional(Schema.Array(Schema.String)),   // globs: "canvas.*"
  actors:  Schema.optional(Schema.Array(ActorId)),
  sources: Schema.optional(Schema.Array(Source)),
  since:   Schema.optional(Schema.Number),                 // epoch ms, inclusive
})
export type Filter = typeof Filter.Type
```

**Cursor semantics (frozen):**
- Cursor value `<EventId>` ⇒ subscribe yields events **strictly greater** (lex order) than that id. The cursor stores "last seen id"; resuming from it must not re-deliver the event with that id. **Exclusive.**
- Cursor value `"earliest"` ⇒ replay from first event, inclusive.
- Cursor value `"latest"` ⇒ no historical replay; live tail only.
- Providing a cursor id that does not exist in the store is **not** an error: the store treats it as "deliver events whose id is strictly greater than the given value, as if the id were valid." This simplifies cross-device resume.

**Filter is envelope-only for v0.1.** Payload predicates are explicitly rejected — they can't be efficiently pushed down to JSONL file scans without a richer index, and cross-adapter capability negotiation would balloon the protocol. If a future version adds them, it comes as a capability-negotiated filter AST, not an ad-hoc extension.

### 4.3 Schema Registry

Every event type is declared via a registry. Emitting an unregistered type is a runtime tagged error; subscribe decodes payloads on read.

```ts
// Local representation — holds a runtime Schema object, NOT serializable.
export interface EventDef<A = unknown, I = unknown> {
  readonly type: string
  readonly payload: Schema.Schema<A, I>
}

export const defineEvent = <A, I>(
  type: string,
  payload: Schema.Schema<A, I>,
): EventDef<A, I> => ({ type, payload })

// Wire representation — serializable; shipped over RegistrySync RPC.
export class EventDefWire extends Schema.Class<EventDefWire>("EventDefWire")({
  type:          Schema.String,
  version:       Schema.Number,                 // bumped by user if payload schema changes
  payloadSchema: Schema.Unknown,                // JSON-Schema-ish export via Schema.JSONSchema
  digest:        Schema.String,                 // sha256(type + version + canonical(payloadSchema))
}) {}

export class EventRegistry extends Context.Tag("rxweave/EventRegistry")<
  EventRegistry,
  {
    readonly register: (def: EventDef) => Effect.Effect<void, DuplicateEventType>
    readonly lookup:   (type: string)  => Effect.Effect<EventDef, UnknownEventType>
    readonly all:      Effect.Effect<ReadonlyArray<EventDef>>
    readonly digest:   Effect.Effect<string>   // sha256 of sorted(EventDefWire.digest[])
    readonly wire:     Effect.Effect<ReadonlyArray<EventDefWire>>
  }
>() {
  static Live = Layer.effect(EventRegistry, /* Ref<Map<string, EventDef>>-backed */)
  static Test = (defs: ReadonlyArray<EventDef>) => Layer.succeed(EventRegistry, /* … */)
}
```

**Wire-safe:** only `EventDefWire` crosses the network. The `Schema.Schema<A, I>` object stays local; cloud mirrors the wire form. If a client sends events of a type whose digest cloud hasn't seen, cloud returns `RegistryOutOfDate` with the missing types; client responds with `RegistryPush`. See §9.

### 4.4 `causedBy` semantics

- **Optional.** Events emitted out-of-band (timer, fresh user input, manual CLI emit) have no trigger; `causedBy` is absent.
- **Auto-stamped.** When an agent's `handle(trigger)` or `reduce(trigger, state)` returns emitted events, the runtime stamps `causedBy: [trigger.id]` on each. Handlers cannot forge it.
- **Lazy resolution across stores.** In cloud merge, an event `e` may arrive referencing a `causedBy` id that hasn't synced yet. This is **not** an error. `inspect --ancestry` and `EventStore.getById` on an unresolved id return a tagged `DanglingLineage` result with the pending id; UI shows it as pending until resolved.
- **No cycle detection.** Use `inspect --descendants` to debug ping-pong chains; responsibility is on the agent designer.

### 4.5 Tagged Errors

```ts
export class UnknownEventType    extends Schema.TaggedError<UnknownEventType>()   ("UnknownEventType",    { type: Schema.String }) {}
export class DuplicateEventType  extends Schema.TaggedError<DuplicateEventType>() ("DuplicateEventType",  { type: Schema.String }) {}
export class SchemaValidation    extends Schema.TaggedError<SchemaValidation>()   ("SchemaValidation",    { type: Schema.String, issue: Schema.Unknown }) {}
export class RegistryOutOfDate   extends Schema.TaggedError<RegistryOutOfDate>()  ("RegistryOutOfDate",   { missingTypes: Schema.Array(Schema.String) }) {}
export class DanglingLineage     extends Schema.TaggedError<DanglingLineage>()    ("DanglingLineage",     { eventId: EventId, missingAncestor: EventId }) {}
```

### 4.6 `EventInput`

The un-stamped payload users supply to `emit`. The store or runtime stamps `id`, `actor` (for agents), `timestamp`, and optionally `causedBy`.

```ts
export class EventInput extends Schema.Class<EventInput>("EventInput")({
  type: Schema.String,
  actor: Schema.optional(ActorId),     // stamped by runtime for agents; required for external emit
  source: Schema.optional(Source),     // defaults to "cli" or "agent" depending on path
  payload: Schema.Unknown,
}) {}
```

---

## 5. EventStore (`@rxweave/core` + `store-*`)

### Tag

```ts
// @rxweave/core — imports Cursor, Filter, EventEnvelope, EventInput from @rxweave/schema
export class EventStore extends Context.Tag("rxweave/EventStore")<
  EventStore,
  {
    readonly append:    (events: ReadonlyArray<EventInput>) => Effect.Effect<ReadonlyArray<EventEnvelope>, AppendError>
    readonly subscribe: (opts: { cursor: Cursor; filter?: Filter }) => Stream.Stream<EventEnvelope, SubscribeError>
    readonly getById:   (id: EventId) => Effect.Effect<EventEnvelope, NotFound>
    readonly query:     (filter: Filter, limit: number) => Effect.Effect<ReadonlyArray<EventEnvelope>, QueryError>
    readonly latestCursor: Effect.Effect<Cursor>   // id of most recent append, or "earliest" if empty
  }
>() {}
```

### 5.1 Append durability contract (frozen)

- **Atomicity:** `append(events[])` is all-or-nothing per call. Either every input becomes an envelope and is durably stored, or the call fails with a tagged error and **no** envelope is produced. Appended envelopes appear on live subscribers in call-input order, consecutively.
- **Durability:** the returned `Effect` does not resolve until the new lines have been `fsync`'d (for `store-file`) or atomically committed to the backing store (for `store-memory`: append to `Ref` under a single `update`; for `store-cloud`: cloud acknowledges durable write).
- **Ordering:** the newly returned envelopes have ids strictly greater than any id that existed before the call. Concurrent `append` calls are serialized through a single writer fiber per store instance (an Effect `Semaphore(1)` or a `Queue`-backed worker).
- **Id assignment:** ids are assigned inside the writer under the lock, from a ULID factory provided via `Clock` + seeded `Random`. The factory maintains `lastIssuedTimestamp` and clamps forward (never backward) to ensure within-store monotonicity even under clock skew.

### 5.2 Live fan-out (shared across Memory + File)

- Internal `PubSub.bounded<EventEnvelope>(capacity = 1024)` per store instance. The bound prevents slow subscribers from accumulating unbounded memory.
- **Overflow policy: `PubSub.sliding`** — when the buffer is full, the oldest undelivered event is dropped and a `SubscriberLagged` tagged error is emitted on the affected subscriber's stream. The subscriber must reconnect with the last id it saw to backfill; if it can't, it fails with `SubscribeError.Lagged`.
- Publish happens **inside** the append writer, after durability ack, so live subscribers never see events that aren't durably stored.

### 5.3 Replay → live handoff algorithm (frozen)

Given `subscribe({ cursor, filter })`:

1. **Snapshot.** Under the writer lock, read `snapshotMaxId = latestCursor` and **subscribe** to the PubSub (attach the subscriber before releasing the lock). This establishes a strict boundary: every event with id `> snapshotMaxId` is guaranteed to come through the PubSub; every event with id `≤ snapshotMaxId` is in the historical store.
2. **Replay stream.** Build `replay: Stream<EventEnvelope>` from the historical store that emits events with id `> cursor` AND id `≤ snapshotMaxId`, in order, matching `filter`. (`cursor = "earliest"` ⇒ lower bound is `-∞`; `cursor = "latest"` ⇒ replay is empty.)
3. **Live stream.** Build `live: Stream<EventEnvelope>` from `Stream.fromPubSub(pubsub)`, filtering by `filter` and dropping events with id `≤ snapshotMaxId` (in case of races during attach).
4. **Concat.** Return `Stream.concat(replay, live)`. Effect's `Stream.concat` guarantees ordered, non-overlapping delivery.

No duplicates, no gaps. If `cursor = "latest"`, step 2 is skipped entirely.

### 5.4 `@rxweave/store-memory`

```ts
export const MemoryStore = {
  Live: Layer.effect(EventStore, /* see 5.1–5.3; backed by Ref + bounded sliding PubSub */),
}
```

### 5.5 `@rxweave/store-file`

- Append-only JSONL at a configured path. Writes go through a single writer fiber (`Semaphore(1)` on the scoped `FileHandle`). After each batch write, `fsync`, then publish each envelope to the internal PubSub in order.
- Uses `@effect/platform-bun`'s `FileSystem` + `FileHandle.writeAll`. Scoped `Layer` for proper close-on-shutdown (flush + release lock + close handle).
- **Cold-start scan:** on layer acquisition, read the file line-by-line via `Stream.fromReadable`; decode each line with `Schema.parseJson(EventEnvelope)`.
  - **Corruption handling:** if a line fails to decode, log a structured warning and skip that line. This handles the "power loss mid-write" case. If the *last* line fails to decode, also **truncate the file to the end of the last valid line** before resuming (prevents appending after a partial line). A `system.store.recovery` event is appended after startup with `{ skipped: N, truncatedBytes: M }`.
- Maintains `lastIssuedTimestamp` in memory across the scan; new appends clamp forward.

```ts
export const FileStore = {
  Live: (opts: { path: string }) => Layer.scoped(EventStore, /* … */),
}
```

**File format:** one `EventEnvelope` JSON object per line, newline-terminated. No header; no rotation in v0.1. Lines are independent so partial files are recoverable.

### 5.6 `@rxweave/store-cloud` (v0.2)

Client-side `Live.Cloud` using `@effect/rpc` client from `@rxweave/protocol`. Passes `Authorization: Bearer <token>` on every call. **Reconnection contract:**

- `subscribe` holds the last delivered event id in a local `Ref`. On RPC stream disconnect, the Stream retries with `Stream.retry(Schedule.exponential(500 ms, 1.5).pipe(Schedule.intersect(Schedule.recurs(10))))`. Each retry reissues the `Subscribe` RPC with `cursor = lastDeliveredId`, guaranteeing no duplicates and no gaps (cursor is exclusive).
- On `RegistryOutOfDate` from any RPC, the client auto-pushes missing `EventDefWire` via `RegistryPush` and retries once.

```ts
export const CloudStore = {
  Live: (opts: { url: string; token: () => string | Promise<string> }) => Layer.effect(EventStore, /* … */),
}
```

### 5.7 Live layer convention

- `MemoryStore.Live` — a `Layer` directly (no per-instance config).
- `FileStore.Live({ path })` — a function returning a scoped `Layer` (owns file handle lifecycle).
- `CloudStore.Live({ url, token })` — a function returning a `Layer`.

General rule: if an adapter needs runtime config, `Live` is a function; otherwise it's a `Layer`.

### 5.8 Conformance

A shared test suite (`@rxweave/core/testing/conformance.ts`) that all three store implementations must pass:

- append+subscribe round-trip (single + batch)
- append batch atomicity under failure injection
- filter push-down (every `Filter` field)
- cursor resume (EventId, "earliest", "latest", non-existent id)
- exclusive cursor semantics (resume must NOT re-deliver the cursor event)
- concurrent subscribers (fan-out correctness, no duplicate delivery)
- graceful shutdown (scope close flushes + closes handles)
- cold-start recovery (store-file only: corrupted last line → truncate + recovery event)
- subscriber lag behavior (slow subscriber receives `SubscriberLagged` not OOM)
- ordered replay (replay + live handoff has no duplicates, no gaps)

---

## 6. Reactive Layer (`@rxweave/reactive`)

Thin helpers over `Stream`. No `Observable` class, no query DSL.

```ts
import { Stream, Effect, Clock } from "effect"

export const whereType    = (glob: string | string[]) =>
  <E>(s: Stream.Stream<EventEnvelope, E>) => Stream.filter(s, e => matchGlob(e.type, glob))

export const byActor      = (actor: ActorId | ActorId[]) =>
  <E>(s: Stream.Stream<EventEnvelope, E>) => Stream.filter(s, e => includes(actor, e.actor))

export const bySource     = (source: Source | Source[]) =>
  <E>(s: Stream.Stream<EventEnvelope, E>) => Stream.filter(s, e => includes(source, e.source))

// Uses Effect Clock service → works under TestClock in tests. Determinism-safe.
export const withinWindow = (ms: number) =>
  <E>(s: Stream.Stream<EventEnvelope, E>): Stream.Stream<EventEnvelope, E> =>
    Stream.filterEffect(s, (e) =>
      Clock.currentTimeMillis.pipe(Effect.map((now) => now - e.timestamp <= ms))
    )

export const decodeAs     = <A, I>(schema: Schema.Schema<A, I>) =>
  <E>(s: Stream.Stream<EventEnvelope, E>): Stream.Stream<A, E | SchemaValidation> =>
    Stream.mapEffect(s, (e) =>
      Schema.decodeUnknown(schema)(e.payload).pipe(
        Effect.mapError((issue) => new SchemaValidation({ type: e.type, issue }))
      )
    )
```

Anyone needing more reaches for `Stream` directly (map, mapEffect, merge, zipLatest, groupByKey, buffer, debounce, etc. — all already in Effect).

**Glob matching:** `minimatch` — stable, tiny, supports `*` and `**`. Locked choice, not an open item.

---

## 7. Agent Runtime (`@rxweave/runtime`)

### 7.1 `defineAgent`

```ts
export interface AgentDef<S = never> {
  readonly id: string                                     // stable, persisted per-store
  readonly on: Filter                                     // push-down subscribe filter
  readonly concurrency?: "serial" | { max: number }       // default "serial"; v0.1: serial only
  readonly restart?: Schedule.Schedule<any, unknown>      // default: Schedule.exponential(100ms, 2.0).pipe(Schedule.either(Schedule.spaced(30s)))
  // Handler — exactly one of:
  readonly handle?: (event: EventEnvelope) => Effect.Effect<ReadonlyArray<EventInput> | void, AgentError, unknown>
  readonly reduce?: (event: EventEnvelope, state: S) => { state: S; emit?: ReadonlyArray<EventInput> }
  readonly initialState?: S
}

export const defineAgent = <S = never>(def: AgentDef<S>): AgentDef<S> => def
```

**Handler enforcement:** `defineAgent` validates that exactly one of `handle` or `reduce` is provided. Both or neither raises `InvalidAgentDef` (tagged error) at registration time, before any fiber starts. `reduce` requires `initialState`.

### 7.2 Supervisor (`FiberMap` keyed by agent id)

```ts
import { FiberMap } from "effect"

export const supervise = (agents: ReadonlyArray<AgentDef<any>>) =>
  Effect.fn("supervise")(function* () {
    const store = yield* EventStore
    const cursors = yield* AgentCursorStore
    const fibers = yield* FiberMap.make<string, any, never>()
    for (const agent of agents) {
      yield* FiberMap.run(fibers, agent.id, runAgent(agent, store, cursors))
    }
    yield* Effect.never   // run forever until scope closes
  })
```

`FiberMap` (keyed by `agent.id`) enables:
- `supervise.status(agentId)` reads one fiber's state for `agent status <id>`.
- `supervise.restart(agentId)` and `supervise.stop(agentId)` for operational commands (v0.2+; exposed via CLI later).
- Failure isolation: one agent's defect does not interrupt siblings.

### 7.3 Per-Agent Execution + Delivery Semantics

1. Look up `lastCursor[agent.id]` from `AgentCursorStore` (default `"latest"`).
2. `store.subscribe({ cursor: lastCursor, filter: agent.on })` — push-down filter at the store layer. **Cursor is exclusive**: the agent will not re-receive the event with id `lastCursor`.
3. For each event, run `handle(event)` or `reduce(event, state)`.
4. **On successful completion**, batch-persist `lastCursor[agent.id] = event.id` (batch policy: every 100 events OR 1 second, whichever first; both knobs configurable on `supervise(agents, { cursorFlush: { events: 100, millis: 1000 } })`).
5. If the handler/reducer returns `emit: EventInput[]`, runtime stamps each envelope with `id: ULID()`, `actor: agent.id`, `source: "agent"`, `timestamp: Clock.now()`, `causedBy: [event.id]`, and appends via `EventStore.append` (single-batch, atomic).
6. On tagged error: logs + restarts per `restart` schedule. On defect: logs + fails this one fiber; siblings unaffected.
7. On scope close (shutdown): interrupt all fibers, flush pending cursor writes, close store.

### 7.4 Delivery semantics (frozen)

- **At-least-once.** If the runtime crashes between `handle(event)` completing and `lastCursor` being persisted (batched up to 100 events / 1s), the next startup replays that window of events. **Idempotence is the agent author's responsibility.**
- **Idempotence helper.** `@rxweave/runtime` exports `withIdempotence(by: (event) => string, memory: "local" | "store")` — a combinator that wraps a handler and suppresses re-processing of events whose idempotence key it has already seen. `"local"` uses an in-memory Ref (survives only the current run); `"store"` uses a dedicated `agent.dedupe` sub-log (survives restarts). Agents that emit events generally want `"store"` to avoid duplicate emits after a crash.

```ts
import { withIdempotence } from "@rxweave/runtime"

export const echoAgent = defineAgent({
  id: "echo",
  on: { types: ["canvas.node.created"] },
  handle: withIdempotence(
    (event) => event.id,            // dedupe by trigger event id
    "store",
    function* (event) {
      const logger = yield* Logger
      yield* logger.info(`echo: ${event.id}`)
      return [{ type: "echo.seen", payload: { id: event.id } }]
    },
  ),
})
```

- **Emit ordering guarantee.** Events returned from one `handle`/`reduce` invocation are appended as a single atomic batch (see §5.1). Subscribers see them in order, consecutively, without interleaving from other agents' emits.

### 7.5 `AgentCursorStore`

```ts
export class AgentCursorStore extends Context.Tag("rxweave/AgentCursorStore")<
  AgentCursorStore,
  {
    readonly get:  (agentId: string) => Effect.Effect<Cursor>
    readonly set:  (agentId: string, cursor: Cursor) => Effect.Effect<void>
    readonly list: Effect.Effect<ReadonlyArray<{ agentId: string; cursor: Cursor }>>
  }
>() {
  static Memory = Layer.effect(AgentCursorStore, /* Ref-backed */)
  static File   = (opts: { path: string }) => Layer.scoped(AgentCursorStore, /* JSON file next to events.jsonl */)
}
```

### 7.6 Runtime Non-Goals (v0.1)

- **Cycle detection.** `causedBy` lets you see ping-pong; responsibility is on the designer.
- **Scheduled/cron agents.** Emit a `system.tick` event from a scheduler layer if needed.
- **Per-agent concurrency > 1.** Serial only. Adding later means a small supervisor change + a bounded channel.

---

## 8. CLI (`@rxweave/cli`)

Built on `@effect/cli`. Compiled via `bun build --compile` into a single binary. AI agent is the primary consumer.

### 8.1 Commands

```
rxweave init                             [--yes] [--template minimal|full]
rxweave dev                              [--config <path>] [--store <path>]
rxweave emit <type>                      --payload <json> | --payload-file <path>
rxweave emit --batch                     (NDJSON on stdin)
rxweave stream                           [--types ...] [--actors ...] [--sources ...]
                                         [--from-cursor <id>] [--follow] [--format json|pretty]
rxweave get <eventId>
rxweave inspect <eventId>                [--ancestry] [--descendants] [--depth N]
rxweave count                            [filters]
rxweave last                             [filters] [-n N]
rxweave head                             [filters] [-n N]
rxweave schema list
rxweave schema show <type>
rxweave schema validate <type>           --payload <json>
rxweave agent run                        [path | --id <id>] [--from-cursor]
rxweave agent list
rxweave agent status <id>
rxweave store stats
```

### 8.2 AI-First Defaults

- **Output:** NDJSON to stdout by default. `--pretty` opts into ANSI.
- **Errors:** NDJSON on stderr, tagged via `Schema.TaggedError`. Exit codes:
  - `0` ok
  - `1` input error (missing/invalid flag)
  - `2` not found (event/agent/schema)
  - `3` schema validation failure
  - `4` store error (file IO, append conflict)
  - `5` cloud/auth error
  - `6` registry out of date (cloud path)
- **No interactive prompts.** `init` takes flags; missing required flag produces a structured error naming the flag.
- **Everything pipes.** `rxweave stream --format json | jq '.type' | sort | uniq -c`. `cat seed.jsonl | rxweave emit --batch`.
- **Global flags:** `--config <path>` (default `./rxweave.config.ts`), `--store <path>`, `--quiet`, `--verbose`.

### 8.3 Config File

```ts
// rxweave.config.ts
import { defineConfig } from "@rxweave/cli"
import { FileStore } from "@rxweave/store-file"
import { CloudStore } from "@rxweave/store-cloud"          // v0.2
import { MemoryStore } from "@rxweave/store-memory"
import { myAgent, counterAgent } from "./agents"
import { CanvasNodeCreated, TaskCreated } from "./schemas"

export default defineConfig({
  store: process.env.RXWEAVE_CLOUD_URL
    ? CloudStore.Live({ url: process.env.RXWEAVE_CLOUD_URL!, token: () => process.env.RXWEAVE_TOKEN! })
    : FileStore.Live({ path: ".rxweave/events.jsonl" }),
  schemas: [CanvasNodeCreated, TaskCreated],
  agents: [myAgent, counterAgent],
})
```

Loaded via Bun's native TypeScript support (`bun run`). The compiled CLI binary includes Bun's runtime.

---

## 9. Cloud Contract (`@rxweave/protocol`)

Shipped in v0.1 as part of the contract freeze. Cloud (built in v0.2) implements the handlers.

### 9.1 RpcGroup

```ts
// @rxweave/protocol — pure schema, zero runtime deps beyond @effect/rpc; shared with cloud repo
import { Rpc, RpcGroup } from "@effect/rpc"
import { Schema } from "effect"
import { EventEnvelope, EventInput, EventId, EventDefWire, Cursor, Filter } from "@rxweave/schema"

export class RxWeaveRpc extends RpcGroup.make(
  Rpc.make("Append", {
    payload: Schema.Struct({ events: Schema.Array(EventInput), registryDigest: Schema.String }),
    success: Schema.Array(EventEnvelope),
    error:   AppendError,                     // includes RegistryOutOfDate variant
  }),
  Rpc.make("Subscribe", {
    payload: Schema.Struct({ cursor: Cursor, filter: Schema.optional(Filter) }),
    success: EventEnvelope,
    stream:  true,
    error:   SubscribeError,                  // includes SubscriberLagged variant
  }),
  Rpc.make("GetById", {
    payload: Schema.Struct({ id: EventId }),
    success: EventEnvelope,
    error:   NotFound,
  }),
  Rpc.make("Query", {
    payload: Schema.Struct({ filter: Filter, limit: Schema.Number }),
    success: Schema.Array(EventEnvelope),
    error:   QueryError,
  }),
  Rpc.make("RegistrySyncDiff", {
    payload: Schema.Struct({ clientDigest: Schema.String }),
    success: Schema.Struct({
      upToDate: Schema.Boolean,
      missingOnClient: Schema.Array(EventDefWire),    // server has, client doesn't
      missingOnServer: Schema.Array(Schema.String),   // types server doesn't know; client should push via RegistryPush
    }),
    error:   RegistryError,
  }),
  Rpc.make("RegistryPush", {
    payload: Schema.Struct({ defs: Schema.Array(EventDefWire) }),
    success: Schema.Void,
    error:   RegistryError,
  }),
) {}
```

### 9.2 Registry negotiation (frozen)

- Every `Append` ships the client's current `registryDigest`. If server's digest ≠ client's, server responds `AppendError.RegistryOutOfDate { missingTypes }`.
- Client, on seeing `RegistryOutOfDate`, calls `RegistrySyncDiff { clientDigest }`. Server returns two arrays: types server has that client doesn't (client can adopt optional), and types server lacks (client must push).
- Client calls `RegistryPush` with the missing `EventDefWire[]`, then retries the original `Append` once.
- First-boot negotiation: client calls `RegistrySyncDiff` on first connect. Idempotent by digest.

### 9.3 Transport

HTTP for request/response ops (`Append`, `GetById`, `Query`, `RegistrySyncDiff`, `RegistryPush`); HTTP chunked NDJSON for streaming `Subscribe`. `@effect/rpc` + `@effect/platform`'s `HttpServer`/`HttpClient` handle both binding shapes. The exact wire binding (e.g., HTTP/2 server-sent-events vs chunked transfer) is documented in the protocol package README; any compliant `HttpServer` implementation works.

### 9.4 Auth

`Authorization: Bearer <token>` header on every request. Cloud-side handler extracts token, resolves to either a Better Auth session (user) or an API key (machine), scopes all store operations to that tenant. `store-cloud` passes the token via `token: () => string | Promise<string>` so clients can refresh mid-connection.

### 9.5 Cloud Repo (v0.2, Outside This Spec)

Scaffolded separately via `/kitcn` from the dynakv/streamerverdict pattern. Responsibilities:

- `apps/web` — TanStack Start dashboard (cRPC + TanStack Query + Better Auth) for human users: list events, inspect lineage, manage API keys, manage organizations, view agent status per device.
- `packages/backend` — Convex + kitcn. Mounts the `@effect/rpc` HTTP handler at `/rxweave/rpc/*` alongside kitcn's cRPC routes.
- Storage: Convex table `events` indexed on `(tenantId, id)`, `(tenantId, type, id)`, `(tenantId, actor, id)` for push-down filter. IDs are ULIDs from clients; cloud never rewrites them. Merges are conflict-free (ULID + tenant scope).
- Auth: Better Auth (sessions) + API keys (machine) — same pattern as dynakv.

**What cloud does NOT own:** agent execution, schema authority (cloud mirrors client-registered types via `RegistryPush`), rxweave runtime logic.

---

## 10. Testing

- **Framework:** `@effect/vitest` (`it.effect`, `it.scoped`, `it.layer`, `TestClock`, `TestRandom`). Matches maitred.
- **Test-helper convention:**
  - `it.effect` — pure computations, `MemoryStore.Live`, in-memory layers only. Fast.
  - `it.scoped` — any test that acquires a `Layer.scoped` resource (`FileStore.Live`, `CloudStore.Live`, file-backed `AgentCursorStore`). Ensures layer cleanup runs.
- **Determinism:**
  - Tests provide `MemoryStore.Live` (or `FileStore.Live` with `tmpDir`), a test `EventRegistry`, `TestClock`, and a seeded `TestRandom`.
  - ULID generation depends on the `Clock` and `Random` services. Under test layers, ids are reproducible byte-for-byte across runs.
- **Conformance suite:** shared test cases in `@rxweave/core/testing/conformance.ts`. All three store implementations (Memory, File, Cloud) must pass the full list in §5.8. Memory + File run in rxweave CI; Cloud runs in cloud-repo CI against a deployed dev Convex environment.
- **Agent tests:**
  - `reduce` variant: pure function, tested with plain Vitest (no Effect runtime).
  - `handle` variant: `it.effect` (memory layers) or `it.scoped` (file/cloud layers) with `Effect.provide(TestLayers)`.
- **CLI tests:** maitred pattern (`SequenceRef`, `runCli`, `expectSequence`) — deterministic stdout/stderr capture, mocked services per command. See maitred's `packages/cli/.../cli-testing.md`.

---

## 11. Tooling & Build

- **Runtime:** Bun 1.3+ primary; Node 22 LTS supported as a compatibility target (ESM-only; no CJS).
- **Monorepo:** Bun workspaces + Turborepo. `turbo.jsonc` tasks: `build`, `typecheck`, `test`, `lint`.
- **Build:**
  - Packages: `bun build --target=node --format=esm --splitting`.
  - Types: `tsc --emitDeclarationOnly` (Bun build doesn't emit `.d.ts`).
  - CLI binary: `bun build --compile` to single-file executable.
- **Lint:** `oxlint` (matches streamerverdict/dynakv).
- **Test:** Vitest + `@effect/vitest`.
- **CI (rxweave repo):** GitHub Actions. `turbo run build typecheck test lint` on push + PR. Runs conformance against Memory + File stores only. Does **not** run cloud conformance (that lives in the cloud repo's CI).
- **Node/Bun engines in package.json:**
  ```json
  { "engines": { "node": ">=22", "bun": ">=1.1" } }
  ```

---

## 12. Execution Plan (Option X: v0.1 local + protocol, v0.2 cloud)

Designed for two cmux agent team panels inside the existing `RxWeave` workspace. Both panels launch `claude --dangerously-skip-permissions`. The teams work on **different repos**, so neither blocks the other.

### Phase 0 — Contract Freeze (before teams spawn)

Single agent or human, in the **new** `rxweave` repo (created at `/Users/derekxwang/Development/incubator/RxWeave/rxweave/`):

1. `git init -b main` inside `rxweave/`.
2. Scaffold 9 packages with `package.json`, `tsconfig.json`, Bun build scripts.
3. `turbo.jsonc`, `tsconfig.base.json`, root `package.json` with workspaces.
4. Land `@rxweave/schema` (envelope, registry, EventDef/EventDefWire, EventId, Cursor, Filter, EventInput, all tagged errors) — fully typed, tested, committed. **Contract-level freeze.**
5. Land `@rxweave/protocol` — RpcGroup, tested, committed.
6. Land `@rxweave/core` — EventStore Tag + conformance harness stub (runs against a provided Live layer), tested.
7. Move this spec into `rxweave/docs/superpowers/specs/` as part of the first commit.
8. `git tag v0.0.1-contract`.

### Phase 1 — Team RX (rxweave local stack, v0.1)

Works in `rxweave` repo. Branches from `v0.0.1-contract`.

1. `@rxweave/store-memory` + shared conformance suite (all 10 test cases).
2. `@rxweave/store-file` (JSONL, Bun fs, bounded PubSub, cold-start recovery).
3. `@rxweave/reactive` (Stream helpers + `minimatch` glob + `Clock`-based `withinWindow`).
4. `@rxweave/runtime` (`defineAgent`, `supervise` on `FiberMap`, `AgentCursorStore`, `withIdempotence`).
5. `@rxweave/cli` (all commands, `bun build --compile`).
6. `apps/dev` — example agents, console demos:
   - `counterAgent` (pure reduce)
   - `echoAgent` (handle with logger + `withIdempotence`)
   - A derivation agent example: `speech.transcribed → task.created`

**Exit criterion for Phase 1:** all v0.1 success criteria (§15) green. Tag `rxweave v0.1.0`. Publish protocol as `@rxweave/protocol@0.1.0` to npm.

### Phase 2 — Team CLOUD (cloud repo + store-cloud client, v0.2)

Runs **in parallel** with Phase 1, **in a different repo** (`cloud/`, sibling to `rxweave/`). Does not depend on rxweave Phase 1 finishing to make progress. Only needs `@rxweave/protocol@0.1.0` (Phase 0 output).

1. `git init -b main` inside `cloud/`. Scaffold via `/kitcn` template (like dynakv).
2. Implement `@rxweave/protocol` handlers on Convex + Hono at `/rxweave/rpc/*`. **Against an in-memory mock EventStore on the server side** — this is a ~100-line Convex-backed implementation that handles all Rpc endpoints and passes the conformance suite from `@rxweave/core/testing/conformance.ts`.
3. Better Auth + API keys (kitcn patterns from dynakv).
4. Minimal dashboard: list events, inspect event with lineage, agent status, API key management.
5. `@rxweave/store-cloud` client implementation (**lives in rxweave repo**; Team CLOUD owns the PRs). Filed against `rxweave` main after Phase 1 is tagged.

**Exit criterion for Phase 2:** `@rxweave/store-cloud` conformance tests green against a deployed cloud dev environment. Tag `rxweave v0.2.0` (adds cloud store). Cloud repo tags its own release separately.

### Coordination

- Each team files PRs against their own repo's main.
- Cross-cutting protocol changes are rare after Phase 0; if needed, land in `rxweave` first, republish `@rxweave/protocol`, cloud team bumps the dep.
- Reviews happen at phase boundaries, plus any time a shared contract is touched.
- Agent teams communicate via cmux panels; neither team modifies the other's repo without a PR.

---

## 13. Non-Goals (v0.1 MVP)

Explicitly out of scope for v0.1 (may appear in v0.2+):

- **Cloud store + cloud repo + dashboard** — deferred to v0.2 (scope Option X). `@rxweave/protocol` is frozen in v0.1 so Team CLOUD can work in parallel, but the cloud repo itself is not a v0.1 deliverable.
- Voice/video pipelines. Envelope is ready; actual ingestion is a later package (`@rxweave/ingest-voice`, etc.).
- LLM agents. `handle` is pure TypeScript; an LLM-agent package can build on top of `defineAgent` later.
- Canvas / whiteboard UI. `apps/dev` is console-only.
- Browser/mobile runtime. Bun + Node 22+ only.
- Per-agent concurrency > 1.
- Cron / scheduled agents.
- Cycle detection for `causedBy`.
- Log rotation / compaction / GC.
- Payload predicates in `Filter`.
- Multi-tenant inside a single rxweave device (tenant is a cloud concept only).

---

## 14. Frozen Implementation Choices

(Previously labeled "Open Implementation Notes"; resolved before planning.)

- **ULID library:** custom implementation (~30 lines) using Effect's `Clock` + `Random` services. Adopted over `ulid` npm package because that one doesn't accept a pluggable clock, which breaks determinism under `TestClock`.
- **Glob matcher:** `minimatch` from npm. Stable, tiny, supports `*` and `**`.
- **Subscribe streaming transport:** `@effect/rpc` over HTTP chunked NDJSON. Exact binding documented in `@rxweave/protocol` README; the server handler uses `HttpServer.server` from `@effect/platform`, and the client uses `HttpClient.client` + `Stream.decodeText` + `Schema.parseJson(EventEnvelope)`.
- **JSONL corruption handling:** on cold-start scan, log + skip bad lines; truncate file to end of last valid line if the last line fails to decode; emit `system.store.recovery` event with `{ skipped, truncatedBytes }` after startup (see §5.5).
- **Cursor format parity across stores:** every adapter (Memory, File, Cloud) implements cursor semantics identically per §4.2. Conformance suite enforces this (see §5.8).

---

## 15. Success Criteria

### v0.1 (rxweave local stack)

MVP is done when:

1. `rxweave init && rxweave dev` runs locally, agents fire on emitted events, stream+inspect work end-to-end.
2. `bun run build && bun run test && bun run typecheck && bun run lint` green across all v0.1 packages (`schema`, `core`, `store-memory`, `store-file`, `reactive`, `runtime`, `protocol`, `cli`).
3. Conformance suite passes for `store-memory` and `store-file` (cloud deferred to v0.2).
4. `apps/dev` contains ≥3 example agents (pure reducer, side-effectful handle, semantic derivation).
5. README in `rxweave` repo explains: what it is, why it exists, 5-minute quickstart, links to agent/CLI references.
6. `@rxweave/protocol@0.1.0` published to npm (frozen contract for Team CLOUD to consume).

### v0.2 (cloud repo + store-cloud client)

Additionally done when:

7. Cloud repo deployed to a dev Convex environment; dashboard shows events, lineage, and agent status for authenticated users.
8. `@rxweave/store-cloud` conformance tests green against that dev environment.
9. `rxweave v0.2.0` tagged; includes `store-cloud` as an installable adapter.
10. `rxweave.config.ts` works transparently for both `FileStore` and `CloudStore` configurations (see §8.3 example).
