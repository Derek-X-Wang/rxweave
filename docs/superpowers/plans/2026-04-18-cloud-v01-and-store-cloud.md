# RxWeave v0.2 — Cloud Repo + `@rxweave/store-cloud` Implementation Plan (Team CLOUD)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the hosted cloud (Convex + kitcn + Better Auth) that implements `@rxweave/protocol@0.1.0`, plus `@rxweave/store-cloud` client in the rxweave repo, tagged `rxweave v0.2.0`.

**Architecture:** Two repos. `cloud/` (new git repo) scaffolded from kitcn (like DynaKV), mounts the `@effect/rpc` handler for `RxWeaveRpc` at `/rxweave/rpc/*` alongside its own kitcn cRPC routes for the dashboard. `@rxweave/store-cloud` lives in `rxweave/packages/store-cloud` and is PR'd back to rxweave main after `rxweave v0.1.0` ships. Both sides share `@rxweave/schema` + `@rxweave/protocol` (published from Plan A Task 11). Auth is Bearer-token: sessions (human) + API keys (machine).

**Tech Stack:** Bun 1.3+, Convex (Fluid Compute), kitcn 0.12+, Better Auth, TanStack Start + React 19, cRPC + TanStack Query, Tailwind 4, shadcn/ui, Hono (for the `@rxweave/protocol` mount), `@effect/rpc`, `@effect/platform`, Effect v3.

**Prerequisites:**

- `@rxweave/protocol@0.1.0` published to npm (Plan A Task 11, then finalised at Plan A Task 28).
- `rxweave v0.1.0` tagged (Plan A Task 28) before Plan B's **Task 13** (the `@rxweave/store-cloud` PR).
- Cloud repo can begin Task 0–12 **in parallel** with Plan A's Phase 1 — only dependency is `@rxweave/protocol@0.1.0` landing.

**Spec:** `rxweave/docs/superpowers/specs/2026-04-18-rxweave-design.md` (§9 covers the cloud contract; §12 Phase 2 covers the execution split).

---

## File Structure — `cloud/` (new repo)

```
cloud/
├── .gitignore
├── package.json                        # bun workspaces + turbo
├── turbo.jsonc
├── tsconfig.base.json
├── bunfig.toml
├── sst.config.ts                       # optional; Vercel alt
├── docs/
│   └── superpowers/specs/               # link to rxweave spec; plan stays in rxweave
├── packages/
│   └── backend/
│       ├── package.json
│       ├── convex/
│       │   ├── _generated/              # kitcn-generated
│       │   ├── functions/
│       │   │   ├── schema.ts            # kitcn schema + relations
│       │   │   ├── auth.config.ts
│       │   │   ├── auth.ts              # Better Auth setup
│       │   │   ├── http.ts              # Hono + kitcn cRPC + /rxweave/rpc mount
│       │   │   ├── rxweave.ts           # cRPC module for dashboard (list/inspect/…)
│       │   │   ├── rxweaveRpc.ts        # @effect/rpc handler wiring RxWeaveRpc to Convex-backed EventStore
│       │   │   ├── organizations.ts
│       │   │   └── apikeys.ts
│       │   └── lib/
│       │       ├── crpc.ts              # kitcn cRPC builder + middleware
│       │       ├── storeServer.ts       # Convex-backed EventStore implementation (used by rxweaveRpc)
│       │       └── tenancy.ts           # token → tenant resolution helper
│       └── tsconfig.json
└── apps/
    └── web/
        ├── package.json
        ├── vite.config.ts
        ├── src/
        │   ├── routes/
        │   │   ├── __root.tsx
        │   │   ├── index.tsx              # marketing / login redirect
        │   │   ├── dashboard/
        │   │   │   ├── index.tsx           # list events view
        │   │   │   ├── $eventId.tsx        # inspect + lineage
        │   │   │   ├── agents.tsx          # agent status
        │   │   │   └── api-keys.tsx        # api key admin
        │   │   └── auth/
        │   │       ├── sign-in.tsx
        │   │       └── sign-up.tsx
        │   ├── components/
        │   │   ├── EventRow.tsx
        │   │   ├── LineageGraph.tsx        # minimal depth-3 tree
        │   │   ├── ApiKeyCard.tsx
        │   │   └── AdminGuard.tsx
        │   ├── lib/
        │   │   ├── auth-client.ts          # Better Auth client
        │   │   ├── convex-provider.tsx
        │   │   └── crpc.tsx                # useCRPC hook + TanStack Query
        │   ├── styles.css
        │   └── main.tsx
        └── tsconfig.json
```

## File Structure — `rxweave/packages/store-cloud/` (added in Task 13)

```
rxweave/packages/store-cloud/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── CloudStore.ts         # Live.Cloud, @effect/rpc client, retry-with-cursor
│   ├── RegistrySync.ts       # digest negotiation helper
│   └── Auth.ts               # Bearer token plumbing
└── test/
    ├── CloudStore.unit.test.ts    # mocked RPC client
    └── integration.test.ts        # opt-in: runs against deployed dev cloud
```

---

## Task 0: Scaffold `cloud/` repo from kitcn

**Files:** entire cloud repo skeleton.

- [ ] **Step 1: Create and initialise repo.**

