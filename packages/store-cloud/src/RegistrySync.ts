/**
 * Registry digest negotiation helper.
 *
 * The cloud rejects `Append` calls whose `registryDigest` doesn't match the
 * server's. To avoid per-append registry pushes, callers can run this helper
 * once at startup (or when the server returns `registry-out-of-date`) to
 * reconcile the local registry with the server's.
 *
 * The sync is one-way from client to server: we trust the client's registry
 * as the source of truth and push any defs the server is missing. If the
 * server has defs the client doesn't, we surface them in the return so the
 * caller can decide (usually: ignore — the client just doesn't use those
 * event types).
 *
 * This module exports a narrow Effect that takes an RpcClient-like object;
 * that keeps the helper testable without spinning up a real HTTP layer.
 */

import { Effect } from "effect"
import { EventRegistry, type EventDefWire } from "@rxweave/schema"

/**
 * Minimal subset of the RPC client surface we consume for registry sync.
 * Typed structurally so callers can pass the output of
 * `RpcClient.make(RxWeaveRpc)` directly — the structural match means we
 * stay compatible if the group grows new RPCs.
 */
export type RegistryRpcClient = {
  readonly RegistrySyncDiff: (input: { readonly clientDigest: string }) => Effect.Effect<
    {
      readonly upToDate: boolean
      readonly missingOnClient: ReadonlyArray<EventDefWire>
      readonly missingOnServer: ReadonlyArray<string>
    },
    unknown,
    never
  >
  readonly RegistryPush: (input: {
    readonly defs: ReadonlyArray<EventDefWire>
  }) => Effect.Effect<void, unknown, never>
}

export interface RegistrySyncResult {
  readonly upToDate: boolean
  readonly pushed: number
  readonly missingOnClient: ReadonlyArray<EventDefWire>
}

/**
 * Negotiate the registry digest with the server, pushing any locally-known
 * defs the server is missing. Returns a summary the caller can log or
 * surface to the user.
 *
 * Rationale for two round-trips (Diff then Push): we don't push defs
 * eagerly — the server's digest is cheap to compute and most startups
 * are already in sync. `RegistryPush` only fires when the digests differ.
 */
export const syncRegistry = (
  client: RegistryRpcClient,
): Effect.Effect<RegistrySyncResult, unknown, EventRegistry> =>
  Effect.gen(function* () {
    const registry = yield* EventRegistry
    const clientDigest = yield* registry.digest
    const diff = yield* client.RegistrySyncDiff({ clientDigest })

    if (diff.upToDate) {
      return {
        upToDate: true,
        pushed: 0,
        missingOnClient: diff.missingOnClient,
      }
    }

    // Push only the defs the server told us it's missing. Falls back
    // to pushing the whole registry when `missingOnServer` is empty —
    // the current cloud server (v0.1 simplification) always returns
    // empty here and trusts the client to reconcile, so the fallback
    // preserves existing behavior. Once the server enumerates
    // `missingOnServer`, we cleanly upgrade to a minimal push.
    const allDefs = yield* registry.wire
    const toPush =
      diff.missingOnServer.length > 0
        ? allDefs.filter((def) => diff.missingOnServer.includes(def.type))
        : allDefs
    if (toPush.length > 0) {
      yield* client.RegistryPush({ defs: toPush })
    }

    return {
      upToDate: false,
      pushed: toPush.length,
      missingOnClient: diff.missingOnClient,
    }
  })
