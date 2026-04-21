import { Context, Layer } from "effect"

/**
 * Shape mirrors the cloud's `TenantShape` at
 * `cloud/packages/backend/convex/lib/effectContext.ts` so handler code
 * extracted into `packages/protocol/src/handlers/` works unchanged
 * against either backend.
 *
 * - `tenantId`: the owning tenant; scope for all store reads/writes.
 * - `subject`: the calling principal — for `"user"` callers this equals
 *   `tenantId` under v0.1's single-user-per-tenant rule; for `"apikey"`
 *   callers this is the API key id.
 * - `kind`: whether the caller is a user or an API key.
 */
export interface TenantShape {
  readonly tenantId: string
  readonly subject: string
  readonly kind: "user" | "apikey"
}

/**
 * Single-tenant identity for local embedded / standalone `rxweave serve`.
 * The cloud version provides a per-request tenant from bearer-token auth;
 * this local version hard-codes one. `kind: "user"` reflects the fact that
 * a local-dev caller is acting as their own single user, and `subject` is
 * set equal to `tenantId` matching cloud's single-tenant-per-user rule.
 */
export class Tenant extends Context.Tag("rxweave/server/Tenant")<Tenant, TenantShape>() {
  static readonly LocalSingleton: Layer.Layer<Tenant> = Layer.succeed(
    Tenant,
    { tenantId: "local", subject: "local", kind: "user" },
  )
}
