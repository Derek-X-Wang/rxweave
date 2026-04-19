import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Duration, Effect, Schema } from "effect"
import { MockLanguageModelV2 } from "ai/test"
import { EventStore } from "@rxweave/core"
import { MemoryStore } from "@rxweave/store-memory"
import { AgentCursorStore, supervise } from "@rxweave/runtime"
import { defineLlmAgent, tool } from "../src/index.js"

// Mock LLM that returns the given tool call on the first step, then
// `stop` with text on subsequent steps — otherwise AI SDK keeps looping
// until `stopWhen: stepCountIs(N)` and every step would re-emit the
// same tool call.
const respondWithToolCall = (toolName: string, input: unknown) => {
  let callCount = 0
  return new MockLanguageModelV2({
    doGenerate: async () => {
      callCount += 1
      if (callCount === 1) {
        return {
          finishReason: "tool-calls",
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName,
              input: JSON.stringify(input),
            },
          ],
          warnings: [],
        }
      }
      return {
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        content: [{ type: "text", text: "Done." }],
        warnings: [],
      }
    },
  })
}

const respondWithText = (text: string) =>
  new MockLanguageModelV2({
    doGenerate: async () => ({
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      content: [{ type: "text", text }],
      warnings: [],
    }),
  })

describe("defineLlmAgent", () => {
  it.scopedLive(
    "LLM calls a tool → tool handler runs → events emit with causedBy stamping",
    () =>
      Effect.gen(function* () {
        const agent = defineLlmAgent({
          id: "task-extractor",
          on: { types: ["speech.transcribed"] },
          model: respondWithToolCall("createTask", { title: "Buy milk" }),
          systemPrompt: "Extract tasks from speech.",
          tools: {
            createTask: tool({
              description: "Create a task",
              schema: Schema.Struct({ title: Schema.String }),
              handler: (args) =>
                Effect.succeed([
                  { type: "task.created", payload: { title: args.title } },
                ] as const),
            }),
          },
        })

        yield* Effect.forkScoped(supervise([agent]))
        const store = yield* EventStore
        yield* Effect.sleep(Duration.millis(10))
        yield* store.append([
          {
            type: "speech.transcribed",
            actor: "user",
            source: "voice",
            payload: { text: "I need to buy milk" },
          },
        ])
        yield* Effect.sleep(Duration.millis(50))

        const tasks = yield* store.query({ types: ["task.created"] }, 10)
        expect(tasks.length).toBe(1)
        expect((tasks[0]!.payload as { title: string }).title).toBe("Buy milk")
        expect(tasks[0]!.actor).toBe("task-extractor")
        expect(tasks[0]!.source).toBe("agent")
        expect(tasks[0]!.causedBy?.length).toBe(1)
      }).pipe(
        Effect.provide(MemoryStore.Live),
        Effect.provide(AgentCursorStore.Memory),
      ),
  )

  it.scopedLive(
    "LLM returns text without calling a tool → no events emitted",
    () =>
      Effect.gen(function* () {
        const agent = defineLlmAgent({
          id: "quiet-agent",
          on: { types: ["demo.ping"] },
          model: respondWithText("The user didn't ask for anything."),
          systemPrompt: "Do nothing unless asked.",
          tools: {
            createTask: tool({
              description: "Create a task",
              schema: Schema.Struct({ title: Schema.String }),
              handler: (args) =>
                Effect.succeed([
                  { type: "task.created", payload: { title: args.title } },
                ] as const),
            }),
          },
        })

        yield* Effect.forkScoped(supervise([agent]))
        const store = yield* EventStore
        yield* Effect.sleep(Duration.millis(10))
        yield* store.append([
          { type: "demo.ping", actor: "tester", source: "cli", payload: {} },
        ])
        yield* Effect.sleep(Duration.millis(50))

        const tasks = yield* store.query({ types: ["task.created"] }, 10)
        expect(tasks.length).toBe(0)
      }).pipe(
        Effect.provide(MemoryStore.Live),
        Effect.provide(AgentCursorStore.Memory),
      ),
  )

  it.scopedLive(
    "multi-step: LLM calls tool twice before finishing → both events emit",
    () =>
      Effect.gen(function* () {
        let callCount = 0
        const agent = defineLlmAgent({
          id: "multi-task",
          on: { types: ["demo.ping"] },
          model: new MockLanguageModelV2({
            doGenerate: async () => {
              callCount += 1
              if (callCount <= 2) {
                return {
                  finishReason: "tool-calls",
                  usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
                  content: [
                    {
                      type: "tool-call",
                      toolCallId: `call-${callCount}`,
                      toolName: "createTask",
                      input: JSON.stringify({ title: `Task ${callCount}` }),
                    },
                  ],
                  warnings: [],
                }
              }
              return {
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                content: [{ type: "text", text: "Done." }],
                warnings: [],
              }
            },
          }),
          systemPrompt: "Create two tasks.",
          tools: {
            createTask: tool({
              description: "Create a task",
              schema: Schema.Struct({ title: Schema.String }),
              handler: (args) =>
                Effect.succeed([
                  { type: "task.created", payload: { title: args.title } },
                ] as const),
            }),
          },
        })

        yield* Effect.forkScoped(supervise([agent]))
        const store = yield* EventStore
        yield* Effect.sleep(Duration.millis(10))
        yield* store.append([
          { type: "demo.ping", actor: "tester", source: "cli", payload: {} },
        ])
        yield* Effect.sleep(Duration.millis(100))

        const tasks = yield* store.query({ types: ["task.created"] }, 10)
        expect(tasks.length).toBe(2)
        expect((tasks[0]!.payload as { title: string }).title).toBe("Task 1")
        expect((tasks[1]!.payload as { title: string }).title).toBe("Task 2")
      }).pipe(
        Effect.provide(MemoryStore.Live),
        Effect.provide(AgentCursorStore.Memory),
      ),
  )

  it.scopedLive("systemPrompt may be a function of the incoming event", () =>
    Effect.gen(function* () {
      let capturedPrompt = ""
      const agent = defineLlmAgent({
        id: "dyn-prompt",
        on: { types: ["demo.ping"] },
        model: new MockLanguageModelV2({
          doGenerate: async ({ prompt }) => {
            capturedPrompt = JSON.stringify(prompt)
            return {
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              content: [{ type: "text", text: "ok" }],
              warnings: [],
            }
          },
        }),
        systemPrompt: (event) => `Context: ${event.type}`,
        tools: {},
      })

      yield* Effect.forkScoped(supervise([agent]))
      const store = yield* EventStore
      yield* Effect.sleep(Duration.millis(10))
      yield* store.append([
        { type: "demo.ping", actor: "tester", source: "cli", payload: {} },
      ])
      yield* Effect.sleep(Duration.millis(50))

      expect(capturedPrompt).toContain("Context: demo.ping")
    }).pipe(
      Effect.provide(MemoryStore.Live),
      Effect.provide(AgentCursorStore.Memory),
    ),
  )
})
