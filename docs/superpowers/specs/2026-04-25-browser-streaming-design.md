# Browser Streaming — Design Spec

**Date:** 2026-04-25
**Status:** Brainstorming phase complete. Awaiting final user review of spec, then writing-plans.
**Authors:** Derek Wang + Claude (brainstorming session)

**Builds on:** `2026-04-18-rxweave-design.md`, `2026-04-20-cli-agent-collaboration-design.md`. RxWeave at v0.4.1 shipped 2026-04-23 — browser-stuck-events bug noted in `HANDOFF.md` "Deferred follow-ups" #1, #4. Bundles polish items #2, #3, #5 from the same list.

---

## 1. Overview

`apps/web` (the canvas demo) and any future browser client of `@rxweave/store-cloud` exhibit a Safari-only bug: after a large replay burst, subsequent live events stay stuck in WebKit's `fetch` reader buffer until the next ~16 KB of data forces a flush. Bun, Node, and Chromium-family browsers are unaffected. The current `apps/web/src/RxweaveBridge.tsx` two-phase drain workaround handles refresh-state + the first live event, but subsequent trickle events stall.

This spec adds a heartbeat sentinel to the `Subscribe` RPC so any byte-flow on the response stream remains continuous, closing the WebKit gap end-to-end. The same primitive earns liveness detection (silent NAT drop, idle proxy timeout) as a side benefit and is structured as a generally-useful protocol addition rather than a Safari-specific hack.

In parallel, the spec introduces `CloudStore.LiveFromBrowser` — a sibling factory to `CloudStore.Live` that bundles the WebKit drain pattern, browser token bootstrap, and heartbeat opt-in defaults — and folds three small handoff polish items into the same release for clean inventory.

**Goal for v0.5:** *"`apps/web` and third-party browser clients become first-class; subscribers get sub-second live delivery on every browser engine."*

---

## 2. Principles

- **The heartbeat is a protocol primitive, not a transport hack.** It rides the same NDJSON wire as `EventEnvelope`s, decoded by the same `@effect/rpc` machinery. No raw HTTP chunked-comment tricks.
- **Backwards compatibility via opt-in.** The widened `Subscribe` request and response schemas are additive; clients that don't ask for heartbeat get the v0.4 stream behavior bit-for-bit.
- **One implementation, two servers.** `@rxweave/server` and (in a follow-up cloud-v0.3 PR) Convex both consume the same shared `subscribeHandler` from `@rxweave/protocol` — the same pattern locked in for v0.4. No divergent server semantics.
- **Browser concerns belong in their own factory.** Token bootstrap, drain-then-subscribe, heartbeat defaults — all browser-only — live in `CloudStore.LiveFromBrowser`. CLI / Node consumers see no API change.
- **Polish items are bundled, not split.** `registerAll`, `mkdirSync` fold, and `apps/web` schema relocation are small and adjacent to the work; bundling clears the handoff inventory and keeps v0.5 a single coherent release.

---

## 3. Scope

### In scope (rxweave-v0.5)

| Area | Change |
|---|---|
| `@rxweave/protocol` | Add `Heartbeat` schema; widen `Subscribe` request to include optional `heartbeat: { intervalMs }`; widen `Subscribe` success item to `EventEnvelope \| Heartbeat` |
| `@rxweave/protocol` shared handlers | Update `subscribeHandler` to inject heartbeats via `Stream.merge` when requested; clamp `intervalMs` to `[1000, 300_000]` |
| `@rxweave/server` | Picks up new behavior automatically — already routes through `subscribeHandler` |
| `@rxweave/store-cloud` | Refactor `Live` into internal `makeLive` + add `LiveFromBrowser` factory; heartbeat-filter and watchdog in `makeLive` |
| `@rxweave/schema` | `EventRegistry.registerAll(defs, opts?)` helper |
| `@rxweave/server` | Fold `mkdirSync` into `generateAndPersistToken` |
| `apps/web` | Use `LiveFromBrowser`; relocate `server/schemas.ts` → `src/shared/schemas.ts` |

