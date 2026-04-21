import { randomBytes } from "node:crypto"
import { chmodSync, writeFileSync } from "node:fs"
import { Effect } from "effect"

/**
 * Generates a random 256-bit bearer token with an `rxk_` prefix so
 * it's easy to spot in shell history, logs, and `.npmrc` files. The
 * prefix also makes leaked credentials grep-able in incident response
 * — a common ask from security teams reviewing token formats.
 *
 * 32 bytes (256 bits) of entropy hex-encoded = 64 char body, matching
 * spec §5.4's ephemeral-token sizing. We intentionally use Node's
 * `crypto.randomBytes` (CSPRNG) rather than `Math.random`; the token
 * is the sole gate on local RPC access in default-on auth mode.
 */
export const generateToken = (): string =>
  `rxk_${randomBytes(32).toString("hex")}`

/**
 * Generates a token, writes it to disk with restrictive perms, and
 * returns the token for the caller to display on stdout and use for
 * its own clients (browser, CLI, etc.).
 *
 * Cross-platform: POSIX sets mode 0600; on Windows chmod is a no-op,
 * which matches spec §5.4's "best-effort — POSIX 0600 or Windows
 * equivalent ACL, warn-and-continue if neither applies." A future
 * iteration may invoke `icacls` on Windows; v1 skips that complexity
 * and leaves a TODO via the caught-and-ignored chmod error.
 *
 * Embedded clients read this same file to authenticate against the
 * local server (spec §3.3), so the filename / contents format is a
 * stable contract — the file contains the raw token plus a trailing
 * newline for editor friendliness; consumers should `.trim()`.
 */
export const generateAndPersistToken = (opts: {
  readonly tokenFile: string
}): Effect.Effect<string> =>
  Effect.sync(() => {
    const token = generateToken()
    // Pass `mode: 0o600` to writeFileSync so the file is created with
    // tight perms atomically — no TOCTOU window between create (at
    // umask-default 0644) and the chmod tightening below. The explicit
    // chmodSync stays as a fallback for pre-existing files whose perms
    // would otherwise be preserved by the write.
    writeFileSync(opts.tokenFile, token + "\n", { encoding: "utf8", mode: 0o600 })
    try {
      chmodSync(opts.tokenFile, 0o600)
    } catch {
      // Best-effort: Windows will silently no-op chmod in practice,
      // but chmodSync may still throw on locked-down file systems.
      // Per spec §5.4 the CLI entry point warns-and-continues; here
      // at the library layer we swallow the error and let the caller
      // observe the (non-)perms via stat if they care. Deferring full
      // Windows ACL (icacls) to a later hardening pass.
    }
    return token
  })

/**
 * Verifies a bearer token against a small set of expected values
 * using constant-time comparison to blunt timing side-channels.
 *
 * Semantics:
 *   - `expected.length === 0` ⇒ no-auth mode: every request passes.
 *     This is what `startServer` uses when `opts.auth` is undefined,
 *     letting embedded callers skip middleware setup entirely.
 *   - `expected.length >= 1` ⇒ provided token must match at least one
 *     expected token; comparison is constant-time per candidate.
 *
 * The linear scan over `expected` leaks *which* token matched through
 * timing, but that is not a secret we protect — any of the tokens is
 * an equivalent gate. What we do protect is the *value* of each token
 * byte-by-byte, via `constantTimeEquals`.
 *
 * Expected list size is tiny (one per server instance in the current
 * design), so we forgo hashing/indexing optimizations.
 */
export const verifyToken = (opts: {
  readonly expected: ReadonlyArray<string>
  readonly provided: string
}): boolean => {
  if (opts.expected.length === 0) return true // no-auth mode
  return opts.expected.some((e) => constantTimeEquals(e, opts.provided))
}

/**
 * Fixed-length XOR-accumulation comparison. We explicitly do NOT use
 * `crypto.timingSafeEqual` here to avoid an allocation + Buffer import
 * per request; for strings of identical length the XOR loop is
 * equivalently timing-safe and simpler to audit. The early return on
 * length mismatch is not a leak because lengths of expected tokens
 * are not secret (always the generated `rxk_<64-hex>` format).
 */
const constantTimeEquals = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}