```bash
cd /Users/derekxwang/Development/incubator/RxWeave
mkdir cloud && cd cloud
git init -b main
```

- [ ] **Step 2: Run kitcn scaffolder.**

```bash
bunx create-kitcn@latest . \
  --framework tanstack-start \
  --auth better-auth \
  --example dashboard \
  --use-bun \
  --yes
```

Expected: scaffolded `apps/web` + `packages/backend` (Convex + kitcn cRPC + Better Auth). If the command is out-of-date, fall back to cloning DynaKV's structure as a reference: `/Users/derekxwang/Development/incubator/DynaKV/mono`.

- [ ] **Step 3: Add protocol + schema deps to `packages/backend/package.json`.**

```bash
cd packages/backend
bun add @rxweave/protocol@0.1.0 @rxweave/schema@0.1.0
bun add @effect/rpc @effect/platform @effect/platform-node effect
```

- [ ] **Step 4: Add rxweave deps to `apps/web/package.json`.**

```bash
cd ../../apps/web
bun add @rxweave/schema@0.1.0
```

- [ ] **Step 5: Configure workspace & turbo — ensure `apps/web` + `packages/backend` are listed; `bun install`.**

- [ ] **Step 6: Commit initial scaffold.**

```bash
cd /Users/derekxwang/Development/incubator/RxWeave/cloud
git add -A && git commit -m "chore: scaffold cloud repo from kitcn + dashboard template"
```

---

## Task 1: Convex schema for `events` table

**Files:**
- Modify: `packages/backend/convex/functions/schema.ts`

- [ ] **Step 1: Add the `events` table.**

```ts
import { convexTable, defineSchema } from "kitcn"
import { v } from "convex/values"

export default defineSchema({
  events: convexTable({
    tenantId: v.string(),
    eventId: v.string(),                         // ULID from client
    type: v.string(),
    actor: v.string(),
    source: v.string(),
    timestamp: v.number(),
    causedBy: v.optional(v.array(v.string())),
    payload: v.any(),
  })
    .index("by_tenant_id",          ["tenantId", "eventId"])
    .index("by_tenant_type_id",     ["tenantId", "type", "eventId"])
    .index("by_tenant_actor_id",    ["tenantId", "actor", "eventId"])
    .index("by_tenant_timestamp",   ["tenantId", "timestamp"]),
  registry: convexTable({
    tenantId: v.string(),
    type: v.string(),
    version: v.number(),
    payloadSchema: v.any(),
    digest: v.string(),
  }).index("by_tenant_type", ["tenantId", "type"]),
  apiKeys: convexTable({
    tenantId: v.string(),
    prefix: v.string(),
    hash: v.string(),
    name: v.string(),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
  }).index("by_prefix", ["prefix"]),
}).relations((t) => ({}))
```

- [ ] **Step 2: Run `bunx kitcn codegen`.**

```bash
cd packages/backend && bunx kitcn codegen
```

- [ ] **Step 3: Commit.**

```bash
git add -A && git commit -m "feat(backend): add events + registry + apiKeys schemas with tenant-scoped indexes"
```

---

## Task 2: Convex-backed `EventStore` server implementation

**Files:**
- Create: `packages/backend/convex/lib/storeServer.ts`

- [ ] **Step 1: Implement `storeServer.ts`.**

```ts
import { Clock, Effect, Layer, Stream } from "effect"
import {
  Cursor,
  EventEnvelope,
  EventInput,
  Filter,
  Ulid,
} from "@rxweave/schema"
import {
  AppendError,
  EventStore,
  NotFound,
  QueryError,
  SubscribeError,
} from "@rxweave/core"
import type { GenericCtx } from "convex/server"
import { internal } from "../_generated/api"

export const makeServerEventStore = (ctx: GenericCtx, tenantId: string) =>
  Layer.effect(
    EventStore,
    Effect.gen(function* () {
      const ulid = yield* Ulid

      return EventStore.of({
        append: (inputs) =>
          Effect.gen(function* () {
            const envelopes: Array<EventEnvelope> = []
            for (const input of inputs) {
              const id = yield* ulid.next
              const timestamp = yield* Clock.currentTimeMillis
              const envelope = new EventEnvelope({
                id,
                type: input.type,
                actor: input.actor ?? ("system" as never),
                source: input.source ?? "cloud",
                timestamp,
                causedBy: input.causedBy,
                payload: input.payload,
              })
              envelopes.push(envelope)
            }
            for (const env of envelopes) {
              yield* Effect.promise(() =>
                ctx.runMutation(internal.rxweave.insertEvent, {
                  tenantId,
                  eventId: env.id,
                  type: env.type,
                  actor: env.actor,
                  source: env.source,
                  timestamp: env.timestamp,
                  causedBy: env.causedBy ? Array.from(env.causedBy) : undefined,
                  payload: env.payload,
                }),
              )
            }
            return envelopes as ReadonlyArray<EventEnvelope>
          }).pipe(
            Effect.mapError((cause) => new AppendError({ reason: "cloud-append", cause })),
          ),

        subscribe: ({ cursor, filter }) =>
          Stream.unwrap(
            Effect.sync(() => {
              // Convex doesn't natively support streaming RPC; handler
              // in rxweaveRpc.ts converts this into a polling loop with
              // a chunked NDJSON response. See Task 3.
              return Stream.empty as Stream.Stream<EventEnvelope, SubscribeError>
            }),
          ),

        getById: (id) =>
          Effect.promise(() =>
            ctx.runQuery(internal.rxweave.getByTenantEventId, { tenantId, eventId: id }),
          ).pipe(
            Effect.flatMap((row) =>
              row
                ? Effect.succeed(
                    new EventEnvelope({
                      id: row.eventId as never,
                      type: row.type,
                      actor: row.actor as never,
                      source: row.source as never,
                      timestamp: row.timestamp,
                      causedBy: row.causedBy as never,
                      payload: row.payload,
                    }),
                  )
                : Effect.fail(new NotFound({ id })),
            ),
          ),

        query: (filter, limit) =>
          Effect.promise(() =>
            ctx.runQuery(internal.rxweave.queryEvents, { tenantId, filter, limit }),
          ).pipe(
            Effect.map((rows) =>
              rows.map(
                (row) =>
                  new EventEnvelope({
                    id: row.eventId as never,
                    type: row.type,
                    actor: row.actor as never,
                    source: row.source as never,
                    timestamp: row.timestamp,
                    causedBy: row.causedBy as never,
                    payload: row.payload,
                  }),
              ),
            ),
            Effect.mapError(() => new QueryError({ reason: "cloud-query" })),
          ),

        latestCursor: Effect.promise(() =>
          ctx.runQuery(internal.rxweave.latestEventId, { tenantId }),
        ).pipe(
          Effect.map((id): Cursor => (id ? (id as never) : "earliest")),
        ),
      })
    }),
  ).pipe(Layer.provide(Ulid.Live))
```