### Out of scope (deferred)

- **Cloud-v0.3** — Convex `subscribeHandler` adoption of the heartbeat field. Lands as a separate PR in the cloud repo, targeted to land close-in-time but independently. Until cloud-v0.3 ships, browser clients connected to cloud-v0.2 fall back to no-heartbeat behavior (the WebKit bug remains there for that combination). See §10.2 for the unknown-field-tolerance question that gates the fallback path.
- **Server-cursor in heartbeat payload.** Heartbeats carry only `at` (timestamp). Adding `serverCursor` is a clean v0.6 extension via additive schema field.
- **Native streaming on Convex (push delivery vs. polling).** Cloud handoff lists this as their "biggest lever" but it's an entirely separate work item; this spec only asks the cloud handler to interleave heartbeat sentinels into its existing polling loop response.
- **Playwright/browser CI.** Manual smoke in Safari before tagging v0.5; no automated browser test harness added.

---

## 4. Protocol additions (`@rxweave/protocol`)

### 4.1 Request schema — `Subscribe`

```ts
SubscribePayload = {
  cursor: Cursor
  filter?: Filter
  heartbeat?: { intervalMs: number }   // NEW; absent = today's behavior
}
```

- `heartbeat` field is optional. Absent → server emits no `Heartbeat` items, behavior identical to v0.4.
- Server clamps `intervalMs` to `[1000, 300_000]` silently. Out-of-range values do not fail the request.

### 4.2 Response schema — `Subscribe` success item

```ts
SubscribeItem = EventEnvelope | Heartbeat

Heartbeat = {
  _tag: "Heartbeat"
  at: number          // server unix-ms when emitted
}
```

- Discriminated by `_tag`. `EventEnvelope` already carries `_tag: "EventEnvelope"`; the new `_tag: "Heartbeat"` value is unambiguous.
- Encoded as one JSON object per NDJSON line — same wire format, no transport changes.
- Payload deliberately minimal (`at` only). Future fields (server cursor, sequence) can be added additively without re-breaking the schema.

### 4.3 Backwards-compatibility invariant

If `heartbeat` is absent in the request, the server MUST NOT emit any `Heartbeat` items. Enforced by a server-side test (§7), not assumption.

### 4.4 Other RPCs

`Append`, `GetById`, `Query`, `QueryAfter`, `RegistrySyncDiff`, `RegistryPush` are untouched.

### 4.5 Schema location

`packages/protocol/src/RxWeaveRpc.ts` — alongside the existing `EventEnvelope` / `SubscribeWireError` definitions. `Heartbeat` declared as a `Schema.Class`.

---

## 5. Server-side emitter

### 5.1 Where it lives

`packages/protocol/src/handlers/Subscribe.ts`. Modifying the shared handler means both `@rxweave/server` and (in cloud-v0.3) Convex pick up the same behavior — the one-implementation guarantee from v0.4 holds.

### 5.2 Behavior

```ts
subscribeHandler({ cursor, filter, heartbeat })
  → Stream<EventEnvelope | Heartbeat, SubscribeWireError, EventStore>
```

- `heartbeat: undefined` — stream is exclusively `EventEnvelope`s wrapped in the wider type. No timer fiber spawned.
- `heartbeat: { intervalMs }` (after clamping) — merge the underlying envelope stream with a heartbeat stream that emits one sentinel **immediately on subscribe-open**, then one every `intervalMs` after. Implemented as `Stream.concat(Stream.succeed(makeHeartbeat()), Stream.repeatEffectWithSchedule(makeHeartbeat, Schedule.spaced(intervalMs)))` merged into the envelope stream via `Stream.merge`. Both sides scoped together: when the subscriber disconnects, the heartbeat fiber is interrupted alongside the envelope subscription.

