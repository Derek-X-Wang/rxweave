# Browser Streaming — Design Spec

**Date:** 2026-04-25
**Status:** Brainstorming phase complete. One Codex review pass incorporated (2026-04-25 — see "Review pass log" below). Awaiting final user review of revised spec, then writing-plans.
**Authors:** Derek Wang + Claude (brainstorming session) with Codex (one independent review pass).

**Builds on:** `2026-04-18-rxweave-design.md`, `2026-04-20-cli-agent-collaboration-design.md`. RxWeave at v0.4.1 shipped 2026-04-23 — browser-stuck-events bug noted in `HANDOFF.md` "Deferred follow-ups" #1, #4. Bundles polish items #2, #3, #5 from the same list.

---

## 1. Overview

`apps/web` (the canvas demo) and any future browser client of `@rxweave/store-cloud` exhibit a Safari-only bug: after a large replay burst, subsequent live events stay stuck in WebKit's `fetch` reader buffer until the next byte arrival forces a flush. Bun, Node, and Chromium-family browsers are unaffected. The current `apps/web/src/RxweaveBridge.tsx` two-phase drain workaround handles refresh-state + the first live event, but subsequent trickle events stall.

This spec adds a heartbeat sentinel to the `Subscribe` RPC so the response stream emits a byte every N seconds whether or not real events flow. Each heartbeat is a separate `@effect/rpc` `Chunk` frame whose `values` array contains one `Heartbeat`; that's enough byte-traffic to keep WebKit's reader buffer flushing. Same primitive earns liveness detection (silent NAT drop, idle proxy timeout) as a side benefit and is structured as a generally-useful protocol addition rather than a Safari-specific hack.

In parallel, the spec introduces `CloudStore.LiveFromBrowser` — a sibling factory to `CloudStore.Live` that bundles the WebKit drain pattern, browser token bootstrap, and heartbeat opt-in defaults — and folds three small handoff polish items into the same release for clean inventory.

**Goal for v0.5:** *"`apps/web` and third-party browser clients become first-class; subscribers get sub-second live delivery on every browser engine."*

---

## 2. Principles

- **The heartbeat is a protocol primitive, not a transport hack.** It rides the same `@effect/rpc` NDJSON wire as `EventEnvelope`s, decoded by the same machinery. No raw HTTP chunked-comment tricks.
- **Backwards compatibility via opt-in + Effect Schema's drop-unknown semantics.** The widened `Subscribe` request and response schemas are additive; clients that don't ask for heartbeat get v0.4-bit-for-bit behavior. Old servers that don't know the new field silently drop it (Effect `Schema.Struct` decode behavior — confirmed by Codex tracing `node_modules/@effect/rpc/src/RpcServer.ts:569`).
- **One implementation, two servers.** `@rxweave/server` and (in a follow-up cloud-v0.3 PR) Convex both consume the same shared `subscribeHandler` from `@rxweave/protocol` — the one-implementation guarantee from v0.4 holds. No divergent server semantics.
- **Browser concerns belong in their own factory.** Token bootstrap, drain-then-subscribe, heartbeat defaults, library-owned reconnect — all browser-only — live in `CloudStore.LiveFromBrowser`. CLI / Node consumers see no API change.
- **Per-subscriber state, not layer-global state.** Today's `lastDelivered` Ref is shared across every `subscribe` call on a given `Live` layer. v0.5 moves cursor-resume state inside `subscribe` so concurrent subscribers don't interfere — necessary for the new browser drain flow, beneficial for the existing `Live` flow.
- **Polish items are bundled, not split.** `registerAll`, `mkdirSync` fold, and `apps/web` schema relocation are small and adjacent to the work; bundling clears the handoff inventory and keeps v0.5 a single coherent release.

---

## 3. Scope

### In scope (rxweave-v0.5)

