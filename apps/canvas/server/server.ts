import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { EventStore } from "@rxweave/core"
import { FileStore } from "@rxweave/store-file"
import { EventRegistry, type EventDef } from "@rxweave/schema"
import { AgentCursorStore } from "@rxweave/runtime"
import {
  CanvasBindingDeleted,
  CanvasBindingUpserted,
  CanvasShapeDeleted,
  CanvasShapeUpserted,
} from "./schemas.js"

const PORT = 5301
const STORE_PATH = ".rxweave/canvas.jsonl"

const AppLive = Layer.mergeAll(
  FileStore.Live({ path: STORE_PATH }),
  EventRegistry.Live,
  AgentCursorStore.Memory,
)

// Widening each `defineEvent(...)` to `EventDef` sidesteps the
// `exactOptionalPropertyTypes` co/contravariance mismatch between
// narrow `EventDef<A, I>` and the `EventDef<unknown, unknown>` that
// `reg.register(def)` expects — same pattern as the CLI config loader.
const schemas: ReadonlyArray<EventDef> = [
  CanvasShapeUpserted as EventDef,
  CanvasShapeDeleted as EventDef,
  CanvasBindingUpserted as EventDef,
  CanvasBindingDeleted as EventDef,
]

const registerSchemas = Effect.gen(function* () {
  const reg = yield* EventRegistry
  for (const def of schemas) yield* reg.register(def)
})

const runtime = ManagedRuntime.make(AppLive)

await runtime.runPromise(registerSchemas)

// Phase 2 (LLM suggester agent) is wired here — see README. Not yet
// implemented.

Bun.serve({
  port: PORT,
  idleTimeout: 0, // SSE subscribers may be idle for minutes; don't close them
  routes: {
    "/api/events": {
      POST: async (req) => {
        const body = (await req.json()) as {
          type: string
          payload: unknown
          actor?: string
          source?: string
        }
        await runtime.runPromise(
          Effect.gen(function* () {
            const store = yield* EventStore
            yield* store.append([
              {
                type: body.type,
                actor: (body.actor ?? "human") as never,
                source: (body.source ?? "canvas") as never,
                payload: body.payload,
              },
            ])
          }),
        )
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        })
      },
    },
    "/api/subscribe": {
      GET: () => {
        const enc = new TextEncoder()
        const stream = new ReadableStream({
          start(controller) {
            runtime.runFork(
              Effect.gen(function* () {
                const store = yield* EventStore
                yield* Stream.runForEach(
                  store.subscribe({ cursor: "earliest" }),
                  (event) =>
                    Effect.sync(() => {
                      try {
                        controller.enqueue(
                          enc.encode(`data: ${JSON.stringify(event)}\n\n`),
                        )
                      } catch {
                        // client disconnected; surface via `cancel`
                      }
                    }),
                )
              }),
            )
          },
        })
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        })
      },
    },
  },
})

console.log(`[canvas] server on http://localhost:${PORT}`)
console.log(`[canvas] events log: ${STORE_PATH}`)