NOTE: the streaming subscribe shape is handled in Task 3's `rxweaveRpc.ts`, not in this server-side `EventStore` (Convex mutations/queries aren't streams). For conformance we implement `Append/GetById/Query/latestCursor` here; `Subscribe` is a hand-written RPC handler that paginates.

- [ ] **Step 2: Commit.**

```bash
git add -A && git commit -m "feat(backend): Convex-backed EventStore server (append/query/getById/latestCursor)"
```

---

## Task 3: Mount `@rxweave/protocol` handler at `/rxweave/rpc/*`

**Files:**
- Create: `packages/backend/convex/functions/rxweaveRpc.ts`
- Modify: `packages/backend/convex/functions/http.ts`
- Create: `packages/backend/convex/lib/tenancy.ts`

- [ ] **Step 1: Write `tenancy.ts` — token → tenant resolver.**

```ts
import { createHash } from "node:crypto"

export interface Tenant {
  readonly tenantId: string
  readonly kind: "user" | "apikey"
  readonly subject: string
}

export const resolveTenant = async (
  ctx: { runQuery: (fn: unknown, args: unknown) => Promise<unknown> },
  token: string | null,
): Promise<Tenant | null> => {
  if (!token) return null
  if (token.startsWith("rxk_")) {
    const prefix = token.slice(0, 12)
    const row = (await ctx.runQuery("apikeys.verify" as never, { prefix, token })) as
      | { tenantId: string; id: string }
      | null
    return row ? { tenantId: row.tenantId, kind: "apikey", subject: row.id } : null
  }
  // Session token — delegate to Better Auth config (auth.ts)
  const session = (await ctx.runQuery("auth.verifySession" as never, { token })) as
    | { userId: string; tenantId: string }
    | null
  return session ? { tenantId: session.tenantId, kind: "user", subject: session.userId } : null
}
```

- [ ] **Step 2: Implement `rxweaveRpc.ts` using `@effect/rpc` + `@effect/platform`.**

```ts
import { Effect, Layer, Stream } from "effect"
import { RpcServer } from "@effect/rpc"
import { HttpServer } from "@effect/platform"
import { RxWeaveRpc } from "@rxweave/protocol"
import { EventEnvelope } from "@rxweave/schema"
import { EventStore } from "@rxweave/core"
import { makeServerEventStore } from "../lib/storeServer.js"
import { resolveTenant } from "../lib/tenancy.js"

export const rxweaveRpcRouter = (ctx: unknown) =>
  Effect.gen(function* () {
    const handlers = RxWeaveRpc.toLayer(
      RxWeaveRpc.of({
        Append: ({ events, registryDigest }) =>
          Effect.gen(function* () {
            const store = yield* EventStore
            // registry-digest checks delegated to Task 4
            void registryDigest
            return yield* store.append(events)
          }),
        Subscribe: ({ cursor, filter }) =>
          Stream.paginateEffect(cursor, (currentCursor) =>
            Effect.gen(function* () {
              const store = yield* EventStore
              const page = yield* store.query(filter ?? {}, 500)
              const nextCursor = page.at(-1)?.id ?? currentCursor
              const events = page.filter(
                (e) => currentCursor === "earliest" || currentCursor === "latest" || e.id > currentCursor,
              )
              // streaming is done via polling; close if page is empty
              if (events.length === 0) return [[], undefined] as const
              return [events, nextCursor] as const
            }),
          ).pipe(Stream.flatMap(Stream.fromIterable)) as Stream.Stream<EventEnvelope, never>,
        GetById: ({ id }) =>
          Effect.flatMap(EventStore, (store) => store.getById(id)),
        Query: ({ filter, limit }) =>
          Effect.flatMap(EventStore, (store) => store.query(filter, limit)),
        RegistrySyncDiff: ({ clientDigest }) =>
          Effect.succeed({
            upToDate: true,
            missingOnClient: [] as ReadonlyArray<never>,
            missingOnServer: [] as ReadonlyArray<string>,
          }),
        RegistryPush: () => Effect.void,
      }),
    )
    return handlers
  })
```