The eager-first-emit matters: without it, a small live event arriving 1 s after subscribe-open could still stall in WebKit's buffer for the full `intervalMs` (15 s) before the first heartbeat unsticks it. Eager emit closes that window.

### 5.3 Why `Stream.merge` and not a side-channel timer

Effect's `Stream.merge` ties the heartbeat fiber lifetime to the subscribe scope. No leaked timers when a client disconnects mid-replay. `apps/web`'s two-phase drain code in `RxweaveBridge.tsx` continues to work — the heartbeat is just additional `SubscribeItem`s in the same stream.

### 5.4 Replay-burst behavior

Heartbeats begin emitting as soon as the subscribe scope opens. During a 500-event replay burst, sentinels interleave naturally — every `intervalMs` of wall time another sentinel injects, even mid-replay. WebKit's fetch buffer flushes whenever it sees the `\n`-terminated heartbeat line, dragging pending real events out with it.

### 5.5 `@rxweave/server` integration

Zero-touch. The existing `Subscribe` mount routes through `subscribeHandler`; once the handler signature widens, the server emits the new variant automatically.

---

## 6. Client side — `makeLive` + two factories (`@rxweave/store-cloud`)

### 6.1 Factor `Live` into `makeLive`

```ts
// packages/store-cloud/src/CloudStore.ts — internal, not exported
const makeLive = (config: {
  http: HttpClient
  auth: AuthStrategy            // BearerToken | SessionTokenFetch
  heartbeat?: { intervalMs: number }
  drainBeforeSubscribe?: boolean
}): Layer.Layer<EventStore, never, never>

// public API — unchanged surface, both built on makeLive
CloudStore.Live({ origin, token })                  // CLI / Node
CloudStore.LiveFromBrowser({ origin, tokenPath })   // browser
```

### 6.2 `CloudStore.Live` (today's behavior, refactored)

Calls `makeLive` with `auth: BearerToken(token)`, `heartbeat: undefined`, `drainBeforeSubscribe: false`. Wire shape and call-site API unchanged — existing consumers need zero edits.

### 6.3 `CloudStore.LiveFromBrowser` (new)

Calls `makeLive` with:

- `auth: SessionTokenFetch(tokenPath)` — bootstraps via `fetch(tokenPath)` (origin-relative; defaults to `/rxweave/session-token`).
- `heartbeat: { intervalMs: 15_000 }` — opt-in by default.
- `drainBeforeSubscribe: true` — the WebKit workaround.

### 6.4 Drain-then-subscribe

When `drainBeforeSubscribe: true`:

1. On `EventStore.subscribe({ cursor })`, repeatedly call `QueryAfter({ cursor, limit: 1024 })` until empty. Emit each page through the same output stream the user-facing `Stream<EventEnvelope>` consumes.
2. Open `Subscribe({ cursor: <last-id-from-drain>, heartbeat: { intervalMs: 15_000 } })` for the live tail.
3. The `Query`-based drain phase guarantees WebKit's fetch buffer flushes the bulk replay (each `Query` page is a short-lived response that closes per-page). The subscribe phase keeps it flushing via heartbeats.

CLI / Node clients (`Live`) skip step 1: `Subscribe` already handles replay-from-cursor, and they have no fetch-buffer pathology.

### 6.5 Heartbeat filter

The client decoder maps `SubscribeItem → Option<EventEnvelope>` — `Heartbeat` items are dropped silently before reaching the user-facing `Stream<EventEnvelope>`. The filter lives in `makeLive`, so consumers of `EventStore` (reactive, runtime, agents) never see sentinels. No public API change to `EventStore`.

### 6.6 Liveness watchdog

When `heartbeat` is set, `makeLive` tracks "last item received" timestamp per `Subscribe` fiber. If `> 3 × intervalMs` elapses with no item (event or heartbeat), interrupt the subscribe fiber with `WatchdogTimeout` tagged error. Upstream retry classification (already in `@rxweave/runtime` since v0.2.1) treats this as transient and reconnects from the last received cursor. CLI clients without heartbeat skip the watchdog.

