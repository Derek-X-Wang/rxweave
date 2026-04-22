import { useEffect } from "react"
import { Cause, Effect, Layer, ManagedRuntime, Stream } from "effect"
import type { Editor, TLRecord } from "tldraw"
import { EventStore } from "@rxweave/core"
import { RXWEAVE_RPC_PATH, SESSION_TOKEN_PATH } from "@rxweave/protocol"
import {
  EventRegistry,
  type Cursor,
  type EventEnvelope,
} from "@rxweave/schema"
import { CloudStore } from "@rxweave/store-cloud"
import {
  CANVAS_SCHEMAS,
  CanvasBindingDeleted,
  CanvasBindingUpserted,
  CanvasShapeDeleted,
  CanvasShapeUpserted,
} from "../server/schemas.js"

// Bidirectional adapter between tldraw's store and RxWeave's RPC
// stream. Talks the same `@effect/rpc` protocol over NDJSON that the
// cloud speaks, so the local loopback path and the remote path differ
// only in `url` and `token`.
//
// Outgoing — user interactions → CloudStore.append:
//   `store.listen({source: 'user', ...})` fires only for changes the
//   user made (drawing, dragging, deleting). We translate each
//   affected shape/binding record into a `canvas.*` event and append
//   it via CloudStore, which round-trips through the embedded server
//   and lands back in the subscribe stream below.
//
// Incoming — CloudStore.subscribe → store.mergeRemoteChanges:
//   Every event the server emits (including our own, round-tripped
//   via append+subscribe) comes back through the NDJSON stream.
//   `mergeRemoteChanges` marks the resulting store edits as
//   source='remote', so our outgoing listener ignores them — no sync
//   loop, no duplicate appends.
//
// Registry digest: the embedded server registers the same four canvas
// schemas during startup. `digestOne` is deterministic over
// (type, version, Schema.ast), so both sides compute an identical
// aggregate digest and `Append` RPCs pass the digest gate without any
// explicit `RegistryPush` round-trip. Flagged here because the moment
// one side's schema list drifts (e.g. a new `canvas.asset.*` type on
// the server alone) the digest mismatch will surface as wire-level
// `registry-out-of-date` on every append — at which point this code
// needs to pivot to `syncRegistry()` from `@rxweave/store-cloud` and
// stand up a second RPC client purely for the negotiation.

