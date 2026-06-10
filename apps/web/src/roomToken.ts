/**
 * Room token resolution for the shared-room dogfood.
 *
 * The room bearer token is passed in the URL hash as `#room=<token>`.
 * Hashes are NEVER sent to any server by the browser (they are client-
 * only per the HTTP spec and the URL standard), so the token is safe to
 * pass in-URL for sharing a room link.
 *
 * Precedence:
 *   1. `#room=<token>` in `location.hash`  (shared-room link)
 *   2. `VITE_RXWEAVE_TOKEN` env var         (local-dev fallback only)
 *
 * ⚠ SECURITY NOTE: this token grants full read+write to the tenant's
 * event stream. Anyone with the link is in the room. Acceptable for a
 * first dogfood among trusted people — NOT for public URLs.
 * Revocable/scoped invites are a deferred follow-up (see HANDOFF.md).
 *
 * The token is returned as an in-memory value ONLY. It is NEVER written
 * to localStorage, sessionStorage, or the built bundle.
 */

export interface RoomConfig {
  /** Bearer token to use for the CloudStore, or undefined for no-auth. */
  readonly token: string | undefined
  /** RPC origin, always from VITE_RXWEAVE_ORIGIN or window.location.origin. */
  readonly origin: string
  /** True if the token came from the URL hash (shared-room mode). */
  readonly fromHash: boolean
}

/**
 * Parse `#room=<token>` from a raw `location.hash` string.
 * Returns `undefined` if the hash is absent, empty, or malformed
 * (e.g., `#room=` with no value).
 */
export function parseRoomHash(hash: string): string | undefined {
  if (!hash || hash === "#") return undefined
  // Strip the leading '#' and parse as URLSearchParams-style key=value.
  // We only look at the first `room=` parameter; extra params are ignored.
  const bare = hash.startsWith("#") ? hash.slice(1) : hash
  const params = new URLSearchParams(bare)
  const value = params.get("room")
  // Reject empty strings — `#room=` with no value is malformed.
  if (!value || value.trim() === "") return undefined
  return value
}

/**
 * Resolve the room config at startup from the current page URL and env vars.
 * Call once; keep the result in memory for the lifetime of the page.
 *
 * @param hash - `location.hash` (injectable for tests; defaults to live value)
 * @param envToken - `import.meta.env.VITE_RXWEAVE_TOKEN` (injectable for tests)
 * @param envOrigin - `import.meta.env.VITE_RXWEAVE_ORIGIN` (injectable for tests)
 * @param windowOrigin - `window.location.origin` (injectable for tests)
 */
export function resolveRoomConfig(
  hash: string,
  envToken: string | undefined,
  envOrigin: string | undefined,
  windowOrigin: string,
): RoomConfig {
  const origin = envOrigin ?? windowOrigin
  const hashToken = parseRoomHash(hash)
  if (hashToken !== undefined) {
    return { token: hashToken, origin, fromHash: true }
  }
  // Fall back to env token (local-dev only).
  return { token: envToken || undefined, origin, fromHash: false }
}
