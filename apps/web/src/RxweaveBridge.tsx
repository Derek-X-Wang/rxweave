import { useCallback, useEffect } from "react"
import { Cause, Effect, Layer, ManagedRuntime, Stream } from "effect"
import type { Editor, TLRecord } from "tldraw"
import { EventStore } from "@rxweave/core"
import { EventRegistry, type EventDefWire } from "@rxweave/schema"
import { CloudStore, syncRegistry, type RegistryRpcClient } from "@rxweave/store-cloud"
import { isHeartbeat } from "@rxweave/protocol"
import {
  CANVAS_SCHEMAS,
  CanvasBindingDeleted,
  CanvasBindingUpserted,
  CanvasShapeDeleted,
  CanvasShapeUpserted,
} from "./shared/schemas.js"
import { resolveRoomConfig } from "./roomToken.js"
import type { LoggedEvent } from "./EventLog.js"

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
// Registry digest: in cloud/hash-room mode (token set), the server starts
// with an empty registry. The bridge pushes its local schemas on startup via
// a fetch-based RegistryRpcClient shim + `syncRegistry` so Append's digest
// gate passes. In embedded mode the embedded server pre-registers the same
// canvas schemas, so no push is needed.
//
// Room token: resolved from the URL hash `#room=<token>` first, falling
// back to `VITE_RXWEAVE_TOKEN` for local dev. Hash values are NEVER
// sent to any server (client-only per HTTP spec). See roomToken.ts for
// the resolution contract.

// Resolve room config once at module-load time. The result is kept in
// memory only — never written to localStorage or the bundle.
//
// ⚠ SECURITY NOTE: the room token grants full read+write to the shared
// stream. Anyone with the link is in the room. Acceptable for a first
// dogfood among trusted people — revocable/scoped invites are a
// deferred follow-up.
const ROOM_CONFIG = resolveRoomConfig(
  typeof window !== "undefined" ? window.location.hash : "",
  (import.meta as any).env?.VITE_RXWEAVE_TOKEN as string | undefined,
  (import.meta as any).env?.VITE_RXWEAVE_ORIGIN as string | undefined,
  typeof window !== "undefined" ? window.location.origin : "http://localhost:5173",
)

// Per-shape debounce for upserts: reduced from 2000ms to 350ms so
// "draw on A, see on B" feels live. 350ms still collapses a typing
// burst (e.g., "F", "Fe", "Fea", "Feat") into a single settled event
// — any keystroke gap under 350ms gets swallowed. The old 2000ms was
// conservative (aimed at the LLM suggester's cost budget); that agent
// uses `actor !== "human"` to gate anyway, so this is safe to reduce.
export const DEBOUNCE_MS = 350

export interface RxweaveBridgeProps {
  editor: Editor
  onEvent?: (event: LoggedEvent) => void
}

