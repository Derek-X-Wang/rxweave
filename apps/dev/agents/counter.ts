import { defineAgent } from "@rxweave/runtime"

export const counterAgent = defineAgent({
  id: "counter",
  on: { types: ["canvas.*"] },
  initialState: { count: 0 },
  reduce: (_event, state) => {
    const next = state.count + 1
    return {
      state: { count: next },
      emit: [{ type: "counter.tick", payload: { count: next } }],
    }
  },
})
