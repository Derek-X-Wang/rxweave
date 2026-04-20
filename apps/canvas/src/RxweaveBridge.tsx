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
    const unlisten = editor.store.listen(
      (entry) => {
        const { added, updated, removed } = entry.changes

        for (const record of Object.values(added)) {
          const ev = recordToEvent(record as TLRecord, "upserted")
          if (ev) void postEvent(ev)
        }
        for (const [, to] of Object.values(updated) as Array<
          [TLRecord, TLRecord]
        >) {
          const ev = recordToEvent(to, "upserted")
          if (ev) void postEvent(ev)
        }
        for (const record of Object.values(removed)) {
          const ev = recordToEvent(record as TLRecord, "deleted")
          if (ev) void postEvent(ev)
        }
      },
      { source: "user", scope: "document" },
    )
    return unlisten
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