### 6.7 Token bootstrap (browser auth strategy)

1. `fetch(tokenPath)` — origin-relative.
2. Cache the returned `rxk_<hex>` token in memory for the layer's lifetime.
3. On 401, refetch once and retry the failed RPC. Two consecutive 401s after refetch → propagate as `AuthFailed`.

`apps/web` already serves `/rxweave/session-token` via `@rxweave/server`'s loopback bootstrap; no server-side change needed.

---

## 7. Error handling

| Scenario | Behavior |
|---|---|
| Heartbeat fiber dies | `Stream.merge` tears down the subscribe scope; surfaces as `SubscribeWireError`. Same code path as today's envelope-stream failure |
| `intervalMs` out of range | Clamped silently to `[1000, 300_000]`. Not a runtime error |
| Unknown `_tag` in `SubscribeItem` (forward-compat) | Schema decode fails → `SubscribeWireError({ reason: "decode-failed" })`. Clients pin `@rxweave/protocol` version |
| Watchdog timeout (`> 3 × intervalMs` silent) | Interrupt subscribe fiber with `WatchdogTimeout` tagged error. `@rxweave/runtime`'s existing retry classification handles reconnect |
| Browser session-token 401 | Refetch once, retry RPC. Two consecutive 401s → `AuthFailed` |

No new error variants beyond `WatchdogTimeout`. Heartbeat-injection failures and clamping reuse existing error shapes.

---

## 8. Testing strategy

### 8.1 Protocol layer (`packages/protocol/test/handlers/Subscribe.test.ts`)

| Test | Asserts |
|---|---|
| Backwards-compat (existing test extended) | When request omits `heartbeat`, no `Heartbeat` items emitted |
| Heartbeat emits at requested interval (NEW) | Request `intervalMs: 100`, advance test clock 350 ms, assert ≥3 heartbeats interleaved with envelopes |
| `intervalMs` clamping (NEW) | Request `intervalMs: 100`, assert effective interval is 1000 ms |

### 8.2 Server end-to-end (`packages/server/test/Server.test.ts`)

| Test | Asserts |
|---|---|
| Heartbeat over the wire (NEW) | `bun:test` runtime, real HTTP, real client, real server. Subscribe with heartbeat; assert sentinel arrives as a JSON line on the NDJSON response |

### 8.3 Client (`packages/store-cloud/test/CloudStore.test.ts`)

| Test | Asserts |
|---|---|
| Heartbeat filter drops sentinels (NEW) | Mixed `Heartbeat` + `EventEnvelope` decoder input → downstream `EventStore` consumer sees only envelopes |
| Drain-then-subscribe ordering (NEW) | Append 100 events, open `LiveFromBrowser`, append 1 more event mid-drain, assert ordering: drained first, then live event |
| Watchdog timeout (NEW) | Mock server opens stream then goes silent past 3× interval; assert client interrupts with `WatchdogTimeout` |
| `LiveFromBrowser` token bootstrap (NEW) | Mock fetch for `/rxweave/session-token` returns `rxk_…`; assert bearer attached on subsequent RPC; assert refetch on 401 |

### 8.4 Conformance suite (`packages/store-cloud/test/conformance.test.ts`)

Unchanged — `LiveFromBrowser` MUST pass the same 22 cases as `Live`. Factory choice is invisible at the `EventStore` interface level.

### 8.5 Polish-item tests