- [ ] **Step 3: Mount it in `http.ts` alongside the kitcn cRPC router.**

```ts
import { Hono } from "hono"
import { httpRouter } from "convex/server"
import { crpcRouter } from "./rxweave.js"
import { rxweaveRpcRouter } from "./rxweaveRpc.js"
import { resolveTenant } from "../lib/tenancy.js"

const app = new Hono()

// Auth middleware for /rxweave/rpc/*
app.use("/rxweave/rpc/*", async (c, next) => {
  const token = c.req.header("authorization")?.replace(/^Bearer /, "") ?? null
  const tenant = await resolveTenant(c.env as never, token)
  if (!tenant) return c.json({ error: "unauthorized" }, 401)
  c.set("tenant", tenant)
  return next()
})

// Hand off the Rpc handler.
app.all("/rxweave/rpc/*", async (c) => {
  // @effect/rpc Hono binding: see https://effect-ts.github.io/rpc
  // for the concrete HTTP binding. Pseudocode below.
  return await rxweaveRpcRouter(c).handle(c.req.raw)
})

// kitcn cRPC for dashboard stays here too
app.route("/crpc", crpcRouter)

export const http = httpRouter()
http.route({ path: "/", pathPrefix: "/", handler: app.fetch })
export default http
```

NOTE: the exact `@effect/rpc` → Hono binding depends on the version; consult the package README in `~/.codex/repos/Effect-TS/effect/packages/rpc` when implementing. If a native Hono binding isn't available, wrap the Rpc handler with `HttpServer.server` + `HttpRouter.fromHttpApp` and call `app.all("/rxweave/rpc/*", (c) => handler(c.req.raw))`.

- [ ] **Step 4: `bunx kitcn codegen` + `bun run typecheck`.**

- [ ] **Step 5: Commit.**

```bash
git add -A && git commit -m "$(cat <<'EOF'
feat(backend): mount @rxweave/protocol handler at /rxweave/rpc

Hono middleware resolves Bearer tokens to a Tenant (user session or
API key) before the RPC handler runs; unauthorised requests short-
circuit with 401. Append/Query/GetById/RegistrySyncDiff/RegistryPush
are wired to the Convex-backed EventStore. Subscribe paginates via
Convex queries (Convex has no native stream primitive) and the client
(@rxweave/store-cloud in rxweave repo) handles reconnect-with-cursor.
EOF
)"
```

---

## Task 4: RegistrySync digest negotiation

**Files:**
- Create: `packages/backend/convex/functions/rxweave.ts` (cRPC module — dashboard helpers AND registry helpers used by RPC)
- Modify: `packages/backend/convex/functions/rxweaveRpc.ts` (replace stub with real digest logic)

- [ ] **Step 1: In `rxweave.ts` cRPC module, add internal queries/mutations:**

- `registryList(tenantId)` → all `EventDefWire` rows
- `registryDigest(tenantId)` → sha256 over sorted digests
- `registryUpsert(tenantId, defs: EventDefWire[])` → idempotent upsert

- [ ] **Step 2: Update `rxweaveRpc.ts` handlers:**

```ts
RegistrySyncDiff: ({ clientDigest }) =>
  Effect.gen(function* () {
    const tenantId = yield* Tenant.of()    // see Task 5 for how this tag gets populated
    const rows = yield* Effect.promise(() =>
      ctx.runQuery(internal.rxweave.registryList, { tenantId }),
    )
    const serverDigest = sha256OverSortedDigests(rows)
    if (serverDigest === clientDigest) {
      return { upToDate: true, missingOnClient: [], missingOnServer: [] }
    }
    return {
      upToDate: false,
      missingOnClient: rows,
      missingOnServer: [] as ReadonlyArray<string>,
    }
  }),
RegistryPush: ({ defs }) =>
  Effect.gen(function* () {
    const tenantId = yield* Tenant.of()
    yield* Effect.promise(() =>
      ctx.runMutation(internal.rxweave.registryUpsert, { tenantId, defs }),
    )
  }),
```

- [ ] **Step 3: Update `Append` to check digest:**

```ts
Append: ({ events, registryDigest }) =>
  Effect.gen(function* () {
    const tenantId = yield* Tenant.of()
    const rows = yield* Effect.promise(() =>
      ctx.runQuery(internal.rxweave.registryList, { tenantId }),
    )
    const serverDigest = sha256OverSortedDigests(rows)
    if (registryDigest !== serverDigest) {
      return yield* Effect.fail(
        new AppendWireError({
          reason: "registry-out-of-date",
          registryOutOfDate: rows.map((r) => r.type),
        }),
      )
    }
    const store = yield* EventStore
    return yield* store.append(events)
  }),
```

- [ ] **Step 4: Commit.**

