/**
 * Provenance sidebar — "see what your agent (and your collaborator) did".
 *
 * Renders the live list of canvas events from the shared stream.
 * Clicking an event shows its causal lineage (causedBy ancestry).
 *
 * ⚠ SECURITY NOTE: the room token in the URL hash grants full read+write
 * access to the shared event stream. Anyone with the link is in the room.
 * This is intentional for the first dogfood (trusted collaborators).
 * Revocable/scoped invites are a deferred follow-up.
 */

import { useState } from "react"
import type { LoggedEvent } from "./EventLog.js"
import { walkLineage } from "./EventLog.js"

const SHORT_ID_LEN = 8

function shortId(id: string): string {
  return id.slice(0, SHORT_ID_LEN) + "…"
}

function shortType(type: string): string {
  // e.g. "canvas.shape.upserted" → "shape.upserted"
  const parts = type.split(".")
  return parts.slice(1).join(".") || type
}

interface LineagePanelProps {
  event: LoggedEvent
  log: ReadonlyArray<LoggedEvent>
  onClose: () => void
}

function LineagePanel({ event, log, onClose }: LineagePanelProps) {
  const chain = walkLineage(log, event.id, 5)
  return (
    <div style={styles.lineagePanel}>
      <div style={styles.lineageHeader}>
        <span style={styles.lineageTitle}>Lineage</span>
        <button onClick={onClose} style={styles.closeBtn} aria-label="Close lineage">
          ✕
        </button>
      </div>
      {chain.map((e, i) => (
        <div key={e.id} style={{ ...styles.lineageItem, opacity: 1 - i * 0.15 }}>
          <span style={styles.lineageArrow}>{i === 0 ? "●" : "↑"}</span>
          <span style={styles.eventType}>{shortType(e.type)}</span>
          <span style={styles.eventActor}>{e.actor}</span>
          <span style={styles.eventId}>{shortId(e.id)}</span>
        </div>
      ))}
      {chain.length === 0 && (
        <div style={styles.emptyMsg}>No ancestry found in local log.</div>
      )}
    </div>
  )
}

interface ProvenanceSidebarProps {
  events: ReadonlyArray<LoggedEvent>
  /** Optional: whether the sidebar panel is shown at all. */
  visible?: boolean
  onToggle?: () => void
}

export function ProvenanceSidebar({ events, visible = true, onToggle }: ProvenanceSidebarProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const handleEventClick = (id: string) => {
    setSelectedId((prev) => (prev === id ? null : id))
  }

  const selectedEvent = selectedId !== null
    ? events.find((e) => e.id === selectedId) ?? null
    : null

  return (
    <div style={styles.sidebar}>
      {/* Header / toggle */}
      <div style={styles.header}>
        <span style={styles.title}>Events</span>
        <span style={styles.count}>{events.length}</span>
        {onToggle !== undefined && (
          <button onClick={onToggle} style={styles.toggleBtn} aria-label="Toggle sidebar">
            {visible ? "◀" : "▶"}
          </button>
        )}
      </div>

      {visible && (
        <>
          {/* Event list — most recent first */}
          <div style={styles.list}>
            {[...events].reverse().map((event) => (
              <div
                key={event.id}
                onClick={() => handleEventClick(event.id)}
                style={{
                  ...styles.eventRow,
                  ...(selectedId === event.id ? styles.eventRowSelected : {}),
                }}
                title={`id: ${event.id}\ncausedBy: ${event.causedBy.join(", ") || "none"}`}
              >
                <span style={styles.eventType}>{shortType(event.type)}</span>
                <span style={styles.eventActor}>{event.actor}</span>
                <span style={styles.eventId}>{shortId(event.id)}</span>
                {event.causedBy.length > 0 && (
                  <span style={styles.causalBadge} title={`caused by ${event.causedBy[0]}`}>
                    ↑
                  </span>
                )}
              </div>
            ))}
            {events.length === 0 && (
              <div style={styles.emptyMsg}>Waiting for events…</div>
            )}
          </div>

          {/* Lineage drill-down */}
          {selectedEvent !== null && (
            <LineagePanel
              event={selectedEvent}
              log={events}
              onClose={() => setSelectedId(null)}
            />
          )}
        </>
      )}
    </div>
  )
}

// Inline styles — keeps the sidebar self-contained with no CSS file dependency.
const styles = {
  sidebar: {
    position: "fixed" as const,
    top: 0,
    right: 0,
    width: 260,
    height: "100vh",
    background: "rgba(20, 20, 30, 0.92)",
    backdropFilter: "blur(8px)",
    color: "#e2e8f0",
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: 11,
    display: "flex" as const,
    flexDirection: "column" as const,
    borderLeft: "1px solid rgba(255,255,255,0.08)",
    zIndex: 9999,
    overflow: "hidden" as const,
  },
  header: {
    padding: "10px 12px",
    display: "flex" as const,
    alignItems: "center" as const,
    gap: 6,
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.04)",
    flexShrink: 0,
  },
  title: {
    fontWeight: 600,
    fontSize: 12,
    color: "#94a3b8",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    flex: 1,
  },
  count: {
    background: "rgba(99,102,241,0.3)",
    color: "#a5b4fc",
    borderRadius: 9,
    padding: "1px 6px",
    fontSize: 10,
    fontWeight: 700,
  },
  toggleBtn: {
    background: "none",
    border: "none",
    color: "#64748b",
    cursor: "pointer",
    padding: "2px 4px",
    fontSize: 12,
  },
  list: {
    flex: 1,
    overflowY: "auto" as const,
    padding: "4px 0",
  },
  eventRow: {
    display: "flex" as const,
    alignItems: "center" as const,
    gap: 5,
    padding: "5px 10px",
    cursor: "pointer",
    borderBottom: "1px solid rgba(255,255,255,0.03)",
    transition: "background 0.1s",
  },
  eventRowSelected: {
    background: "rgba(99,102,241,0.18)",
    borderLeft: "2px solid #818cf8",
    paddingLeft: 8,
  },
  eventType: {
    flex: 1,
    color: "#c4b5fd",
    overflow: "hidden" as const,
    textOverflow: "ellipsis" as const,
    whiteSpace: "nowrap" as const,
  },
  eventActor: {
    color: "#67e8f9",
    fontSize: 10,
    flexShrink: 0,
  },
  eventId: {
    color: "#475569",
    fontSize: 10,
    flexShrink: 0,
  },
  causalBadge: {
    color: "#fb923c",
    fontSize: 10,
    flexShrink: 0,
  },
  emptyMsg: {
    color: "#475569",
    padding: "16px 10px",
    textAlign: "center" as const,
  },
  lineagePanel: {
    borderTop: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(0,0,0,0.3)",
    maxHeight: 200,
    overflowY: "auto" as const,
    flexShrink: 0,
  },
  lineageHeader: {
    display: "flex" as const,
    alignItems: "center" as const,
    padding: "6px 10px",
    borderBottom: "1px solid rgba(255,255,255,0.05)",
  },
  lineageTitle: {
    flex: 1,
    color: "#94a3b8",
    fontWeight: 600,
    fontSize: 11,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "#64748b",
    cursor: "pointer",
    padding: "0 4px",
    fontSize: 11,
  },
  lineageItem: {
    display: "flex" as const,
    alignItems: "center" as const,
    gap: 5,
    padding: "4px 10px",
    borderBottom: "1px solid rgba(255,255,255,0.03)",
  },
  lineageArrow: {
    color: "#818cf8",
    fontSize: 9,
    flexShrink: 0,
  },
}
