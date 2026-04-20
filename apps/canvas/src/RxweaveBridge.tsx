import { useEffect } from "react"
import type { Editor, TLRecord } from "tldraw"

// Bidirectional adapter between tldraw's store and rxweave's event log.
//
// Outgoing — user interactions → POST /api/events:
//   `store.listen({source: 'user', ...})` fires only for changes the
//   user made (drawing, dragging, deleting). We translate each affected
//   shape/binding record into a canvas.* event and POST it. The server
//   appends to the EventStore and echoes back through SSE.
//
// Incoming — /api/subscribe SSE → store.mergeRemoteChanges:
//   Every event the server emits (including our own, round-tripped via
//   the append+subscribe path) comes back as SSE. `mergeRemoteChanges`
//   marks the resulting store edits as source='remote', so our outgoing
//   listener ignores them — no sync loop, no duplicate POSTs.
//
// Why this shape: tldraw's store is already record-based and supports
// `put`/`remove` on any record it previously emitted. We don't
// interpret tldraw's shape types — we just move records through the
// log verbatim, keeping the bridge domain-agnostic.

export function RxweaveBridge({ editor }: { editor: Editor }) {
  useEffect(() => {
    // Per-shape debounce for upserts so a typed label ("F", "Fe",
    // "Fea", …) collapses into one "settled" event at the end of the
    // typing burst. Without this the suggester agent fires once per
    // keystroke — expensive and noisy. Deletes flush any pending
    // upsert for the same id before posting the delete, so a
    // "type-then-immediately-delete" sequence can't leak a stale
    // upsert after the removal.
    const DEBOUNCE_MS = 2000
    const pending = new Map<string, number>()

    const scheduleUpsert = (id: string, event: { type: string; payload: unknown }) => {
      const existing = pending.get(id)
      if (existing !== undefined) clearTimeout(existing)
      const timer = window.setTimeout(() => {
        pending.delete(id)
        void postEvent(event)
      }, DEBOUNCE_MS)
      pending.set(id, timer)
    }

    const flushForDelete = (id: string, event: { type: string; payload: unknown }) => {
      const existing = pending.get(id)
      if (existing !== undefined) clearTimeout(existing)
      pending.delete(id)
      void postEvent(event)
    }

    const unlisten = editor.store.listen(
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
    return () => {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
      unlisten()
    }
  }, [editor])

  useEffect(() => {
    const source = new EventSource("/api/subscribe")
    source.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as {
        type: string
        payload: { record?: TLRecord; id?: string }
      }
      applyIncoming(editor, event)
    }
    source.onerror = (err) => {
      // EventSource auto-reconnects; surface for debugging only.
      console.warn("[canvas] SSE error (auto-reconnecting)", err)
    }
    return () => source.close()
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
  event: { type: string; payload: { record?: TLRecord; id?: string } },
) {
  editor.store.mergeRemoteChanges(() => {
    switch (event.type) {
      case "canvas.shape.upserted":
      case "canvas.binding.upserted":
        if (event.payload.record) editor.store.put([event.payload.record])
        return
      case "canvas.shape.deleted":
      case "canvas.binding.deleted":
        if (event.payload.id)
          editor.store.remove([event.payload.id as TLRecord["id"]])
        return
    }
  })
}

async function postEvent(event: {
  type: string
  payload: unknown
}): Promise<void> {
  try {
    await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    })
  } catch (err) {
    console.warn("[canvas] POST /api/events failed", err)
  }
}