| Area | Change |
|---|---|
| `@rxweave/protocol` | Add `Heartbeat` `Schema.TaggedStruct`; widen `Subscribe` request to include optional `heartbeat: { intervalMs }`; widen `Subscribe` success to `Schema.Union(Heartbeat, EventEnvelope)` |
| `@rxweave/protocol` shared handlers | Update `subscribeHandler` to inject heartbeats via `Stream.merge` when requested; clamp `intervalMs` to `[1000, 300_000]` |
| `@rxweave/server` | Picks up new behavior automatically — already routes through `subscribeHandler` |
| `@rxweave/store-cloud` | Refactor existing `Live` internals into a private `makeLive` core; lift `lastDelivered` Ref into per-subscribe scope; add `LiveFromBrowser` factory; add heartbeat-filter and watchdog inside `makeLive` |
| `@rxweave/schema` | `EventRegistry.registerAll(defs, opts?)` helper with digest-aware duplicate handling |
| `@rxweave/server` | Fold `mkdirSync` into `generateAndPersistToken` (synchronous; matches existing `writeFileSync` style) |
| `apps/web` | Use `LiveFromBrowser`; relocate `server/schemas.ts` → `src/shared/schemas.ts` |

### Out of scope (deferred)

- **Cloud-v0.3** — Convex `subscribeHandler` adoption of the heartbeat field. Lands as a separate PR in the cloud repo, targeted to land close-in-time but independently. Until cloud-v0.3 ships, browser clients connected to cloud-v0.2 fall back to no-heartbeat behavior (the WebKit bug remains there for that combination, but the protocol degrades cleanly — see §10).
- **Server-cursor in heartbeat payload.** Heartbeats carry only `at` (timestamp). Adding `serverCursor` is a clean v0.6 extension via additive schema field.
- **Native streaming on Convex (push delivery vs. polling).** Cloud handoff lists this as their "biggest lever" but it's an entirely separate work item; this spec only asks the cloud handler to interleave heartbeat sentinels into its existing polling-loop response stream.
- **Playwright/browser CI.** Manual smoke in Safari before tagging v0.5; no automated browser test harness added.

---

## 4. Protocol additions (`@rxweave/protocol`)

### 4.1 Request schema — `Subscribe`

```ts
SubscribePayload = Schema.Struct({
  cursor: Cursor,
  filter: Schema.optional(Filter),
  heartbeat: Schema.optional(Schema.Struct({ intervalMs: Schema.Number }))   // NEW
})
```

- `heartbeat` field is optional. Absent → server emits no `Heartbeat` items, behavior identical to v0.4.
- Server clamps `intervalMs` to `[1000, 300_000]` silently. Out-of-range values do not fail the request.

### 4.2 Response schema — `Subscribe` success

```ts
Subscribe.success = Schema.Union(Heartbeat, EventEnvelope)

Heartbeat = Schema.TaggedStruct("Heartbeat", {
  at: Schema.Number          // server unix-ms when emitted
})
```

- `Heartbeat` carries an explicit `_tag: "Heartbeat"` (via `Schema.TaggedStruct`). `EventEnvelope` (defined as `Schema.Class<EventEnvelope>("EventEnvelope")(...)` at `packages/schema/src/Envelope.ts:5`) carries no `_tag` field. `Schema.Union` resolves the variant structurally — Heartbeat decode succeeds only when the input has `_tag: "Heartbeat"`; EventEnvelope decode runs otherwise. Order Heartbeat first in the union for clarity.
- Payload deliberately minimal (`at` only). Future fields (server cursor, sequence) can be added additively without re-breaking the schema.

### 4.3 Wire format reality

`@effect/rpc` does NOT emit one JSON object per NDJSON line. Each yielded stream value becomes a `RpcMessage.Chunk` frame whose `values` array carries the items (see `node_modules/@effect/rpc/src/RpcMessage.ts:187`, `node_modules/@effect/rpc/src/RpcServer.ts:391`). Implications:

- A replay burst from the local stores (e.g., `Stream.fromIterable(allEvents)` in `packages/store-memory/src/MemoryStore.ts:86` and `packages/store-file/src/FileStore.ts:109`) can produce **one chunk frame containing many envelopes** — heartbeats merged via `Stream.merge` cannot interleave inside that single chunk.
- After the replay chunk is delivered, every subsequent envelope and every heartbeat becomes its own `Chunk` frame. The post-replay byte traffic is what unsticks WebKit's fetch buffer; the in-burst heartbeat injection is irrelevant because the burst itself fills the buffer enough to flush.
- Server end-to-end tests (§8) MUST decode the `RpcMessage` envelope, then inspect `Chunk.values` for the sentinel — not look for a top-level `{_tag: "Heartbeat"}` JSON object on the wire.

### 4.4 Backwards-compatibility invariants

1. If `heartbeat` is absent in the request, the server MUST NOT emit any `Heartbeat` items. Enforced by a server-side test (§8).
2. Old servers (v0.4-shipped, including cloud-v0.2 via Convex) decode the request payload via `Schema.decodeUnknown(rpc.payloadSchema)` (`node_modules/@effect/rpc/src/RpcServer.ts:569`) backed by `Schema.Struct`. Effect `Struct` drops unknown keys; the `heartbeat` field is silently ignored, and the server emits today's behavior — `EventEnvelope`-only stream. No client-side opt-out needed; no breaking change.

### 4.5 Other RPCs

`Append`, `GetById`, `Query`, `QueryAfter`, `RegistrySyncDiff`, `RegistryPush` are untouched.

### 4.6 Schema location

`packages/protocol/src/RxWeaveRpc.ts` — alongside the existing `EventEnvelope` import and `SubscribeWireError` definitions. `Heartbeat` declared as a `Schema.TaggedStruct` in the same file (or a sibling `Schemas.ts` if the user prefers; trivial to relocate).

---

## 5. Server-side emitter

### 5.1 Where it lives

`packages/protocol/src/handlers/Subscribe.ts`. Modifying the shared handler means both `@rxweave/server` and (in cloud-v0.3) Convex pick up the same behavior — the one-implementation guarantee from v0.4 holds.

### 5.2 Behavior

```ts
subscribeHandler({ cursor, filter, heartbeat })
  → Stream<EventEnvelope | Heartbeat, SubscribeWireError, EventStore>
```

- `heartbeat: undefined` — stream is `EventEnvelope`-only wrapped in the wider type. No timer fiber spawned.
- `heartbeat: { intervalMs }` (after clamping) — merge the underlying envelope stream with `Stream.repeatEffectWithSchedule(makeHeartbeat, Schedule.spaced(intervalMs))` via `Stream.merge`. Both sides scoped together: when the subscriber disconnects, the heartbeat fiber is interrupted alongside the envelope subscription.

**First-emit semantics:** `Stream.repeatEffectWithSchedule` already emits once before consulting the schedule (verified by Codex against `node_modules/effect/src/internal/stream.ts:5435`). Use `repeatEffectWithSchedule` alone — do NOT prepend `Stream.succeed(makeHeartbeat())`, that would produce two immediate heartbeats. The first heartbeat emits at t=0 (subscribe-open); subsequent every `intervalMs` after the previous emit (`Schedule.spaced` measures from end-of-last-execution).

### 5.3 Why `Stream.merge` and not a side-channel timer

Effect's `Stream.merge` ties the heartbeat fiber lifetime to the subscribe scope. No leaked timers when a client disconnects mid-replay. `apps/web`'s two-phase drain code in `RxweaveBridge.tsx` continues to work — the heartbeat is just additional `SubscribeItem`s in the same stream.

### 5.4 Backpressure note

HTTP transport in `@effect/rpc` has `supportsAck: false` (`node_modules/@effect/rpc/src/RpcServer.ts:1076`), so a slow browser reader doesn't apply backpressure to the heartbeat fiber — heartbeats accumulate in the server-side mailbox at the requested cadence regardless of client drain rate. This is the desired behavior (the heartbeat's job is to keep emitting *to* the client, not to be paced *by* the client) and matches existing envelope-stream behavior. Document this in the handler comments so a future reader doesn't mistake it for a bug.

