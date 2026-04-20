import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { EventStore } from "@rxweave/core"
import { FileStore } from "@rxweave/store-file"
import { EventRegistry, type EventDef } from "@rxweave/schema"
import { AgentCursorStore, supervise, type AgentDef } from "@rxweave/runtime"
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

// Opt-in LLM suggester agent. Gated on ANTHROPIC_API_KEY so the canvas
// works standalone. Dynamic import keeps @ai-sdk/anthropic out of the
// startup path when the key is missing.
if (process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY) {
  const { suggesterAgent } = await import("./agents/suggester.js")
  // defineLlmAgent returns AgentDef<never>; supervise wants
  // AgentDef<any>. The parameter is only used when reduce is set,
  // which llm agents never use — cast is safe.
  runtime.runFork(
    supervise([suggesterAgent as unknown as AgentDef<any>]) as Effect.Effect<
      void,
      unknown,
      EventStore | EventRegistry | AgentCursorStore
    >,
  )
  const provider = process.env.OPENROUTER_API_KEY ? "openrouter" : "anthropic"
  console.log(`[canvas] LLM suggester agent active (${provider})`)
} else {
  console.log(
    "[canvas] LLM suggester: inactive (set OPENROUTER_API_KEY or ANTHROPIC_API_KEY to enable)",
  )
}

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
