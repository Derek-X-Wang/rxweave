import {
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

    const runOne = <S>(agent: AgentDef<S>) =>
      Effect.gen(function* () {
        const state = yield* Ref.make<S>(agent.initialState as S)
        const pendingCursor = yield* Ref.make<EventId | null>(null)
        const flushedCount = yield* Ref.make(0)

        const flushCursor = Ref.get(pendingCursor).pipe(
          Effect.flatMap((c) => (c ? cursors.set(agent.id, c) : Effect.void)),
          Effect.zipRight(Ref.set(flushedCount, 0)),
        )

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
              yield* flushCursor
            }
          })

        const stream = store.subscribe({ cursor: startCursor, filter: agent.on })

        yield* Stream.runForEach(stream, onEvent).pipe(
          Effect.retry(agent.restart ?? defaultRestart),
          Effect.onExit(() => flushCursor),
        )
      })

    for (const agent of agents) {
      yield* FiberMap.run(fibers, agent.id, runOne(agent))
    }

    yield* Effect.never
  })
