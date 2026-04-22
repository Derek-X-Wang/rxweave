import { useEffect } from "react"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import type { Editor, TLRecord } from "tldraw"
import { EventStore } from "@rxweave/core"
import { EventRegistry, type EventDef } from "@rxweave/schema"
import { CloudStore } from "@rxweave/store-cloud"
import {
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

const SCHEMAS: ReadonlyArray<EventDef> = [
  CanvasShapeUpserted as EventDef,
  CanvasShapeDeleted as EventDef,
  CanvasBindingUpserted as EventDef,
  CanvasBindingDeleted as EventDef,
]

export function RxweaveBridge({ editor }: { editor: Editor }) {
  useEffect(() => {
    // `disposed` + the nested runtime/unsub refs let us abort the
    // async token-fetch + layer-build sequence cleanly if React
    // unmounts the component (e.g. StrictMode double-mount, hot
    // reload) before the runtime is up.
    let disposed = false
    let runtime: ManagedRuntime.ManagedRuntime<
      EventStore | EventRegistry,
      never
    > | null = null
    let unlisten: (() => void) | null = null

    // Per-shape debounce for upserts — a typed label ("F", "Fe",
    // "Fea", …) collapses into a single "settled" event at the end
    // of the typing burst. Without this the suggester agent fires
    // once per keystroke: expensive and noisy. Deletes flush any
    // pending upsert for the same id before appending the delete,
    // so a "type-then-immediately-delete" sequence can't leak a
    // stale upsert after the removal.
    const DEBOUNCE_MS = 2000
    const pending = new Map<string, number>()

    const appendEvent = (event: { type: string; payload: unknown }) => {
      if (!runtime) return
      // `actor: "human"` is the suggester's `actor !== "human"` gate;
      // if we drop this the server defaults actor to `"system"` and
      // the suggester skips every user shape. `ActorId` is a
      // branded `Schema.pattern`-validated string; `as never` opts
      // out of the brand at the call site (matches the upstream
      // pattern in `@rxweave/store-file`'s Live).
      runtime.runPromise(
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
      ).catch((err) => {
        console.warn("[web] append failed", err)
      })
    }

    const scheduleUpsert = (
      id: string,
      event: { type: string; payload: unknown },
    ) => {
      const existing = pending.get(id)
      if (existing !== undefined) clearTimeout(existing)
      const timer = window.setTimeout(() => {
        pending.delete(id)
        appendEvent(event)
      }, DEBOUNCE_MS)
      pending.set(id, timer)
    }

    const flushForDelete = (
      id: string,
      event: { type: string; payload: unknown },
    ) => {
      const existing = pending.get(id)
      if (existing !== undefined) clearTimeout(existing)
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
        const res = await fetch("/rxweave/session-token")
        const body = (await res.json()) as { token: string | null }
        token = body.token
      } catch (err) {
        console.warn(
          "[web] /rxweave/session-token fetch failed; proceeding tokenless",
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
      const layer = CloudStore.Live({
        url: window.location.origin,
        // `token === null` ⇒ server is in no-auth mode; omit the
        // provider entirely so CloudStore's Auth wiring skips the
        // Authorization header (spec §3.3). `token` non-null ⇒
        // wrap in a nullary closure so each request resolves the
        // current value (still captured-once here, but the shape
        // matches the rotating-credentials contract).
        ...(token === null ? {} : { token: () => token as string }),
      }).pipe(Layer.provideMerge(EventRegistry.Live))
      runtime = ManagedRuntime.make(layer)
      if (disposed) {
        // Possible race: user unmounted while we were building the
        // layer. Eagerly dispose so the layer's acquire-side (RPC
        // protocol scope) releases.
        await runtime.dispose()
        runtime = null
        return
      }

      // Local registry registration — mirrors server-side startup so
      // `client.Append`'s digest calc matches the server's. See the
      // module-level comment for the registry-drift failure mode.
      try {
        await runtime.runPromise(
          Effect.gen(function* () {
            const reg = yield* EventRegistry
            for (const def of SCHEMAS)
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

      // Outgoing: tldraw store changes → CloudStore.append. Scoped to
      // `source: 'user'` so the remote-applied incoming events don't
      // loop back out.
      unlisten = editor.store.listen(
        (entry) => {
          const { added, updated, removed } = entry.changes
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
          for (const record of Object.values(removed)) {
            const r = record as TLRecord
            const ev = recordToEvent(r, "deleted")
            if (ev) flushForDelete(r.id, ev)
          }
        },
        { source: "user", scope: "document" },
      )

      // Incoming: server subscribe stream → tldraw.mergeRemoteChanges.
      // Fork into the managed runtime so its fiber is tied to the
      // runtime's scope and `runtime.dispose()` tears it down.
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
              console.warn(
                "[web] subscribe cause:",
                (cause as { toString?: () => string }).toString?.() ?? cause,
              ),
            ),
          ),
        ),
      )
    })()

    return () => {
      disposed = true
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
      if (unlisten) unlisten()
      // `dispose()` is async but React's cleanup is sync — we fire
      // and forget; the runtime's scope close is idempotent and any
      // in-flight `runPromise`/`runFork` is interrupted.
      if (runtime) void runtime.dispose()
    }
  }, [editor])

  return null
}

type Kind = "shape" | "binding"

const typeToEventTypeBase: Record<Kind, string> = {
  shape: "canvas.shape",
  binding: "canvas.binding",
}

function recordToEvent(
  record: TLRecord,
  op: "upserted" | "deleted",
): { type: string; payload: unknown } | null {
  const kind = record.typeName
  if (kind !== "shape" && kind !== "binding") return null
  const base = typeToEventTypeBase[kind]
  if (op === "deleted") {
    return { type: `${base}.deleted`, payload: { id: record.id } }
  }
  return { type: `${base}.upserted`, payload: { record } }
}

function applyIncoming(
  editor: Editor,
  event: { type: string; payload: unknown },
) {
  const payload = event.payload as { record?: TLRecord; id?: string }
  editor.store.mergeRemoteChanges(() => {
    switch (event.type) {
      case "canvas.shape.upserted":
      case "canvas.binding.upserted":
        if (payload.record) editor.store.put([payload.record])
        return
      case "canvas.shape.deleted":
      case "canvas.binding.deleted":
        if (payload.id) editor.store.remove([payload.id as TLRecord["id"]])
        return
    }
  })
}