### 5.5 `@rxweave/server` integration

Zero-touch. The existing `Subscribe` mount routes through `subscribeHandler`; once the handler signature widens, the server emits the new variant automatically.

---

## 6. Client side — `makeLive` + two factories (`@rxweave/store-cloud`)

### 6.1 Refactor existing `Live` to share a private `makeLive` core

```ts
// packages/store-cloud/src/CloudStore.ts — internal, not exported
const makeLive = (config: {
  url: string                                // RPC endpoint URL (Live: caller-supplied; LiveFromBrowser: derived from origin)
  transformClient: HttpClientTransform       // existing per-auth-mode wiring
  heartbeat?: { intervalMs: number }         // browser opts in; CLI omits
  drainBeforeSubscribe?: boolean             // browser true; CLI false
}): Layer.Layer<EventStore, never, EventRegistry>

// public API — same surfaces as today, both built on makeLive
CloudStore.Live({ url, token? })                                    // CLI / Node — unchanged
CloudStore.LiveFromBrowser({ origin, tokenPath?, heartbeat? })     // browser — new
```

### 6.2 `CloudStore.Live` — preserved behavior

API unchanged: `{ url: string, token?: TokenProvider }`. Internally calls `makeLive({ url: opts.url, transformClient: <existing per-auth-mode wiring>, heartbeat: undefined, drainBeforeSubscribe: false })`. The existing public surface and internal `makeCloudEventStore` re-export through `src/index.ts:2` are preserved bit-for-bit; only the internal refactor lifts `lastDelivered` into per-subscribe scope (see §6.7).

### 6.3 `CloudStore.LiveFromBrowser` — new

```ts
LiveFromBrowser(opts: {
  origin: string                                  // e.g., window.location.origin
  tokenPath?: string                              // default: "/rxweave/session-token"
  heartbeat?: { intervalMs: number }              // default: { intervalMs: 15_000 }
}): Layer.Layer<EventStore, never, EventRegistry>
```

- `origin` is the host (no path); `LiveFromBrowser` constructs `${origin}/rxweave/rpc/` for the RPC endpoint and `${origin}${tokenPath}` for token bootstrap. The path-construction split is the reason `Live` keeps `url` (full endpoint URL) while `LiveFromBrowser` introduces `origin` — `LiveFromBrowser` needs *two* paths.
- `heartbeat` defaults to 15-second interval. Per the brainstorming decision, opt-in lets the sentinel payload extend additively in v0.6; the browser case opts in by default because that's where the byte-flow benefit lives.
- Internally calls `makeLive({ url: <constructed>, transformClient: SessionTokenFetch(opts.tokenPath ?? "/rxweave/session-token"), heartbeat: opts.heartbeat ?? { intervalMs: 15_000 }, drainBeforeSubscribe: true })`.

### 6.4 Drain-then-subscribe

When `drainBeforeSubscribe: true`:

1. On `EventStore.subscribe({ cursor })`, repeatedly call `QueryAfter({ cursor, limit: 1024 })` until empty. Emit each page through the same output stream the user-facing `Stream<EventEnvelope>` consumes.
2. Open `Subscribe({ cursor: <last-id-from-drain>, heartbeat: <config> })` for the live tail.
3. The `Query`-based drain phase guarantees WebKit's fetch buffer flushes the bulk replay (each `Query` page is a short-lived response that closes per-page). The subscribe phase keeps it flushing via heartbeats.

**Race-free cursor handoff guaranteed by the existing protocol.** Both `MemoryStore.subscribe` (`packages/store-memory/src/MemoryStore.ts:75`) and `FileStore.subscribe` (`packages/store-file/src/FileStore.ts:99`) take a snapshot and subscribe to the pubsub under the same lock, then replay `id > cursor` and live-filter past `snapshotMax`. Convex's `subscribeHandler` polls `queryAfter(currentCursor)` forever (`../cloud/packages/backend/convex/rxweaveRpc.ts:146`). An event appended between the final `QueryAfter` page and the `Subscribe` open is therefore either part of `Subscribe`'s snapshot replay or its later live delivery — never lost, never duplicated. §8 includes an explicit test for this race.

