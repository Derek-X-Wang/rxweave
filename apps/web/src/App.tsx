import { useState } from "react"
import { Tldraw, type Editor } from "tldraw"
import "tldraw/tldraw.css"
import { RxweaveBridge } from "./RxweaveBridge.js"

export function App() {
  const [editor, setEditor] = useState<Editor | null>(null)
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Tldraw onMount={setEditor} />
      {editor !== null ? <RxweaveBridge editor={editor} /> : null}
    </div>
  )
}
