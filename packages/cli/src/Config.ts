import { Effect } from "effect"
import type { Layer } from "effect"
import type { AgentDef } from "@rxweave/runtime"
import type { EventDef } from "@rxweave/schema"
import type { EventStore } from "@rxweave/core"

export interface RxWeaveConfig {
  readonly store: Layer.Layer<EventStore, unknown>
  readonly schemas: ReadonlyArray<EventDef<any, any>>
  readonly agents: ReadonlyArray<AgentDef<any>>
}

// `AgentDef<S>`'s optional `reduce?: AgentReduce<S>` is contravariant in S.
// Under `exactOptionalPropertyTypes: true`, a `defineAgent({...})` without
// `initialState` has type `AgentDef<never>` — which is NOT assignable to
// `AgentDef<any>` because `AgentReduce<never>` and `AgentReduce<any>` fail
// the exact-optional check both ways. To keep `RxWeaveConfig.agents` usable
// with mixed state/stateless agents, `defineConfig` accepts a union-bounded
// generic and widens on the way out. The runtime shape is identical; only
// the type system needs the escape hatch.
export const defineConfig = <A extends AgentDef<any> | AgentDef<never>>(cfg: {
  readonly store: RxWeaveConfig["store"]
  readonly schemas: RxWeaveConfig["schemas"]
  readonly agents: ReadonlyArray<A>
}): RxWeaveConfig => cfg as unknown as RxWeaveConfig

export const loadConfig = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      const mod = await import(/* @vite-ignore */ path)
      const cfg = (mod as { default?: RxWeaveConfig }).default ?? mod
      return cfg as RxWeaveConfig
    },
    catch: (cause) => new Error(`failed to load ${path}: ${String(cause)}`),
  })