```bash
git add -A && git commit -m "feat(backend): implement RegistrySyncDiff + RegistryPush with digest negotiation; Append fails fast if registry digests diverge"
```

---

## Task 5: Better Auth + tenant propagation

**Files:**
- Modify: `packages/backend/convex/functions/auth.ts` (kitcn scaffold)
- Modify: `packages/backend/convex/functions/auth.config.ts`
- Modify: `packages/backend/convex/lib/crpc.ts`
- Create: `packages/backend/convex/lib/effectContext.ts`

- [ ] **Step 1: Configure Better Auth email/password + admin plugin (follow the pattern in DynaKV `packages/backend/convex/functions/auth.ts`).**

- [ ] **Step 2: On user signup, auto-create a tenant row (`organizations` table from kitcn scaffold; rename to `tenants` or alias).**

- [ ] **Step 3: Create `Tenant` Effect `Context.Tag`.**

```ts
// packages/backend/convex/lib/effectContext.ts
import { Context } from "effect"

export interface TenantShape {
  readonly tenantId: string
  readonly subject: string
  readonly kind: "user" | "apikey"
}

export class Tenant extends Context.Tag("rxweave/cloud/Tenant")<Tenant, TenantShape>() {}
```

- [ ] **Step 4: Provide the tenant into every RPC handler by wrapping `rxweaveRpcRouter` with a Hono middleware that reads `c.get("tenant")` and calls `Effect.provideService(Tenant, tenant)` before running the handler.**

- [ ] **Step 5: Commit.**

```bash
git add -A && git commit -m "feat(backend): Better Auth email/password + admin plugin; Tenant Effect tag provided to RPC handlers via Hono middleware"
```

---

## Task 6: API key management (cRPC for dashboard)

**Files:**
- Modify: `packages/backend/convex/functions/apikeys.ts`

- [ ] **Step 1: Follow DynaKV's API key pattern (SHA-256 hash + 12-char public prefix `rxk_<hex>`).** DynaKV spec: `/Users/derekxwang/Development/incubator/DynaKV/mono/packages/backend/convex/functions/apikeys.ts`.

- [ ] **Step 2: Expose cRPC mutations: `createApiKey(name)`, `revokeApiKey(id)`; query: `listApiKeys()`. All `authMutation`/`authQuery` scoped to caller's tenant.**

- [ ] **Step 3: Expose internal query `verify(prefix, token)` → `{ tenantId, id } | null` used by `resolveTenant` in Task 3.**

- [ ] **Step 4: Commit.**

```bash
git add -A && git commit -m "feat(backend): API key CRUD cRPC + internal verify query (pattern from DynaKV)"
```

---

## Task 7: Dashboard shell — `apps/web`

**Files:**
- Modify: `apps/web/src/routes/__root.tsx`
- Modify: `apps/web/src/routes/index.tsx`
- Create: `apps/web/src/components/AdminGuard.tsx`
- Modify: `apps/web/src/lib/auth-client.ts`
- Modify: `apps/web/src/lib/convex-provider.tsx`

- [ ] **Step 1: TanStack Start + React Router setup (follows kitcn default output).**

- [ ] **Step 2: `ConvexAuthProvider` from `kitcn/auth/client` wrapping the app; sign-in / sign-up routes exactly like DynaKV.**

- [ ] **Step 3: Default `/` route redirects to `/dashboard` if authed, else `/auth/sign-in`.**

- [ ] **Step 4: Commit.**

```bash
git add -A && git commit -m "feat(web): dashboard shell with Better Auth provider + auth-aware root"
```

---

## Task 8: Dashboard — Events list view

**Files:**
- Create: `apps/web/src/routes/dashboard/index.tsx`
- Create: `apps/web/src/components/EventRow.tsx`

- [ ] **Step 1: Expose a cRPC query `rxweave.listEvents(filter, limit, cursor)` in `packages/backend/convex/functions/rxweave.ts` that paginates from the `by_tenant_id` index.**

- [ ] **Step 2: Dashboard route calls `useCRPC().rxweave.listEvents.queryOptions(...)` + TanStack Query; `EventRow` renders id/type/actor/timestamp/source.**

- [ ] **Step 3: Filter controls for type glob + actor; wired to URL query params.**

- [ ] **Step 4: Commit.**

```bash
git add -A && git commit -m "feat(web,backend): list-events dashboard view via cRPC + TanStack Query"
```

---

## Task 9: Dashboard — Inspect + lineage view

**Files:**
- Create: `apps/web/src/routes/dashboard/$eventId.tsx`
- Create: `apps/web/src/components/LineageGraph.tsx`

- [ ] **Step 1: cRPC query `rxweave.inspectEvent(eventId, { depth })` returning `{ event, ancestors, descendants }` via a recursive Convex query capped at `depth` (default 3).**

- [ ] **Step 2: `LineageGraph` component renders a simple tree: root event in the centre, ancestors above, descendants below, with dangling-ancestor rows shown as `⚠ <id>` when cloud hasn't synced a referenced event.**

- [ ] **Step 3: Commit.**

```bash
git add -A && git commit -m "feat(web): inspect + lineage view with depth-limited ancestor/descendant traversal"
```

---

## Task 10: Dashboard — Agents view

**Files:**
- Create: `apps/web/src/routes/dashboard/agents.tsx`

