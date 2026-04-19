/**
 * Retry classification for the cloud subscribe stream.
 *
 * Not every error is worth retrying — a `NotFoundWireError` or
 * `RegistryWireError` will never self-heal on reconnect (the target
 * event really isn't there, or the schemas really don't match), so
 * retrying just burns latency before surfacing the error to the
 * caller. This helper sorts errors into "transient, keep trying" vs
 * "permanent, give up now".
 *
 * Heuristic:
 *   - `RpcClientError` + anything shaped like a network/transport
 *     failure → RETRY. The server is plausibly fine; the wire is not.
 *   - `SubscribeWireError` with `lagged` semantics → RETRY. The cloud
 *     can't replay from the requested cursor because its retention
 *     window has passed; the subscribe loop will rewind using the
 *     last-delivered cursor on reconnect (see CloudStore `connect`).
 *   - `NotFoundWireError`, `RegistryWireError`, and other tagged
 *     protocol errors → DO NOT retry.
 *   - Anything else (unknown shape) → DO NOT retry, fail safe. Better
 *     to surface a clean error than loop invisibly.
 */

const TRANSIENT_TAGS = new Set<string>([
  // Transport-layer error surfaced by @effect/rpc when the HTTP
  // request itself fails (DNS, connection reset, timeout, 5xx).
  "RpcClientError",
])

const PERMANENT_TAGS = new Set<string>([
  "NotFoundWireError",
  "RegistryWireError",
  "AppendWireError",
  "QueryWireError",
])

/**
 * Returns `true` if the given error should cause the subscribe stream
 * to retry; `false` if the error is permanent and should be surfaced.
 *
 * Structural check on `_tag` so we don't have to import every possible
 * error class — the wire errors live across packages and the transport
 * errors live inside `@effect/rpc`. Unknown tags default to NOT
 * retryable; loops on unknown errors are worse than surfacing them.
 */
export const isRetryable = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false

  const tag = (err as { readonly _tag?: unknown })._tag
  if (typeof tag === "string") {
    if (PERMANENT_TAGS.has(tag)) return false
    if (TRANSIENT_TAGS.has(tag)) return true
    // SubscribeWireError is permanent unless the server flagged it
    // as a retention/lag condition — in that case the client rewinds
    // using the last-delivered cursor and can make progress.
    if (tag === "SubscribeWireError") {
      const lagged = (err as { readonly lagged?: unknown }).lagged
      const reason = (err as { readonly reason?: unknown }).reason
      if (lagged === true) return true
      if (typeof reason === "string" && reason.toLowerCase().includes("lag")) {
        return true
      }
      return false
    }
  }

  // HTTP status carried through (e.g. if a middleware attached one).
  // 4xx is permanent — a 401/403 won't magically heal without a new
  // token; retrying a 404 doesn't change the resource. 5xx is
  // transient.
  const status = (err as { readonly status?: unknown }).status
  if (typeof status === "number") {
    if (status >= 400 && status < 500) return false
    if (status >= 500 && status < 600) return true
  }

  return false
}
