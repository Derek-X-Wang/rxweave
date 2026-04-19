import { Effect } from "effect"
import type { Layer } from "effect"
import type { AgentDef } from "@rxweave/runtime"
import type { EventDef } from "@rxweave/schema"
import type { EventStore } from "@rxweave/core"

export interface RxWeaveConfig {
  readonly store: Layer.Layer<EventStore>
  readonly schemas: ReadonlyArray<EventDef>
  readonly agents: ReadonlyArray<AgentDef<any>>
}

export const defineConfig = (cfg: RxWeaveConfig): RxWeaveConfig => cfg

export const loadConfig = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      const mod = await import(/* @vite-ignore */ path)
      const cfg = (mod as { default?: RxWeaveConfig }).default ?? mod
      return cfg as RxWeaveConfig
    },
    catch: (cause) => new Error(`failed to load ${path}: ${String(cause)}`),
  })