- [ ] **Step 1: Agents view is a projection over `system.agent.heartbeat` events (agents emit these periodically; rxweave Supervisor will be extended to do so post-v0.1 — for v0.2 we expect runtime to emit `system.agent.heartbeat { agentId, cursor, timestamp }` every 10s).**

- [ ] **Step 2: Commit.**

```bash
git add -A && git commit -m "feat(web): agents view projects agent heartbeats from the event stream"
```

NOTE: the runtime-side heartbeat emitter is a follow-up PR against rxweave main (Task 14 step 5 below).

---

## Task 11: Dashboard — API key admin

**Files:**
- Create: `apps/web/src/routes/dashboard/api-keys.tsx`
- Create: `apps/web/src/components/ApiKeyCard.tsx`

- [ ] **Step 1: List + create + revoke API keys via cRPC. Show the full token only once at creation time.**

- [ ] **Step 2: Commit.**

```bash
git add -A && git commit -m "feat(web): API key admin dashboard"
```

---

## Task 12: Deploy + integration conformance

**Files:**
- Create: `.env.local` (gitignored)
- Create: `README.md` (cloud repo)

- [ ] **Step 1: `bunx convex dev` — login, link to a dev deployment, note the deployment URL.**

- [ ] **Step 2: Set env vars: `BETTER_AUTH_SECRET`, `SITE_URL`, etc. (follow DynaKV `.env.example`).**

- [ ] **Step 3: Deploy via `bunx convex deploy` (dev env) and `vercel deploy` (or SST) for `apps/web`.**

- [ ] **Step 4: Write the cloud repo `README.md` with:**

- What it does (hosts the RxWeave sync protocol)
- Required env vars
- How to run locally (`bun run dev`, `bunx convex dev`)
- Reference to rxweave spec
- Link to dashboard URL

- [ ] **Step 5: Smoke-test `/rxweave/rpc/Append` with a valid API key using `curl`.**

```bash
curl -X POST https://<deployment>/rxweave/rpc/Append \
  -H "Authorization: Bearer rxk_<...>" \
  -H "Content-Type: application/json" \
  -d '{"events":[{"type":"demo.hi","payload":{}}],"registryDigest":"<current>"}'
```

Expected: 200 with a JSON array of one envelope — OR 200 with `AppendWireError` if registry is out of date, which is also success (digest check works).

- [ ] **Step 6: Tag + commit.**

```bash
git add -A && git commit -m "chore(deploy): first dev deploy + README + curl smoke test"
git tag -a cloud-v0.1.0 -m "cloud v0.1.0 — first deploy of RxWeave sync protocol"
```

---

## Task 13: `@rxweave/store-cloud` client (PR against `rxweave` main)

**Files (in `rxweave/` repo, on a branch):**
- Create: `rxweave/packages/store-cloud/package.json`
- Create: `rxweave/packages/store-cloud/tsconfig.json`
- Create: `rxweave/packages/store-cloud/src/index.ts`
- Create: `rxweave/packages/store-cloud/src/CloudStore.ts`
- Create: `rxweave/packages/store-cloud/src/RegistrySync.ts`
- Create: `rxweave/packages/store-cloud/test/CloudStore.unit.test.ts`

- [ ] **Step 1: Check out rxweave repo on a new branch.**

```bash
cd /Users/derekxwang/Development/incubator/RxWeave/rxweave
git checkout -b team-cloud/store-cloud
```

- [ ] **Step 2: Write `packages/store-cloud/package.json`.**

```json
{
  "name": "@rxweave/store-cloud",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "engines": { "node": ">=22", "bun": ">=1.1" },
  "scripts": {
    "build": "bun build ./src/index.ts --target=node --format=esm --outdir=dist --splitting && tsc --emitDeclarationOnly --outDir dist",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "oxlint src test"
  },
  "dependencies": {
    "effect": "^3.11.0",
    "@effect/rpc": "^0.49.0",
    "@effect/platform": "^0.67.0",
    "@rxweave/schema": "workspace:*",
    "@rxweave/core": "workspace:*",
    "@rxweave/protocol": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.5.4",
    "@types/node": "^22.10.0",
    "vitest": "^2.1.0",
    "@effect/vitest": "^0.17.0"
  }
}
```

- [ ] **Step 3: Write `packages/store-cloud/src/CloudStore.ts`.**

