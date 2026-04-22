import { describe, it, expect } from "vitest"
import { canvasFold } from "../src/commands/folds/canvas.js"

// Unit tests for the built-in canvas fold. These exercise only the
// pure reducer function — no store, no registry, no Effect runtime.
// We construct fake `EventEnvelope`-shaped objects via `as unknown as
// <reducer-arg>` because `canvasFold.reduce` only reads `.type` and
// `.payload` from the envelope, not the full branded shape (id,
// actor, timestamp, source). Building real envelopes would require
// MemoryStore + registry which is tested separately in stream.test.ts.

describe("canvas fold", () => {
  it("upsert adds the shape to state.shapes", () => {
    const envs = [
      {
        type: "canvas.shape.upserted",
        payload: { record: { id: "s1", type: "geo" } },
      },
    ] as unknown as Array<Parameters<typeof canvasFold.reduce>[0]>
    const state = envs.reduce(
      (s, e) => canvasFold.reduce(e, s),
      canvasFold.initial(),
    )
    expect(state.shapes["s1"]).toEqual({ id: "s1", type: "geo" })
    expect(Object.keys(state.bindings).length).toBe(0)
  })

  it("delete removes the shape from state.shapes", () => {
    const envs = [
      { type: "canvas.shape.upserted", payload: { record: { id: "s1" } } },
      { type: "canvas.shape.deleted", payload: { id: "s1" } },
    ] as unknown as Array<Parameters<typeof canvasFold.reduce>[0]>
    const state = envs.reduce(
      (s, e) => canvasFold.reduce(e, s),
      canvasFold.initial(),
    )
    expect(Object.keys(state.shapes).length).toBe(0)
  })

  it("upsert + delete on different ids leaves survivors", () => {
    const envs = [
      { type: "canvas.shape.upserted", payload: { record: { id: "s1" } } },
      { type: "canvas.shape.upserted", payload: { record: { id: "s2" } } },
      { type: "canvas.shape.deleted", payload: { id: "s1" } },
    ] as unknown as Array<Parameters<typeof canvasFold.reduce>[0]>
    const state = envs.reduce(
      (s, e) => canvasFold.reduce(e, s),
      canvasFold.initial(),
    )
    expect(Object.keys(state.shapes)).toEqual(["s2"])
  })

  it("handles bindings the same way", () => {
    const envs = [
      { type: "canvas.binding.upserted", payload: { record: { id: "b1" } } },
    ] as unknown as Array<Parameters<typeof canvasFold.reduce>[0]>
    const state = envs.reduce(
      (s, e) => canvasFold.reduce(e, s),
      canvasFold.initial(),
    )
    expect(state.bindings["b1"]).toEqual({ id: "b1" })
  })

  it("binding delete removes the binding from state.bindings", () => {
    const envs = [
      { type: "canvas.binding.upserted", payload: { record: { id: "b1" } } },
      { type: "canvas.binding.deleted", payload: { id: "b1" } },
    ] as unknown as Array<Parameters<typeof canvasFold.reduce>[0]>
    const state = envs.reduce(
      (s, e) => canvasFold.reduce(e, s),
      canvasFold.initial(),
    )
    expect(Object.keys(state.bindings).length).toBe(0)
  })

  it("mixed shapes + bindings end up in separate maps", () => {
    const envs = [
      { type: "canvas.shape.upserted", payload: { record: { id: "s1" } } },
      { type: "canvas.binding.upserted", payload: { record: { id: "b1" } } },
    ] as unknown as Array<Parameters<typeof canvasFold.reduce>[0]>
    const state = envs.reduce(
      (s, e) => canvasFold.reduce(e, s),
      canvasFold.initial(),
    )
    expect(Object.keys(state.shapes)).toEqual(["s1"])
    expect(Object.keys(state.bindings)).toEqual(["b1"])
  })

  it("unknown event types pass through unchanged", () => {
    const envs = [
      { type: "demo.unrelated", payload: { x: 1 } },
    ] as unknown as Array<Parameters<typeof canvasFold.reduce>[0]>
    const state = envs.reduce(
      (s, e) => canvasFold.reduce(e, s),
      canvasFold.initial(),
    )
    expect(state).toEqual({ shapes: {}, bindings: {} })
  })

  it("upsert without record.id is a no-op (defensive guard)", () => {
    const envs = [
      { type: "canvas.shape.upserted", payload: {} },
    ] as unknown as Array<Parameters<typeof canvasFold.reduce>[0]>
    const state = envs.reduce(
      (s, e) => canvasFold.reduce(e, s),
      canvasFold.initial(),
    )
    expect(state).toEqual({ shapes: {}, bindings: {} })
  })
})