export function RxweaveBridge({ editor }: { editor: Editor }) {
  useEffect(() => {
    let disposed = false
    let runtime: ManagedRuntime.ManagedRuntime<
      EventStore | EventRegistry,
      never
    > | null = null
    let unlisten: (() => void) | null = null

    // Per-shape debounce for upserts — a typed label ("F", "Fe",
    // "Fea", …) collapses into a single "settled" event at the end
    // of the typing burst so the suggester agent doesn't fire once
    // per keystroke. Deletes flush any pending upsert for the same id
    // before appending the delete, so a "type-then-immediately-delete"
    // sequence can't leak a stale upsert after the removal. The
    // React cleanup reads `event` off each entry to flush in-flight
    // bursts before the runtime disposes.
    const DEBOUNCE_MS = 2000
    type PendingEvent = { type: string; payload: unknown }
    const pending = new Map<string, { timer: number; event: PendingEvent }>()

    const appendEvent = (event: PendingEvent) => {
      if (!runtime) return
      // `actor: "human"` is the suggester's `actor !== "human"` gate;
      // if we drop this the server defaults actor to `"system"` and
      // the suggester skips every user shape. `ActorId` is a
      // branded `Schema.pattern`-validated string; `as never` opts
      // out of the brand at the call site (matches the upstream
      // pattern in `@rxweave/store-file`'s Live).
      runtime
        .runPromise(
          Effect.gen(function* () {
            const store = yield* EventStore
            yield* store.append([
              {
                type: event.type,
                actor: "human" as never,
                source: "canvas" as never,
                payload: event.payload,
              },
            ])
          }),
        )
        .catch((err) => {
          console.warn("[web] append failed", err)
        })
    }

    const scheduleUpsert = (id: string, event: PendingEvent) => {
      const existing = pending.get(id)
      if (existing !== undefined) clearTimeout(existing.timer)
      const timer = window.setTimeout(() => {
        pending.delete(id)
        appendEvent(event)
      }, DEBOUNCE_MS)
      pending.set(id, { timer, event })
    }

    const flushForDelete = (id: string, event: PendingEvent) => {
      const existing = pending.get(id)
      if (existing !== undefined) clearTimeout(existing.timer)
      pending.delete(id)
      appendEvent(event)
    }

    // Bootstrap: fetch session token → build ManagedRuntime → register
    // schemas → wire outgoing listener → fork incoming subscription.
    // All guarded by `disposed` so React's StrictMode remount doesn't
    // leak a dangling runtime.
    ;(async () => {
      let token: string | null = null
      try {
        const res = await fetch(SESSION_TOKEN_PATH)
        const body = (await res.json()) as { token: string | null }
        token = body.token
      } catch (err) {
        console.warn(
          `[web] ${SESSION_TOKEN_PATH} fetch failed; proceeding tokenless`,
          err,
        )
      }
      if (disposed) return

      // `CloudStore.Live` requires `EventRegistry`; `EventRegistry.Live`
      // also carries the registrations we do below. We want BOTH tags
      // accessible from the runtime *and* we want the same EventRegistry
      // instance used by CloudStore (so `Append`'s digest calc sees the
      // registrations). `Layer.provideMerge` composes them so the
      // output layer exports both `EventStore` + `EventRegistry` with
      // zero remaining requirements, which is what `ManagedRuntime.make`
      // needs. `Layer.merge` would have kept `EventRegistry` in the
      // requirement channel.
      //
      // `url` must include the exact RPC mount path: `@effect/rpc`'s
      // `layerProtocolHttp` POSTs to EXACTLY the URL passed, with no
      // implicit append. Drifting silently routes to vite's 404 and
      // the RPC client hangs pending forever — `RXWEAVE_RPC_PATH` is
      // exported from `@rxweave/server` specifically to keep the two
      // ends coupled. `token === null` ⇒ server is in no-auth mode;
      // omit the `token` provider entirely so CloudStore's auth
      // wiring skips the Authorization header (spec §3.3).
      const layer = CloudStore.Live({
        url: `${window.location.origin}${RXWEAVE_RPC_PATH}/`,
        ...(token === null ? {} : { token: () => token }),
      }).pipe(Layer.provideMerge(EventRegistry.Live))
      runtime = ManagedRuntime.make(layer)

      // Local registry registration — mirrors server-side startup so
      // `client.Append`'s digest calc matches the server's. See the
      // module-level comment for the registry-drift failure mode.
      try {
        await runtime.runPromise(
          Effect.gen(function* () {
            const reg = yield* EventRegistry
            for (const def of CANVAS_SCHEMAS)
              yield* reg
                .register(def)
                // Duplicate on hot-reload re-mount inside a single
                // page load — silently continue rather than hard-fail
                // the bridge init.
                .pipe(Effect.catchTag("DuplicateEventType", () => Effect.void))
          }),
        )
      } catch (err) {
        console.warn("[web] registry setup failed", err)
        return
      }
      // After the last await above: if cleanup fired during registration
      // we'd otherwise attach a listener + fork subscribe on a disposed
      // runtime.
      if (disposed) return

      // Outgoing: tldraw store changes → CloudStore.append. Scoped to
      // `source: 'user'` so the remote-applied incoming events don't
      // loop back out.
      unlisten = editor.store.listen(
        (entry) => {
          const { added, updated, removed } = entry.changes
          // Removed first so an {update, delete} pair for the same id
          // in one entry can't schedule an upsert that beats the
          // delete's flushForDelete to the pending map.
          for (const record of Object.values(removed)) {
            const r = record as TLRecord
            const ev = recordToEvent(r, "deleted")
            if (ev) flushForDelete(r.id, ev)
          }
          for (const record of Object.values(added)) {
            const r = record as TLRecord
            const ev = recordToEvent(r, "upserted")
            if (ev) scheduleUpsert(r.id, ev)
          }
          for (const [, to] of Object.values(updated) as Array<
            [TLRecord, TLRecord]
          >) {
            const ev = recordToEvent(to, "upserted")
            if (ev) scheduleUpsert(to.id, ev)
          }
        },
        { source: "user", scope: "document" },
      )

      // Incoming: two-phase (drain-then-subscribe) instead of a single
      // `subscribe({ cursor: "earliest" })` stream.
      //
      // Why two-phase: WebKit's `fetch` streaming reader buffers
      // aggressively — after a large replay burst flushes, subsequent
      // trickle events (one shape-upsert every few seconds) never reach
      // the reader because the internal buffer never fills enough to
      // trigger another flush. Bun, Node's fetch, and Chrome-family
      // browsers don't exhibit this; Safari/WebKit/cmux-WKWebView does.
      //
      // Sidestep: paginated `queryAfter` draws the history via ordinary
      // request-response HTTP (no long-lived stream, no WebKit buffer
      // trap), then open a fresh subscribe stream from the last-drained
      // cursor — its replay side is empty, so the stream starts
      // delivering live events immediately and no reply-burst/flush
      // race exists.
      //
      // No gap: `queryAfter(cursor, ...)` is cursor-exclusive and
      // `subscribe({ cursor })` is also cursor-exclusive, so an event
      // appended between the last page and the subscribe opening is
      // either in the next page (if we query again) or delivered by
      // subscribe (if it landed after our snapshot) — never both, never
      // missed. We pin `liveCursor` to the latest drained id before
      // opening subscribe.
      const PAGE_SIZE = 500
      runtime.runFork(
        Effect.gen(function* () {
          const store = yield* EventStore
          let liveCursor: Cursor = "earliest"
          while (true) {
            const batch: ReadonlyArray<EventEnvelope> = yield* store.queryAfter(
              liveCursor,
              {},
              PAGE_SIZE,
            )
            applyIncomingBatch(editor, batch)
            // Advance the cursor even on a short final page — otherwise
            // subscribe starts from an older `liveCursor` and re-delivers
            // what we just applied.
            if (batch.length > 0) liveCursor = batch[batch.length - 1]!.id
            if (batch.length < PAGE_SIZE) break
          }
          yield* Stream.runForEach(
            store.subscribe({ cursor: liveCursor }),
            (event) => Effect.sync(() => applyIncoming(editor, event)),
          )
        }).pipe(
          Effect.tapErrorCause((cause) =>
            Effect.sync(() =>
              console.warn("[web] subscribe cause:\n" + Cause.pretty(cause)),
            ),
          ),
        ),
      )
    })()

    return () => {
      disposed = true
      // Stop the outgoing listener first so no new upserts queue while
      // we flush. The flush below fires the most recent event per id
      // (matches `scheduleUpsert`'s "coalesce to last state" contract),
      // which hands the append to the runtime before we dispose it —
      // the append fibers race with dispose but in practice the POST
      // bytes reach Bun before the scope tears down. This is best-
      // effort by design; a full at-least-once story would need
      // `navigator.sendBeacon` against a beacon endpoint.
      if (unlisten) unlisten()
      for (const { timer, event } of pending.values()) {
        clearTimeout(timer)
        appendEvent(event)
      }
      pending.clear()
      // `dispose()` is async but React's cleanup is sync — we fire
      // and forget; the runtime's scope close is idempotent and any
      // in-flight `runPromise`/`runFork` is interrupted.
      if (runtime) void runtime.dispose()
    }
  }, [editor])

  return null
}