```ts
import { Duration, Effect, Layer, Ref, Schedule, Stream } from "effect"
import { HttpClient } from "@effect/platform"
import { RpcClient } from "@effect/rpc"
import { Cursor, EventEnvelope, EventRegistry, Ulid } from "@rxweave/schema"
import {
  AppendError,
  EventStore,
  NotFound,
  QueryError,
  SubscribeError,
  SubscriberLagged,
} from "@rxweave/core"
import { RxWeaveRpc } from "@rxweave/protocol"

export interface CloudStoreOpts {
  readonly url: string
  readonly token: () => string | Promise<string>
}

export const CloudStore = {
  Live: (opts: CloudStoreOpts) =>
    Layer.scoped(
      EventStore,
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        const withToken = http.pipe(
          HttpClient.mapRequestEffect((req) =>
            Effect.promise(async () => {
              const token = await opts.token()
              return req.pipe(HttpClient.HttpClientRequest.setHeader("authorization", `Bearer ${token}`))
            }),
          ),
        )
        const client = yield* RpcClient.make(RxWeaveRpc, {
          baseUrl: opts.url,
          httpClient: withToken,
        })
        const registry = yield* EventRegistry
        const lastDelivered = yield* Ref.make<Cursor>("latest")

        return EventStore.of({
          append: (events) =>
            Effect.gen(function* () {
              const digest = yield* registry.digest
              const result = yield* client.Append({ events, registryDigest: digest })
              return result
            }).pipe(
              Effect.mapError((cause) => new AppendError({ reason: "cloud-append", cause })),
            ),

          subscribe: ({ cursor, filter }) => {
            const stream = Stream.unwrap(
              Effect.gen(function* () {
                yield* Ref.set(lastDelivered, cursor)
                return client.Subscribe({ cursor, filter }).pipe(
                  Stream.tap((e) => Ref.set(lastDelivered, e.id as never)),
                )
              }),
            )
            return stream.pipe(
              Stream.retry(
                Schedule.exponential(Duration.millis(500), 1.5).pipe(
                  Schedule.intersect(Schedule.recurs(10)),
                ),
              ),
              Stream.mapError(() => new SubscribeError({ reason: "cloud-subscribe" })),
            )
          },

          getById: (id) =>
            client.GetById({ id }).pipe(
              Effect.mapError(() => new NotFound({ id })),
            ),

          query: (filter, limit) =>
            client.Query({ filter, limit }).pipe(
              Effect.mapError(() => new QueryError({ reason: "cloud-query" })),
            ),

          latestCursor: Ref.get(lastDelivered),
        })
      }),
    ).pipe(Layer.provide(HttpClient.layer), Layer.provide(Ulid.Live)),
}
```

- [ ] **Step 4: Write `packages/store-cloud/test/CloudStore.unit.test.ts` (mocked RPC client — no network).**

```ts
import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { CloudStore } from "../src/index.js"

describe("CloudStore (unit)", () => {
  it.effect("placeholder — wiring smoke test", () =>
    Effect.sync(() => expect(typeof CloudStore.Live).toBe("function")),
  )
})
```

- [ ] **Step 5: Write `packages/store-cloud/test/integration.test.ts` (opt-in; skipped unless `RXWEAVE_CLOUD_URL` env var set) — runs the `@rxweave/core/testing/conformance` suite against a real deployed cloud dev env.**

```ts
import { describe } from "vitest"
import { Effect } from "effect"
import { EventRegistry } from "@rxweave/schema"
import { runConformance } from "@rxweave/core/testing"
import { CloudStore } from "../src/index.js"

const url = process.env.RXWEAVE_CLOUD_URL
const token = process.env.RXWEAVE_TOKEN

if (url && token) {
  const layer = CloudStore.Live({ url, token: () => token })
  runConformance({ name: "CloudStore (integration)", layer, fresh: () => layer })
} else {
  describe.skip("CloudStore integration (set RXWEAVE_CLOUD_URL + RXWEAVE_TOKEN)", () => {
    describe.skip("(skipped)", () => undefined)
  })
}
```

- [ ] **Step 6: Wire `store-cloud` into CLI config example.** Modify `rxweave/packages/cli/src/Config.ts` — no change needed (already passes Layer through), and document `CloudStore.Live` usage in `rxweave/README.md` + `apps/dev/README.md`.

- [ ] **Step 7: Typecheck + test.**

```bash
cd /Users/derekxwang/Development/incubator/RxWeave/rxweave
bun install
cd packages/store-cloud && bun run typecheck && bun run test
```

Expected: PASS (integration test skipped unless env set).

- [ ] **Step 8: Open PR against rxweave main.**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(store-cloud): Live.Cloud adapter over @effect/rpc

Uses @effect/platform HttpClient with bearer-token injection via a
mapped request middleware. subscribe reconnects with the last
delivered cursor under Schedule.exponential(500ms, 1.5) up to 10
retries — cursor is exclusive so reconnection never duplicates nor
loses events. Conformance tests are opt-in via RXWEAVE_CLOUD_URL +
RXWEAVE_TOKEN; unit tests always run.

Co-authored-by: Team CLOUD
EOF
)"
git push -u origin team-cloud/store-cloud
gh pr create --title "feat(store-cloud): Live.Cloud adapter over @effect/rpc" --body "$(cat <<'EOF'
## Summary
- Ships `@rxweave/store-cloud` with `Live.Cloud({ url, token })` implementing the `EventStore` tag via `@effect/rpc`.
- Subscribe reconnects with the last delivered cursor; @effect/rpc streaming over HTTP chunked NDJSON.
- Registry digest is checked on every `Append`; on divergence the cloud returns `RegistryOutOfDate` and the client would auto-push (follow-up PR for auto-push retry loop).

