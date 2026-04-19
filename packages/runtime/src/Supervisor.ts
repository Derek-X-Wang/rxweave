import {
  Clock,
  Duration,
  Effect,
  FiberMap,
  Ref,
  Schedule,
  Stream,
} from "effect"
import type {
  EventEnvelope,
  EventId,
  EventInput,
} from "@rxweave/schema"
import { SystemAgentHeartbeat } from "@rxweave/schema"
import { EventStore } from "@rxweave/core"
import { AgentCursorStore } from "./AgentCursorStore.js"
import { AgentDef, validateAgent } from "./AgentDef.js"

export interface SuperviseOpts {
  readonly cursorFlush?: { readonly events: number; readonly millis: number }
}

const defaultOpts: Required<SuperviseOpts> = {
  cursorFlush: { events: 100, millis: 1000 },
}

const defaultRestart: Schedule.Schedule<unknown, unknown> = Schedule.exponential(
  Duration.millis(100),
  2.0,
).pipe(Schedule.either(Schedule.spaced(Duration.seconds(30))))

interface CursorCtx {
  readonly pendingCursor: Ref.Ref<EventId | null>
  readonly flushedCount: Ref.Ref<number>
}

export const supervise = (
  agents: ReadonlyArray<AgentDef<any>>,
  opts: SuperviseOpts = {},
) =>
  Effect.gen(function* () {
    for (const agent of agents) yield* validateAgent(agent as unknown as AgentDef)

    const store = yield* EventStore
    const cursors = yield* AgentCursorStore
    const fibers = yield* FiberMap.make<string, void, unknown>()
    const settings = { ...defaultOpts, ...opts }

    // Hoisted out of `runOne` so the time-based flush loop below can walk
    // every agent's cursor state. Keyed by agent id — `runOne` seeds it
    // once at fiber start. Agents that fault and restart under the
    // defaultRestart schedule keep the same refs, which is what we want:
    // a crash shouldn't drop unflushed progress.
    const cursorCtx = new Map<string, CursorCtx>()

    const flushCursorFor = (agentId: string) => {
      const c = cursorCtx.get(agentId)
      if (!c) return Effect.void
      return Ref.get(c.pendingCursor).pipe(
        Effect.flatMap((cursor) => (cursor ? cursors.set(agentId, cursor) : Effect.void)),
        Effect.zipRight(Ref.set(c.flushedCount, 0)),
      )
    }

    const runOne = <S>(agent: AgentDef<S>) =>
      Effect.gen(function* () {
        const state = yield* Ref.make<S>(agent.initialState as S)
        const pendingCursor = yield* Ref.make<EventId | null>(null)
        const flushedCount = yield* Ref.make(0)
        cursorCtx.set(agent.id, { pendingCursor, flushedCount })

        const startCursor = yield* cursors.get(agent.id)

        const onEvent = (event: EventEnvelope) =>
          Effect.gen(function* () {
            let emits: ReadonlyArray<EventInput> = []
            if (agent.handle) {
              const result = yield* agent.handle(event)
              emits = Array.isArray(result) ? result : []
            } else if (agent.reduce) {
              const s = yield* Ref.get(state)
              const { state: next, emit } = agent.reduce(event, s)
              yield* Ref.set(state, next)
              emits = emit ?? []
            }

            if (emits.length > 0) {
              const stamped: Array<EventInput> = emits.map((input) => ({
                type: input.type,
                actor: input.actor ?? (agent.id as never),
                source: input.source ?? "agent",
                causedBy: [event.id],
                payload: input.payload,
              } satisfies EventInput))
              yield* store.append(stamped)
            }

            yield* Ref.set(pendingCursor, event.id)
            const count = yield* Ref.updateAndGet(flushedCount, (n) => n + 1)
            if (count >= settings.cursorFlush.events) {
              yield* flushCursorFor(agent.id)
            }
          })

        const stream = store.subscribe({ cursor: startCursor, filter: agent.on })

        yield* Stream.runForEach(stream, onEvent).pipe(
          Effect.retry(agent.restart ?? defaultRestart),
          Effect.onExit(() => flushCursorFor(agent.id)),
        )
      })

    // Heartbeat emitter — publishes `system.agent.heartbeat` every 10s per
    // live agent. `Clock.currentTimeMillis` is sampled once per tick so all
    // heartbeats in a tick share a timestamp (same observation moment), and
    // all agents' heartbeats ship in a single batched append — one RPC
    // instead of N when the store is remote. Failures are swallowed
    // (registry digest mismatches, transient store errors, …) — one bad
    // emit must not kill the fiber; heartbeats are best-effort telemetry.
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep(Duration.seconds(10)).pipe(
          Effect.zipRight(
            Effect.gen(function* () {
              const timestamp = yield* Clock.currentTimeMillis
              const heartbeats: Array<EventInput> = []
              for (const [agentId, ctx] of cursorCtx.entries()) {
                const cursor = yield* Ref.get(ctx.pendingCursor)
                heartbeats.push({
                  type: SystemAgentHeartbeat.type,
                  actor: agentId as never,
                  source: "system",
                  payload: { agentId, cursor, timestamp },
                })
              }
              if (heartbeats.length === 0) return
              yield* store
                .append(heartbeats)
                .pipe(Effect.catchAll(() => Effect.void))
            }),
          ),
        ),
      ),
    )

    for (const agent of agents) {
      yield* FiberMap.run(fibers, agent.id, runOne(agent))
    }

    // Time-based cursor flush — complements the count-based flush in
    // `onEvent` so agents with low event volume don't sit on an
    // unflushed cursor indefinitely. Forked as scoped so it interrupts
    // when the enclosing scope closes (e.g. when `dev` restarts).
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep(Duration.millis(settings.cursorFlush.millis)).pipe(
          Effect.zipRight(
            Effect.forEach(
              Array.from(cursorCtx.keys()),
              (id) => flushCursorFor(id),
              { discard: true },
            ),
          ),
        ),
      ),
    )

    yield* Effect.never
  })
