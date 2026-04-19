import { Effect, Queue, Stream } from "effect"
import watcher from "@parcel/watcher"

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
 */
export const watchPath = (path: string) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<string>()
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