export function RxweaveBridge({ editor, onEvent }: RxweaveBridgeProps) {
  const stableOnEvent = useCallback(
    (event: LoggedEvent) => onEvent?.(event),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

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
    // per keystroke. Deletes cancel any pending upsert for the same id
    // (clearTimeout + map delete) before appending the delete, so a
    // "type-then-immediately-delete" sequence can't leak a stale
    // upsert after the removal. The React cleanup reads `event` off
    // each entry to flush in-flight bursts before the runtime disposes.
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
    // 401-retry), the RPC URL derivation, heartbeat, and the two-phase
    // drain (QueryAfter pages through history, then the live-tail stream
    // opens from the last-drained cursor). Both drain and reconnect live
    // inside the factory — the bridge no longer needs to manage cursors
    // or retry loops.
    //
    // Heartbeat intervalMs is set to 1000ms (the minimum honored by the
    // server — see clampIntervalMs in @rxweave/protocol) so the watchdog
    // detects a dead connection within ~3s instead of the default 45s.
    // This reduces "draw on A, see on B" round-trip lag by cutting the
    // server→client poll cadence from 15s to ~1s.
    //
    // `Layer.provideMerge` composes the store layer so the output
    // exports both `EventStore` + `EventRegistry` with zero remaining
    // requirements — what `ManagedRuntime.make` needs. `Layer.merge`
    // would have kept `EventRegistry` in the requirement channel.
    ;(async () => {
      const { origin, token: apiToken } = ROOM_CONFIG
      if (ROOM_CONFIG.fromHash) {
        console.log("[web] shared-room mode: token from #room= hash")
      }

      // In cloud/hash-room mode (apiToken set), the server starts with an
      // empty registry. The bridge registers canvas schemas locally but
      // must push them to the server so Append's digest gate passes.
      // Build a minimal fetch-based RegistryRpcClient shim for syncRegistry
      // (bypasses @effect/rpc entirely).
      const rpcUrl = `${origin}/rxweave/rpc/`
      const authHdr = apiToken ? { authorization: `Bearer ${apiToken}` } : {}
      const registryClient: RegistryRpcClient = {
        RegistrySyncDiff: ({ clientDigest }) =>
          Effect.tryPromise(async () => {
            const body =
              JSON.stringify({ _tag: "Request", id: "rs-diff", tag: "RegistrySyncDiff", payload: { clientDigest }, headers: [] }) + "\n"
            const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/ndjson", ...authHdr }, body })
            const text = await res.text()
            const msg = JSON.parse(text.trim().split("\n")[0]!) as { exit: { _tag: string; value?: unknown; cause?: unknown } }
            if (msg.exit._tag !== "Success") throw new Error(JSON.stringify(msg.exit))
            return msg.exit.value as { upToDate: boolean; missingOnClient: ReadonlyArray<EventDefWire>; missingOnServer: ReadonlyArray<string> }
          }),
        RegistryPush: ({ defs }) =>
          Effect.tryPromise(async () => {
            const body =
              JSON.stringify({
                _tag: "Request",
                id: "rs-push",
                tag: "RegistryPush",
                payload: { defs: defs.map((d) => ({ type: d.type, version: d.version, payloadSchema: d.payloadSchema, digest: d.digest })) },
                headers: [],
              }) + "\n"
            const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/ndjson", ...authHdr }, body })
            const text = await res.text()
            const msg = JSON.parse(text.trim().split("\n")[0]!) as { exit: { _tag: string; value?: unknown; cause?: unknown } }
            if (msg.exit._tag !== "Success") throw new Error(JSON.stringify(msg.exit))
          }).pipe(Effect.asVoid),
      }

      const layer = apiToken
        ? CloudStore.Live({
            url: rpcUrl,
            token: () => apiToken,
            // Fast heartbeat: 1000ms interval makes the server emit a
            // keep-alive byte every ~1s so live events unblock from the
            // stream instead of waiting for the default 15s sentinel.
            // The server clamps to [1000, 300_000] ms — 1000 is the minimum.
            heartbeat: { intervalMs: 1000 },
          }).pipe(Layer.provideMerge(EventRegistry.Live))
        : CloudStore.LiveFromBrowser({
            origin,
            // Fast heartbeat for the embedded-server path too.
            heartbeat: { intervalMs: 1000 },
          }).pipe(Layer.provideMerge(EventRegistry.Live))
      runtime = ManagedRuntime.make(layer)

      // Local registry registration — mirrors server-side startup so
      // `client.Append`'s digest calc matches the server's. See the
      // module-level comment for the registry-drift failure mode.
      try {
        await runtime.runPromise(
          Effect.gen(function* () {
            const reg = yield* EventRegistry
            // swallowDuplicates: true handles Vite HMR re-mounts where
            // the same schema set is re-imported into an already-live
            // registry inside a single page load.
            yield* reg.registerAll(CANVAS_SCHEMAS, { swallowDuplicates: true })
            if (apiToken) {
              // Cloud/hash-room mode: server registry starts empty. Push
              // canvas schemas so Append's digest gate passes without a
              // registry-out-of-date error.
              yield* syncRegistry(registryClient)
            }
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

      // Incoming: `store.subscribe({ cursor: 'earliest' })` — the factory's
      // built-in drainBeforeSubscribe option pages through history via
      // QueryAfter before opening the live tail, so the stream delivers
      // fully ordered events without the WebKit fetch-buffer stall.
      // Reconnect on transient errors is also handled inside the factory
      // via Stream.retry with exponential backoff.
      //
      // Every event is forwarded to both `applyIncoming` (canvas state)
      // and the `onEvent` callback (provenance sidebar accumulator).
      // Heartbeat sentinels are filtered out using `isHeartbeat` from
      // `@rxweave/protocol` — they must never appear in the event list.
      runtime.runFork(
        Effect.gen(function* () {
          const store = yield* EventStore
          yield* Stream.runForEach(
            store.subscribe({ cursor: "earliest" }),
            (event) =>
              Effect.sync(() => {
                // isHeartbeat guard: heartbeats have already been stripped
                // by heartbeatGuard inside CloudStore, but a belt-and-
                // suspenders check here ensures no sentinel ever leaks
                // into the canvas state or the provenance sidebar if a
                // future server version changes guard placement.
                if (isHeartbeat(event as unknown as { _tag?: string })) return
                applyIncoming(editor, event)
                // Accumulate into provenance sidebar via callback.
                stableOnEvent({
                  id: (event as any).id,
                  type: event.type,
                  actor: (event as any).actor ?? "unknown",
                  causedBy: (event as any).causedBy ?? [],
                  envelope: event as any,
                })
              }),
          )
        }).pipe(
          Effect.tapErrorCause((cause) =>
            Effect.sync(() => { console.warn("[web] subscribe cause:\n" + Cause.pretty(cause)) }),
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
  }, [editor, stableOnEvent])

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
