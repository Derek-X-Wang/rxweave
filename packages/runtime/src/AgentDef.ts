import { Effect, Schedule } from "effect"
import {
  EventEnvelope,
  EventInput,
  Filter,
  InvalidAgentDef,
} from "@rxweave/schema"

export type AgentHandle = (event: EventEnvelope) => Effect.Effect<
  ReadonlyArray<EventInput> | void,
  unknown,
  unknown
>

export type AgentReduce<S> = (
  event: EventEnvelope,
  state: S,
) => { readonly state: S; readonly emit?: ReadonlyArray<EventInput> }

export interface AgentDef<S = never> {
  readonly id: string
  readonly on: Filter
  readonly concurrency?: "serial" | { readonly max: number }
  readonly restart?: Schedule.Schedule<unknown, unknown>
  readonly handle?: AgentHandle
  readonly reduce?: AgentReduce<S>
  readonly initialState?: S
}

export const defineAgent = <S = never>(def: AgentDef<S>): AgentDef<S> => def

export const validateAgent = (def: AgentDef): Effect.Effect<void, InvalidAgentDef> =>
  Effect.sync(() => {
    if (!def.id || def.id.length === 0) {
      throw new InvalidAgentDef({ agentId: def.id, reason: "empty agent id" })
    }
    const hasHandle = typeof def.handle === "function"
    const hasReduce = typeof def.reduce === "function"
    if (hasHandle && hasReduce) {
      throw new InvalidAgentDef({
        agentId: def.id,
        reason: "agent may define exactly one of handle or reduce",
      })
    }
    if (!hasHandle && !hasReduce) {
      throw new InvalidAgentDef({
        agentId: def.id,
        reason: "agent must define handle or reduce",
      })
    }
    if (hasReduce && def.initialState === undefined) {
      throw new InvalidAgentDef({
        agentId: def.id,
        reason: "reduce requires initialState",
      })
    }
  }).pipe(
    Effect.catchAllDefect((e) =>
      e instanceof InvalidAgentDef
        ? Effect.fail(e)
        : Effect.die(e),
    ),
  )
