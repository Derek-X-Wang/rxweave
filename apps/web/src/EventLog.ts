/**
 * In-memory event log for the provenance sidebar.
 *
 * Accumulates every EventEnvelope delivered by the Subscribe stream
 * into a bounded ring buffer (last MAX_EVENTS entries). The log is
 * intentionally lightweight — it is a UI-only concern; the canonical
 * source of truth is the event stream itself.
 *
 * Heartbeat sentinels are NOT filtered here — callers must exclude them
 * before calling `pushEvent`. `RxweaveBridge` does this via the
 * `isHeartbeat` guard from `@rxweave/protocol` before invoking `onEvent`.
 *
 * This module is plain TypeScript with no React or Effect deps so it
 * can be unit-tested independently.
 */

export const MAX_EVENTS = 500

export interface LoggedEvent {
  readonly id: string
  readonly type: string
  readonly actor: string
  readonly causedBy: ReadonlyArray<string>
  /** Raw envelope kept for lineage walk. */
  readonly envelope: {
    readonly id: string
    readonly type: string
    readonly actor: string
    readonly causedBy?: ReadonlyArray<string>
    readonly payload: unknown
  }
}

/**
 * Push a new envelope into the log array, capping at MAX_EVENTS.
 * Returns a NEW array (does not mutate the input) so React state
 * update triggering is straightforward via `setState(prev => push(prev, e))`.
 */
export function pushEvent(
  log: ReadonlyArray<LoggedEvent>,
  envelope: {
    readonly id: string
    readonly type: string
    readonly actor: string
    readonly causedBy?: ReadonlyArray<string>
    readonly payload: unknown
  },
): ReadonlyArray<LoggedEvent> {
  const entry: LoggedEvent = {
    id: envelope.id,
    type: envelope.type,
    actor: envelope.actor,
    causedBy: envelope.causedBy ?? [],
    envelope,
  }
  const next = [...log, entry]
  return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next
}

/**
 * Walk the `causedBy` ancestry of an event within the current in-memory
 * log. Returns an ordered chain from the given event up to `maxDepth`
 * levels of causal ancestors, stopping early if an ancestor is not in
 * the log (e.g., pre-load history) or if a cycle is detected.
 *
 * Cycle detection: a `visited` Set tracks every id added to the chain.
 * If `causedBy[0]` points to an already-visited id (including a self-loop
 * like e1.causedBy=[e1]), the walk terminates cleanly — no duplicate ids
 * in the result, no infinite loop.
 *
 * The returned array has the queried event first and its oldest reachable
 * ancestor last.
 */
export function walkLineage(
  log: ReadonlyArray<LoggedEvent>,
  eventId: string,
  maxDepth = 5,
): ReadonlyArray<LoggedEvent> {
  const byId = new Map<string, LoggedEvent>(log.map((e) => [e.id, e]))
  const chain: LoggedEvent[] = []
  const visited = new Set<string>()
  let current = byId.get(eventId)
  let depth = 0
  while (current !== undefined && depth < maxDepth) {
    if (visited.has(current.id)) break
    visited.add(current.id)
    chain.push(current)
    depth++
    const parentId = current.causedBy[0]
    if (parentId === undefined) break
    current = byId.get(parentId)
  }
  return chain
}