CLI / Node clients (`Live`) skip step 1: `Subscribe` already handles replay-from-cursor, and they have no fetch-buffer pathology.

### 6.5 Heartbeat filter — ordering matters

The current `Live` subscribe path is:

```ts
client.Subscribe(...).pipe(Stream.tap((e) => Ref.set(lastDelivered, e.id)))
```

With heartbeats in the stream, this code would attempt `Ref.set(lastDelivered, undefined)` for every heartbeat (heartbeats have no `id`). The new pipeline ordering:

```ts
client.Subscribe({ ..., heartbeat })
  .pipe(Stream.tap(updateWatchdog))                                 // (1) before filter — watchdog observes EVERY item incl. heartbeats
  .pipe(Stream.filterMap(item =>
    item._tag === "Heartbeat" ? Option.none() : Option.some(item))) // (2) drop heartbeats from user-facing stream
  .pipe(Stream.tap(e => Ref.set(lastDelivered, e.id)))              // (3) after filter — only sees envelopes with valid `id`
```

The cursor tap MUST run after the heartbeat filter; the watchdog tap MUST run before it. Encoded in §8 as a regression test asserting `lastDelivered` is unchanged after a heartbeat-only window.

### 6.6 Liveness watchdog

When `heartbeat` is set, `makeLive` arms a per-subscribe `Ref<number | undefined>` `lastHeartbeatAt`:

- Initial value: `undefined`.
- On every `Heartbeat` item: set `lastHeartbeatAt = now`. (Done in step (1) of §6.5.)
- A scoped fiber polls `now - lastHeartbeatAt > 3 × intervalMs` every second. Triggers `WatchdogTimeout` only if `lastHeartbeatAt !== undefined`.

The "only-after-first-heartbeat" arming closes the false-positive case where heartbeat is requested but the server (e.g., cloud-v0.2) doesn't emit them — the watchdog never arms, never fires.

**Reconnect plumbing — has to be wired correctly to actually retry.** The existing `Live` retry path in `packages/store-cloud/src/CloudStore.ts:170` is `Stream.retry(Schedule.exponential(...))` AFTER a `Stream.mapError`. To make `WatchdogTimeout` retryable:

1. Inject the watchdog INSIDE the `connect` Effect (before the existing `Stream.retry`), as `Stream.timeout(maxIdleDuration)` or equivalent.
2. The `WatchdogTimeout` failure must be classified retryable in `packages/store-cloud/src/Retry.ts`'s `isRetryable` allowlist.
3. The existing `Stream.mapError` to `SubscribeError` runs after retry as today.

CLI clients without heartbeat skip the watchdog entirely (no fiber, no extra error variant).

### 6.7 Per-subscriber cursor state

Today's `lastDelivered` Ref is created once in the `makeCloudEventStore` closure (`packages/store-cloud/src/CloudStore.ts:121`) — shared across every `subscribe` call on a layer. Concurrent subscribers (e.g., the apps/web bridge subscribing twice during HMR) clobber each other's resume cursor.

**v0.5 lifts the Ref creation INSIDE `subscribe`** so each subscribe gets its own:

```ts
subscribe: ({ cursor, filter }) => Stream.unwrap(
  Effect.gen(function* () {
    const lastDelivered = yield* Ref.make<Cursor>("latest")  // per-subscribe
    // ... connect logic uses the local Ref
  })
)
```

This is a behavior change from v0.4 but a correctness fix — no consumer relies on the layer-global semantic, and the test suite (§8) gains a "two concurrent subscribers don't share cursor" assertion. `lastAppended` (used by `latestCursor`) stays layer-global because that's its actual contract.

### 6.8 Token bootstrap (browser auth strategy)

