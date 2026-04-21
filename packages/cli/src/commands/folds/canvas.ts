import type { EventEnvelope, Filter } from "@rxweave/schema"

/**
 * Shape of the projected canvas state assembled from `canvas.shape.*` and
 * `canvas.binding.*` events. We keep the value side as `unknown` because
 * the fold is the CLI's generic default — individual consumers (tldraw,
 * an agent reading topology) know their own payload shape and narrow
 * from there. Trying to type the value here would force every shape
 * schema into this package's dep graph.
 */
export interface CanvasState {
  readonly shapes: Record<string, unknown>
  readonly bindings: Record<string, unknown>
}

/**
 * Built-in canvas fold: projects the final map of shapes + bindings
 * from a stream of `canvas.*` events. Used by `rxweave stream --fold
 * canvas` to emit a tldraw-compatible store snapshot.
 *
 * `on` is the type filter applied at query time — we push type
 * narrowing down to the store so this is efficient even on large
 * event logs. The reducer itself is pure and defensive: payloads
 * missing `record.id` or `id` are no-ops rather than throws, so a
 * malformed legacy event does not abort the entire projection.
 */
export const canvasFold = {
  on: {
    types: [
      "canvas.shape.upserted",
      "canvas.shape.deleted",
      "canvas.binding.upserted",
      "canvas.binding.deleted",
    ],
  } as Filter,

  initial: (): CanvasState => ({ shapes: {}, bindings: {} }),

  reduce: (event: EventEnvelope, state: CanvasState): CanvasState => {
    const p = event.payload as {
      readonly record?: { readonly id: string }
      readonly id?: string
    }
    switch (event.type) {
      case "canvas.shape.upserted":
        if (p.record?.id) {
          return {
            ...state,
            shapes: { ...state.shapes, [p.record.id]: p.record },
          }
        }
        return state
      case "canvas.shape.deleted":
        if (p.id) {
          const { [p.id]: _removed, ...rest } = state.shapes
          return { ...state, shapes: rest }
        }
        return state
      case "canvas.binding.upserted":
        if (p.record?.id) {
          return {
            ...state,
            bindings: { ...state.bindings, [p.record.id]: p.record },
          }
        }
        return state
      case "canvas.binding.deleted":
        if (p.id) {
          const { [p.id]: _removed, ...rest } = state.bindings
          return { ...state, bindings: rest }
        }
        return state
      default:
        return state
    }
  },
}