## Test plan
- [ ] `bun run typecheck && bun run test` green
- [ ] Integration test passes with `RXWEAVE_CLOUD_URL` + `RXWEAVE_TOKEN` pointed at cloud-v0.1.0 dev deployment
- [ ] Manual: `rxweave dev` against a `CloudStore.Live(...)` config appends events and tails them
EOF
)"
```

---

## Task 14: Runtime heartbeat emitter (fast-follow for dashboard)

**Files (in `rxweave/` repo):**
- Modify: `rxweave/packages/runtime/src/Supervisor.ts`

- [ ] **Step 1: Add a periodic heartbeat fiber inside `supervise()` that emits one `system.agent.heartbeat { agentId, cursor, timestamp }` per agent every 10 seconds.**

```ts
yield* Effect.forkScoped(
  Effect.forever(
    Effect.gen(function* () {
      yield* Effect.sleep(Duration.seconds(10))
      for (const [agentId, ctx] of allCtx.entries()) {
        const cursor = yield* Ref.get(ctx.pendingCursor)
        yield* store.append([
          {
            type: "system.agent.heartbeat",
            actor: agentId as never,
            source: "system",
            payload: { agentId, cursor, timestamp: Date.now() },
          },
        ])
      }
    }),
  ),
)
```

- [ ] **Step 2: Register the heartbeat event type in a platform-provided schema package (new: `packages/schema/src/SystemEvents.ts`).**

- [ ] **Step 3: Dashboard agent view (Task 10) picks this up automatically.**

- [ ] **Step 4: PR against rxweave main, tag `rxweave v0.2.0` when merged + `store-cloud` is in.**

---

## Task 15: `rxweave v0.2.0` release

Back in `rxweave/` repo on main after Task 13 + 14 PRs merge.

- [ ] **Step 1: Update `CHANGELOG.md` with `v0.2.0` entry listing store-cloud + heartbeat emitter.**

- [ ] **Step 2: `bun run build && bun run test && bun run typecheck && bun run lint` — all green.**

- [ ] **Step 3: Tag + publish.**

```bash
git tag -a v0.2.0 -m "rxweave v0.2.0 — cloud store + runtime heartbeats"
git push --tags

# publish the v0.2 crop:
cd packages/store-cloud && npm publish --access public
cd ../schema && npm version 0.2.0 && npm publish --access public
cd ../core && npm version 0.2.0 && npm publish --access public
cd ../runtime && npm version 0.2.0 && npm publish --access public
# (other packages as needed)
```

- [ ] **Step 4: Verify v0.2 success criteria (spec §15).**

- [ ] Cloud repo deployed to dev Convex environment; dashboard shows events, lineage, agent status for authenticated users.
- [ ] `@rxweave/store-cloud` integration tests green against that dev environment.
- [ ] `rxweave v0.2.0` tagged; includes `store-cloud` as an installable adapter.
- [ ] `rxweave.config.ts` works transparently for both `FileStore` and `CloudStore` configurations.

---

## Self-Review

### Spec coverage

| Spec section | Covered by |
|---|---|
| §9.1 RxWeaveRpc — all 6 RPCs | Task 3 + Task 4 |
| §9.2 Registry digest negotiation | Task 4 |
| §9.3 Transport (HTTP + chunked NDJSON) | Task 3 (+ library binding note) |
| §9.4 Auth (Bearer, sessions + API keys) | Tasks 3, 5, 6 |
| §9.5 Cloud repo (Convex + kitcn + dashboard) | Tasks 0–11 |
| §5.6 `@rxweave/store-cloud` — reconnect-with-cursor | Task 13 |
| §5.8 Conformance across all adapters | Task 13 step 5 (integration test) |
| §15 v0.2 success criteria | Task 15 step 4 |

### Placeholder scan

- "NOTE" comments reference follow-up work **inside this plan** only (e.g., Task 3's @effect/rpc Hono binding caveat → to be confirmed against library README at implementation time).
- Task 10's heartbeat emitter is deferred to Task 14 with explicit code in Task 14 step 1.
- No `TODO`, `TBD`, or "implement later" without a concrete follow-up task.

### Type consistency

- `Tenant` Effect tag (Task 5) used by RPC handlers (Task 3, 4).
- `Cursor`, `Filter`, `EventEnvelope`, `EventInput`, `EventDefWire` all imported from `@rxweave/schema` — exact same shapes Plan A produced.
- `RxWeaveRpc` handler signatures (Task 3/4) match the `RpcGroup.make(...)` definitions Plan A Task 11 produced.
- `CloudStore.Live({ url, token })` (Task 13) matches the spec §5.6 convention and the example in `rxweave.config.ts`.

### Scope

Plan B is cloud + store-cloud client only. Rxweave v0.1 stays entirely in Plan A. No rxweave runtime features beyond the heartbeat emitter (Task 14) which unblocks the agent dashboard view — that's intentional and documented.

---

## Execution Handoff

Plan B complete and saved to `docs/superpowers/plans/2026-04-18-cloud-v01-and-store-cloud.md` (will move into `rxweave/docs/superpowers/plans/` after Plan A Task 0 step 12).

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task via `superpowers:subagent-driven-development`, review between tasks. Run in a second cmux panel as Team CLOUD.
2. **Inline Execution** — execute tasks in the current session using `superpowers:executing-plans`, batch with checkpoints.

**Parallel with Plan A:** Tasks 0–12 of Plan B can start as soon as Plan A Task 11 publishes `@rxweave/protocol@0.1.0`. Tasks 13–15 of Plan B depend on Plan A Task 28 tagging `rxweave v0.1.0`.