| Item | Test |
|---|---|
| `EventRegistry.registerAll` | Unit test in `packages/schema/test/Registry.test.ts` — success path + duplicate-swallow path |
| `mkdirSync` fold into `generateAndPersistToken` | Existing `packages/server/test/Auth.test.ts` extended with path-with-missing-parent case |
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
): Effect<void, DuplicateEventTypeError, never>
```

`swallowDuplicates: true` ignores `DuplicateEventTypeError` — covers the browser-remount case (`apps/web` bridge re-imports schemas on HMR). Defaults to `false` so silent collisions still fail fast in CLI / dev / server.

Update 4 call sites: `apps/web/server/server.ts`, `apps/web/src/RxweaveBridge.tsx`, `packages/cli/src/commands/dev.ts`, `packages/cli/src/Setup.ts`.

### 9.2 Fold `mkdirSync` into `generateAndPersistToken`

`packages/server/src/Auth.ts`. Move parent-dir mkdir inside `generateAndPersistToken`; callers (`packages/cli/src/commands/serve.ts`, `apps/web/server/server.ts`) drop the boilerplate. Use `fs/promises.mkdir({ recursive: true })` since the call already runs inside an `Effect.tryPromise` boundary.

### 9.3 Relocate `apps/web/server/schemas.ts` → `apps/web/src/shared/schemas.ts`

Bridge currently imports `../server/schemas.js`, crossing the browser/server source boundary. Pure cosmetic relocation. Update three importers: `apps/web/server/server.ts`, `apps/web/src/RxweaveBridge.tsx`, plus any test file.

---

## 10. Migration & compatibility

### 10.1 v0.4.x → v0.5

- **`@rxweave/store-cloud` consumers using `Live`:** no changes. `Live` is preserved as a thin wrapper over `makeLive`; semantics and types are bit-for-bit unchanged.
- **`apps/web`:** swap manual `apps/canvas`-era bridge for `CloudStore.LiveFromBrowser`. The two-phase drain code in `RxweaveBridge.tsx` is removed (replaced by `drainBeforeSubscribe: true` inside `makeLive`).
- **CLI:** unchanged. `rxweave stream --follow` does not opt in to heartbeat (no benefit at the terminal).
- **`@rxweave/protocol` schema:** old clients (v0.4.x) connecting to a v0.5 server send no `heartbeat` field; server emits no sentinels; behavior identical to v0.4. Old servers receiving a v0.5 client's `heartbeat` field ignore it (extra fields are tolerated by `@effect/rpc` schema decode); v0.5 client gets no sentinels back, so the watchdog never fires (silent stream is treated as "no events," not as failure — no regression vs. v0.4).

### 10.2 Cloud-v0.3 (separate PR) and the unknown-field tolerance question

Convex `subscribeHandler` reads the new `heartbeat` request field and interleaves sentinels into its polling loop's response stream. Until cloud-v0.3 ships, the v0.5 → cloud-v0.2 path depends on whether `@effect/rpc`'s server-side schema decode rejects requests with an unknown `heartbeat` field, or tolerates them.

- **If tolerated:** v0.5 client → cloud-v0.2 server degrades cleanly — server ignores the field, emits no heartbeats, browser sees today's behavior including the WebKit bug. No client-side action required.
- **If rejected:** v0.5 client → cloud-v0.2 server fails `Subscribe` outright. To handle this, `LiveFromBrowser` accepts an explicit `heartbeat: false` config override that suppresses the request field entirely, restoring v0.4 wire shape. Documented as the workaround for talking to cloud-v0.2 from a v0.5 client.

The first task of the implementation plan verifies which behavior `@effect/rpc` exhibits and adjusts the spec or the `LiveFromBrowser` API as needed.

---

## 11. References

- Handoff: `docs/HANDOFF.md` — "Deferred follow-ups" #1, #2, #3, #4, #5
- v0.4 design: `docs/superpowers/specs/2026-04-20-cli-agent-collaboration-design.md`
- v0.1 design: `docs/superpowers/specs/2026-04-18-rxweave-design.md`
- Cloud handoff: `../cloud/docs/HANDOFF.md` — "Biggest lever — native streaming" provides the cloud-v0.3 followup landscape
- WebKit fetch-buffer behavior: empirically observed in `apps/web/src/RxweaveBridge.tsx` two-phase drain comment
