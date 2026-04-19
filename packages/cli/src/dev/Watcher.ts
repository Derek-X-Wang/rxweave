import { Effect, Queue, Stream } from "effect"

/**
 * Wrap `@parcel/watcher` as an Effect-native Stream of event paths.
 *
 * `@parcel/watcher.subscribe` expects a **directory**, not a file — when
 * watching a specific file, the caller should pass the file's parent
 * directory and filter events downstream (see `dev.ts`).
 *
 * The callback runs on the native watcher thread's boundary, so we
 * funnel events through a Queue to get back onto an Effect fiber. The
 * returned `close` Effect unsubscribes the native handle.
 *
 * Why the dynamic import? `@parcel/watcher` ships a native `.node`
 * binding (`build/Release/watcher.node`) that `bun build --compile`
 * cannot embed into a standalone binary. Eagerly importing it at module
 * top-level means any command path — even `init` or `emit` — crashes
 * when the compiled `rxweave-bin` is first loaded. Deferring the import
 * to the first `dev` invocation keeps the rest of the CLI usable from
 * the compiled binary; only `dev` still needs a real Node/Bun runtime
 * with access to the native addon on disk.
 */
export const watchPath = (path: string) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<string>()
    const mod = yield* Effect.promise(() => import("@parcel/watcher"))
    const watcher = mod.default ?? mod
    const sub = yield* Effect.promise(() =>
      watcher.subscribe(path, (err, events) => {
        if (err) return
        for (const e of events) {
          // The watcher callback isn't running on an Effect fiber, so
          // fire-and-forget the enqueue via runPromise. Queue.offer on an
          // unbounded queue never blocks, so this is safe.
          void Effect.runPromise(queue.offer(e.path))
        }
      }),
    )
    return {
      events: Stream.fromQueue(queue),
      close: Effect.promise(() => sub.unsubscribe()),
    }
  })