1. `fetch(${origin}${tokenPath})` — origin-relative, defaults to `/rxweave/session-token`.
2. Cache the returned `rxk_<hex>` token in memory for the layer's lifetime.
3. On 401 from any RPC: invalidate the cache, refetch the token, then **retry the original failed request** (not just the next one). Two consecutive 401s after refetch → propagate as `AuthFailed`.

Note: today's `withRefreshOn401` (`packages/store-cloud/src/Auth.ts:64`) only invalidates the cache; it doesn't replay the failed request. `LiveFromBrowser` extends this to actually retry.

`apps/web` already serves `/rxweave/session-token` via `@rxweave/server`'s loopback bootstrap; no server-side change needed.

---

## 7. Error handling

| Scenario | Behavior |
|---|---|
| Heartbeat fiber dies | `Stream.merge` tears down the subscribe scope; surfaces as `SubscribeWireError`. Same code path as today's envelope-stream failure |
| `intervalMs` out of range | Clamped silently to `[1000, 300_000]`. Not a runtime error |
| Future-version sentinel `_tag` (e.g., `_tag: "ProgressMarker"` in v0.6) | Schema decode fails → surfaces as `RpcClientError` / Effect defect (NOT `SubscribeWireError`; that's a server-modeled error). Clients pin `@rxweave/protocol` version |
| Watchdog timeout (`> 3 × intervalMs` silent, only after first heartbeat observed) | Tagged `WatchdogTimeout` error, classified retryable, triggers existing `Stream.retry` reconnect from `lastDelivered` cursor |
| Browser session-token 401 | Invalidate cache, refetch token, retry the failed RPC. Two consecutive 401s → `AuthFailed` |

New error variant: `WatchdogTimeout` (in `@rxweave/store-cloud`'s internal error union, classified retryable). No new wire error.

---

## 8. Testing strategy

### 8.1 Protocol layer (`packages/protocol/test/handlers/Subscribe.test.ts`)

| Test | Asserts |
|---|---|
| Backwards-compat (extends existing test) | When request omits `heartbeat`, no `Heartbeat` items emitted in the merged stream |
| First heartbeat emits immediately (NEW) | Request `intervalMs: 100`, advance test clock 0 ms, assert exactly one `Heartbeat` already in the buffer (regression guard against double-immediate-emit) |
| Heartbeat cadence (NEW) | Request `intervalMs: 100`, advance test clock 350 ms, assert ≥3 heartbeats interleaved with envelopes |
| `intervalMs` clamping (NEW) | Request `intervalMs: 100`, assert effective interval is 1000 ms; request `intervalMs: 999`, same; request `300_001`, effective 300_000; request `0` and negative, both clamp to 1000 |
| Old-server unknown-field tolerance (NEW) | Decode a `SubscribePayload` against a schema that doesn't include `heartbeat`, send a request body that does include it, assert decode succeeds and field is dropped |

### 8.2 Server end-to-end (`packages/server/test/Server.test.ts`)

| Test | Asserts |
|---|---|
| Heartbeat over the wire (NEW) | `bun:test` runtime, real HTTP, real client, real server. Subscribe with heartbeat; assert sentinel arrives as a `RpcMessage.Chunk` frame whose `values[0]._tag === "Heartbeat"` (NOT a top-level JSON line — see §4.3) |

### 8.3 Client (`packages/store-cloud/test/CloudStore.test.ts`)

| Test | Asserts |
|---|---|
| Heartbeat filter drops sentinels from user-facing stream (NEW) | Mixed `Heartbeat` + `EventEnvelope` decoder input → downstream `EventStore` consumer sees only envelopes |
| Cursor unchanged by heartbeats (NEW) | Feed N heartbeats only (no envelopes) into the pipeline, assert `lastDelivered` stays at its initial value (regression guard for §6.5 ordering) |
| Drain-then-subscribe ordering (NEW) | Append 100 events, open `LiveFromBrowser`, append 1 more event mid-drain, assert ordering: drained first, then live event |
| Append between drain-empty and subscribe-open (NEW) | Append 50 events, drain to empty, append 1 more event before `Subscribe` opens, assert that event arrives via Subscribe's snapshot replay (cursor handoff race test) |
| Concurrent subscribers don't share cursor (NEW) | Open two subscribes on the same layer, advance one further than the other, interrupt one, assert the other's resume cursor reflects only its own deliveries (regression guard for §6.7) |
| Watchdog timeout triggers reconnect (NEW) | Mock server that opens stream, emits one heartbeat to arm the watchdog, then goes silent past 3× interval. Assert `WatchdogTimeout` fires and the existing `Stream.retry` re-opens the subscription |
| Watchdog does NOT fire when no heartbeat ever observed (NEW) | Mock server that emits envelopes but no heartbeats (simulating cloud-v0.2). Assert no `WatchdogTimeout`, stream continues |
| `LiveFromBrowser` token bootstrap (NEW) | Mock fetch for `/rxweave/session-token` returns `rxk_…`; assert bearer attached on subsequent RPC; on 401, assert the **failed request itself is retried** with the new token (not just the cache invalidated) |
| Future-sentinel decode failure (NEW) | Inject a frame with `_tag: "ProgressMarker"` into the test stream; assert the client surfaces `RpcClientError` / defect, not `SubscribeWireError` |

### 8.4 Conformance suite (`packages/store-cloud/test/conformance.test.ts`)

Unchanged — `LiveFromBrowser` MUST pass the same 22 cases as `Live`. Factory choice is invisible at the `EventStore` interface level.

### 8.5 Polish-item tests

| Item | Test |
|---|---|
| `EventRegistry.registerAll` happy path | `packages/schema/test/Registry.test.ts` — register a fresh batch, assert all defs registered |
| `registerAll({ swallowDuplicates: true })` with matching digest | Re-register the same batch, assert no error and registry is unchanged |
| `registerAll({ swallowDuplicates: true })` with conflicting digest | Re-register with one def having a different shape under the same name, assert `DuplicateEventTypeError` is still surfaced (swallow is digest-aware) |
| `mkdirSync` fold | `packages/server/test/Auth.test.ts` extended with path-with-missing-parent case — `generateAndPersistToken` succeeds even when the parent dir doesn't exist |
| `apps/web` schema relocation | Verified by existing build / typecheck / lint pipeline |

### 8.6 Coverage gap intentionally left

No browser-driven Playwright test for the WebKit fetch-buffer fix. The mechanism is solved at the protocol layer (write a byte → fetch reader unblocks); reproducing the browser pathology in CI is not worth the dependency. Manual smoke (open `apps/web` in Safari, append 1000 events, watch live tail flow) before tagging v0.5.

---

## 9. Polish items

Three independent cleanups bundled into v0.5. Each lands as its own commit within the v0.5 PR for review hygiene; none gates the protocol work.

### 9.1 `EventRegistry.registerAll(defs, opts?)`

`packages/schema/src/Registry.ts`. Method on the existing `EventRegistry` service:

```ts
registerAll(
  defs: ReadonlyArray<EventDef>,
  opts?: { swallowDuplicates?: boolean }
): Effect<void, DuplicateEventType, never>
```

Semantics for `swallowDuplicates: true`:

- For each def, check if the registry already has a def under the same `type`.
- If absent → `register(def)`.
- If present **and** the existing def's digest matches the new def's digest → skip silently (idempotent re-registration; covers the apps/web HMR remount case).
- If present **and** digests differ → fail with `DuplicateEventType` regardless of the flag (you didn't mean to shadow a real schema with an incompatible one).

Defaults to `false` so silent collisions still fail fast in CLI / dev / server.

Update 4 call sites: `apps/web/server/server.ts`, `apps/web/src/RxweaveBridge.tsx`, `packages/cli/src/commands/dev.ts`, `packages/cli/src/Setup.ts`.

### 9.2 Fold `mkdirSync` into `generateAndPersistToken`

`packages/server/src/Auth.ts`. The function is `Effect.sync` with `writeFileSync` and `chmodSync` (`packages/server/src/Auth.ts:38`). Add `mkdirSync(dirname(opts.tokenFile), { recursive: true })` synchronously inside the same `Effect.sync` body, BEFORE `writeFileSync`. Callers (`packages/cli/src/commands/serve.ts:111`, `apps/web/server/server.ts:34`) drop their hand-rolled mkdir prelude.

### 9.3 Relocate `apps/web/server/schemas.ts` → `apps/web/src/shared/schemas.ts`

Bridge currently imports `../server/schemas.js`, crossing the browser/server source boundary. Pure cosmetic relocation. Update three importers: `apps/web/server/server.ts`, `apps/web/src/RxweaveBridge.tsx`, plus any test file. Verify `bun --watch server/server.ts` (`apps/web/package.json:8`) restarts on `src/shared/schemas.ts` edits — the watch glob may need updating.

---

## 10. Migration & compatibility

### 10.1 v0.4.x → v0.5

- **`@rxweave/store-cloud` consumers using `Live`:** no public API changes. `Live` is preserved as a thin wrapper over `makeLive`; the `{ url, token? }` signature and observable behavior are bit-for-bit unchanged with one exception: per-subscriber cursor state (§6.7) is a behavior fix, not a contract change — concurrent subscribers now don't interfere where they previously could.
- **`apps/web`:** swap manual bridge code for `CloudStore.LiveFromBrowser`. The two-phase drain code in `RxweaveBridge.tsx` is removed (replaced by `drainBeforeSubscribe: true` inside `makeLive`).
- **CLI:** unchanged. `rxweave stream --follow` does not opt in to heartbeat (no benefit at the terminal).
- **`@rxweave/protocol` schema:** old clients (v0.4.x) connecting to a v0.5 server send no `heartbeat` field; server emits no sentinels; behavior identical to v0.4. Old servers (cloud-v0.2) receiving a v0.5 client's `heartbeat` field drop it via `Schema.Struct`'s unknown-key behavior; the v0.5 client gets no sentinels back; the watchdog is never armed (because no heartbeat observed) so it never falsely triggers. Browser still suffers WebKit bug against cloud-v0.2 until cloud-v0.3 ships, but the protocol contract holds.

### 10.2 Cloud-v0.3 (separate PR)

Convex `subscribeHandler` reads the new `heartbeat` request field and interleaves sentinels into its polling-loop response stream. Once cloud-v0.3 ships, browser clients of cloud get the WebKit fix end-to-end.

---

## 11. Review pass log

| Date | Reviewer | Findings |
|---|---|---|
| 2026-04-25 | Codex (deep, 8 min, slug `20260426-045347-claude-to-codex-3b6988`) | 10 spec corrections (wire format, eager-emit double-emit, discriminator claim, url/origin API mismatch, watchdog vs old-server contradiction, watchdog reconnect plumbing, mkdir fold premise, swallowDuplicates semantics, filter ordering, unknown-field tolerance now-knowable) + 2 scope expansions (per-subscriber cursor state, library-owned reconnect inside `LiveFromBrowser`). All accepted; this revision incorporates them. |

---

## 12. References

- Handoff: `docs/HANDOFF.md` — "Deferred follow-ups" #1, #2, #3, #4, #5
- v0.4 design: `docs/superpowers/specs/2026-04-20-cli-agent-collaboration-design.md`
- v0.1 design: `docs/superpowers/specs/2026-04-18-rxweave-design.md`
- Cloud handoff: `../cloud/docs/HANDOFF.md` — "Biggest lever — native streaming" provides the cloud-v0.3 followup landscape
- WebKit fetch-buffer behavior: empirically observed in `apps/web/src/RxweaveBridge.tsx` two-phase drain comment
- Codex review transcript: `/tmp/counsel/20260426-045347-claude-to-codex-3b6988/codex.md`
