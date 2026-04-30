import { useEffect } from "react"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import type { Editor, TLRecord } from "tldraw"
import { EventStore } from "@rxweave/core"
import { EventRegistry } from "@rxweave/schema"
import { CloudStore } from "@rxweave/store-cloud"
import {
  CANVAS_SCHEMAS,
  CanvasBindingDeleted,
  CanvasBindingUpserted,
  CanvasShapeDeleted,
  CanvasShapeUpserted,
} from "../server/schemas.js"

// Bidirectional adapter between tldraw's store and RxWeave's event log.
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

    // Bootstrap: build ManagedRuntime → register schemas → wire outgoing
    // listener → fork incoming subscription. All guarded by `disposed`
    // so React's StrictMode remount doesn't leak a dangling runtime.
    //
    // `CloudStore.LiveFromBrowser` handles the session-token fetch (with
    // 401-retry), the RPC URL derivation, heartbeat (15 s default), and
    // the two-phase drain (QueryAfter pages through history, then the
    // live-tail stream opens from the last-drained cursor). Both drain
    // and reconnect live inside the factory — the bridge no longer needs
    // to manage cursors or retry loops.
    //
    // `Layer.provideMerge` composes the store layer so the output
    // exports both `EventStore` + `EventRegistry` with zero remaining
    // requirements — what `ManagedRuntime.make` needs. `Layer.merge`
    // would have kept `EventRegistry` in the requirement channel.
    ;(async () => {
      const layer = CloudStore.LiveFromBrowser({
        origin: window.location.origin,
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

      // Incoming: `store.subscribe({ cursor: "earliest" })` — the factory's
      // built-in drainBeforeSubscribe option pages through history via
      // QueryAfter before opening the live tail, so the stream delivers
      // fully ordered events without the WebKit fetch-buffer stall.
      // Reconnect on transient errors is also handled inside the factory
      // via Stream.retry with exponential backoff.
      runtime.runFork(
        Effect.gen(function* () {
          const store = yield* EventStore
          yield* Stream.runForEach(
            store.subscribe({ cursor: "earliest" }),
            (event) => Effect.sync(() => applyIncoming(editor, event)),
          )
        }).pipe(
          Effect.tapErrorCause((cause) =>
            Effect.sync(() =>
              console.warn("[web] subscribe error:", cause),
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