// Using `.type` from the imported schemas (not string literals) so a
// schema rename fails at compile time instead of silently dropping
// incoming events through the switch's default arm.
const UPSERTED_TYPES = new Set([
  CanvasShapeUpserted.type,
  CanvasBindingUpserted.type,
])
const DELETED_TYPES = new Set([
  CanvasShapeDeleted.type,
  CanvasBindingDeleted.type,
])

function recordToEvent(
  record: TLRecord,
  op: "upserted" | "deleted",
): { type: string; payload: unknown } | null {
  if (record.typeName === "shape") {
    return op === "deleted"
      ? { type: CanvasShapeDeleted.type, payload: { id: record.id } }
      : { type: CanvasShapeUpserted.type, payload: { record } }
  }
  if (record.typeName === "binding") {
    return op === "deleted"
      ? { type: CanvasBindingDeleted.type, payload: { id: record.id } }
      : { type: CanvasBindingUpserted.type, payload: { record } }
  }
  return null
}

// Single-event apply for the live subscribe path.
// tldraw's `put` throws synchronously on validation failure, so the
// try/catch shields the subscribe fiber from a malformed historical
// record (e.g. shape persisted by an older schema missing `rotation`).
function applyIncoming(
  editor: Editor,
  event: { type: string; payload: unknown },
) {
  const payload = event.payload as { record?: TLRecord; id?: string }
  try {
    editor.store.mergeRemoteChanges(() => {
      if (UPSERTED_TYPES.has(event.type)) {
        if (payload.record) editor.store.put([payload.record])
      } else if (DELETED_TYPES.has(event.type)) {
        if (payload.id) editor.store.remove([payload.id as TLRecord["id"]])
      }
    })
  } catch (err) {
    console.warn("[web] applyIncoming skipped malformed event", event.type, err)
  }
}

// Batched apply for the initial drain — 500 events → 1 tldraw
// `mergeRemoteChanges` transaction instead of 500, so listeners/
// history/undo bookkeeping fires once per page. On a cold load that
// collapses hundreds of separate transactions to one per page.
//
// Must iterate events IN ORDER and apply put/remove in original
// sequence. Grouping all puts before all removes (or vice versa)
// silently breaks `[delete A, upsert A]` semantics — common on
// undo/redo — because the grouped form would apply the put and
// then remove it.
//
// `put([record])` / `remove([id])` inside one `mergeRemoteChanges`
// are cheap — they mutate tldraw's internal change set, which is
// flushed once at transaction end. The saved cost was the per-event
// transaction fanout, not the array-packing.
//
// Per-record try/catch fallback preserves the single-bad-row skip
// behavior: if any record in the page fails tldraw validation the
// whole transaction rolls back, and we re-apply each event through
// `applyIncoming` (which skips offenders individually).
function applyIncomingBatch(
  editor: Editor,
  events: ReadonlyArray<EventEnvelope>,
) {
  if (events.length === 0) return
  try {
    editor.store.mergeRemoteChanges(() => {
      for (const ev of events) {
        const p = ev.payload as { record?: TLRecord; id?: string }
        if (UPSERTED_TYPES.has(ev.type) && p.record) {
          editor.store.put([p.record])
        } else if (DELETED_TYPES.has(ev.type) && p.id) {
          editor.store.remove([p.id as TLRecord["id"]])
        }
      }
    })
  } catch {
    for (const ev of events) applyIncoming(editor, ev)
  }
}
