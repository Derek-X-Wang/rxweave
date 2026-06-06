import { useState, useCallback } from "react"
import { Tldraw, type Editor } from "tldraw"
import "tldraw/tldraw.css"
import { RxweaveBridge } from "./RxweaveBridge.js"
import { ProvenanceSidebar } from "./ProvenanceSidebar.js"
import type { LoggedEvent } from "./EventLog.js"
import { pushEvent } from "./EventLog.js"

export function App() {
  const [editor, setEditor] = useState<Editor | null>(null)
  const [events, setEvents] = useState<ReadonlyArray<LoggedEvent>>([])
  const [sidebarVisible, setSidebarVisible] = useState(true)

  const handleEvent = useCallback((event: LoggedEvent) => {
    setEvents((prev) => pushEvent(prev, event.envelope))
  }, [])

  const handleToggle = useCallback(() => {
    setSidebarVisible((v) => !v)
  }, [])

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        // Reserve space for the sidebar (260px) when visible.
        paddingRight: sidebarVisible ? 260 : 0,
        transition: "padding-right 0.2s",
      }}
    >
      <Tldraw onMount={setEditor} />
      {editor !== null ? (
        <RxweaveBridge editor={editor} onEvent={handleEvent} />
      ) : null}
      <ProvenanceSidebar
        events={events}
        visible={sidebarVisible}
        onToggle={handleToggle}
      />
    </div>
  )
}
