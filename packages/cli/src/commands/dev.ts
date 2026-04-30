import { Command } from "@effect/cli"
import { Effect, Fiber, Ref, Scope, Stream } from "effect"
import * as Path from "node:path"
import { EventRegistry } from "@rxweave/schema"
import { AgentCursorStore, supervise } from "@rxweave/runtime"
import { EventStore } from "@rxweave/core"
import { Output } from "../Output.js"
import { loadConfig } from "../Config.js"
import { configOption } from "../Main.js"
import { watchPath } from "../dev/Watcher.js"

/**
 * `rxweave dev` — load a config, start a Supervisor under a scope, and
 * restart the whole fiber tree whenever the config file changes.
 *
 * Why watch the config file's **directory** and filter? `@parcel/watcher`
 * only subscribes at the directory level (it's a native wrapper around
 * FSEvents / inotify / ReadDirectoryChangesW). Passing a file path to
 * `subscribe` throws. So we watch `dirname(config)` and filter events
 * whose path matches the absolute config path.
 *
 * Why `Path.resolve(process.cwd(), config)`? `loadConfig` does
 * `await import(path)`, and dynamic `import()` resolves relative paths
 * against the importing module's URL — not the user's cwd. Making the
 * path absolute up front avoids that class of bug.
 *
 * Why `Effect.scoped` at the bottom? `Effect.forkScoped` needs a Scope
 * in its environment. The surrounding `Command.make` handler has no
 * scope by default, so we open one explicitly at the effect's outer
 * edge. The scope closes when `dev` exits (ctrl-c) which interrupts
 * all forked fibers — including the Supervisor and the watcher.
 *
 * Why `AgentCursorStore.Memory` and not `.File`? For v0.1 dev loops the
 * user restarts frequently; persisting cursors across restarts is a
 * v0.2 feature. The config could later carry an optional
 * `cursorStore: Layer` field.
 */
export const devCommand = Command.make("dev", { config: configOption }, ({ config }) =>
  Effect.gen(function* () {
    const out = yield* Output
    const currentFiber = yield* Ref.make<Fiber.RuntimeFiber<unknown, unknown> | null>(null)
    const absConfig = Path.isAbsolute(config) ? config : Path.resolve(process.cwd(), config)

    const startup = Effect.gen(function* () {
      const cfg = yield* loadConfig(absConfig)
      const reg = yield* EventRegistry
      yield* reg.registerAll(cfg.schemas)
      // `supervise` publishes R = unknown in its `.d.ts` because the
      // AgentDef<any> generic collapses at the module boundary. We know
      // from the source that it only needs EventStore + AgentCursorStore
      // + Scope, so we narrow here so the handler's R channel stays
      // provable and the BunRuntime runMain at the entry point types
      // cleanly.
      const supervised = supervise(cfg.agents) as Effect.Effect<
        void,
        unknown,
        EventStore | AgentCursorStore | Scope.Scope
      >
      const fiber = yield* Effect.forkScoped(
        supervised.pipe(Effect.provide(cfg.store)),
      )
      yield* Ref.set(currentFiber, fiber as Fiber.RuntimeFiber<unknown, unknown>)
      yield* out.writeLine({ kind: "dev-ready", agents: cfg.agents.length })
    })

    yield* startup
    const watched = yield* watchPath(Path.dirname(absConfig))
    yield* Stream.runForEach(watched.events, (eventPath) =>
      Effect.gen(function* () {
        if (Path.resolve(eventPath) !== absConfig) return
        yield* out.writeLine({ kind: "dev-reload", path: eventPath })
        const prev = yield* Ref.get(currentFiber)
        if (prev) yield* Fiber.interrupt(prev)
        yield* startup
      }),
    )
  }).pipe(
    Effect.provide(EventRegistry.Live),
    Effect.provide(AgentCursorStore.Memory),
    Effect.scoped,
  ),
)
