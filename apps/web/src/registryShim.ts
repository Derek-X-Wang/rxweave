/**
 * Fetch-based RegistryRpcClient shim for hash-room / cloud mode.
 *
 * In cloud/hash-room mode the bridge needs to push its local canvas schemas
 * to the server so the Append digest gate passes, but the bridge can't use
 * the @effect/rpc-generated client directly (the generated client uses
 * BunHttpClient, which isn't available in the browser). Instead, we hand-
 * roll a minimal RegistryRpcClient using plain `fetch`.
 *
 * @effect/rpc wire contract:
 *   - Each call is a POST to the RPC endpoint with a single NDJSON line:
 *       {"_tag":"Request","id":"<id>","tag":"<rpc-name>","payload":{...},"headers":[]}
 *   - The server replies with a single NDJSON line:
 *       {"exit":{"_tag":"Success","value":{...}}}
 *     or {"exit":{"_tag":"Failure","cause":{...}}}
 *
 * Critical: `id` MUST be a numeric string (bigint-parseable).
 *   @effect/rpc decodes Request.id as a bigint (RequestId). A non-numeric
 *   value like "rs-diff" causes `@rxweave/server` to throw
 *   "Failed to parse String to BigInt", which fails the mount-time
 *   syncRegistry call and leaves both tabs stuck at "Waiting for events… 0".
 *   Convex's hand-rolled bypass tolerated arbitrary string ids, which masked
 *   the bug until the first real two-tab test against a local server.
 *   Each call is its own POST/stream, so a constant "1" is fine.
 */

import { Effect } from "effect"
import type { EventDefWire } from "@rxweave/schema"
import type { RegistryRpcClient } from "@rxweave/store-cloud"

export function makeRegistryShim(rpcUrl: string, authHdr: Record<string, string>): RegistryRpcClient {
  const rpcCall = <T>(tag: string, payload: unknown) =>
    Effect.tryPromise(async () => {
      const body = JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] }) + "\n"
      const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/ndjson", ...authHdr }, body })
      const text = await res.text()
      const msg = JSON.parse(text.trim().split("\n")[0]!) as { exit: { _tag: string; value?: unknown; cause?: unknown } }
      if (msg.exit._tag !== "Success") throw new Error(JSON.stringify(msg.exit))
      return msg.exit.value as T
    })

  return {
    RegistrySyncDiff: ({ clientDigest }) =>
      rpcCall<{ upToDate: boolean; missingOnClient: ReadonlyArray<EventDefWire>; missingOnServer: ReadonlyArray<string> }>(
        "RegistrySyncDiff",
        { clientDigest },
      ),
    RegistryPush: ({ defs }) =>
      rpcCall<void>("RegistryPush", {
        defs: defs.map((d) => ({ type: d.type, version: d.version, payloadSchema: d.payloadSchema, digest: d.digest })),
      }).pipe(Effect.asVoid),
  }
}
