import {
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import { BunHttpServer } from "@effect/platform-bun"
import { RpcSerialization, RpcServer } from "@effect/rpc"
import { Effect, Layer } from "effect"
import type { Scope } from "effect"
import type { EventStore } from "@rxweave/core"
import { EventRegistry } from "@rxweave/schema"
import {
  RxWeaveRpc,
  appendHandler,
  subscribeHandler,
  getByIdHandler,
  queryHandler,
  queryAfterHandler,
  registrySyncDiffHandler,
  registryPushHandler,
} from "@rxweave/protocol"
import type { EventId } from "@rxweave/schema"
import { verifyToken } from "./Auth.js"
import { Tenant } from "./Tenant.js"

/**
 * Options for `startServer`.
 *
 * `store` is required — there's no sensible default for where events
 * persist. `registry` defaults to `EventRegistry.Live` for convenience;
 * callers that need to share a registry across multiple services can
 * pass their own layer.
 *
 * `port: 0` is accepted and forwarded to Bun, which assigns an OS
 * ephemeral port — the resolved value comes back on `ServerHandle.port`.
 *
 * `auth.bearer` holds the allow-list of valid bearer tokens. When
 * `auth` is set every request must carry `Authorization: Bearer <tok>`
 * where `<tok>` matches one of the expected values; otherwise the
 * middleware short-circuits with a 401 and the RPC handler never runs.
 * Omitting `auth` entirely is the no-auth / embedded path — no
 * middleware is installed, so in-process callers never pay the cost.
 * `auth: { bearer: [] }` is also accepted and behaves as no-auth
 * (every token matches) but is considered a degenerate configuration;
 * prefer omitting `auth` when you want no auth.
 *
 * NOTE: the `--host 0.0.0.0 --no-auth` hard-error interlock from spec
 * §5.4 is enforced at the CLI layer (Task 12), not here. `startServer`
 * is a library-level primitive — we can't assume the caller's UX flow
 * or rule out legitimate no-auth listening on non-loopback interfaces
 * (e.g. a reverse proxy that does its own auth). The hardening belongs
 * to the entry point that advertises those flags.
 */
export interface ServerOpts {
  readonly store: Layer.Layer<EventStore>
  readonly registry?: Layer.Layer<EventRegistry>
  readonly port?: number
  readonly host?: string
  readonly auth?: { readonly bearer: ReadonlyArray<string> }
}

/**
 * Handle returned to the caller after the server is bound. The scope
 * that started the server controls its lifetime — closing the scope
 * shuts the listener down (see `startServer`'s return type carrying
 * `Scope.Scope` as a requirement).
 *
 * `port` reflects the actually-bound port: when `opts.port` is `0`
 * (OS-assigned ephemeral), we pull the resolved port out of Bun's
 * `HttpServer.address` tag after the layer has been built. Callers can
 * therefore rely on `handle.port` for subsequent `fetch` URLs even in
 * port-0 mode — useful for conformance harnesses (Task 11) and
 * parallel-run tests that must avoid collisions.
 */
export interface ServerHandle {
  readonly port: number
  readonly host: string
}

/**
 * Wire the shared handlers from `@rxweave/protocol` into the RpcGroup.
 *
 * Every handler is a pure Effect whose context requirement is some
 * subset of `EventStore | EventRegistry` (Subscribe has only
 * `EventStore`; the registry handlers have only `EventRegistry`; Append
 * has both). `RxWeaveRpc.toLayer({...})` aggregates those requirements
 * into a single `Layer.Layer<Rpc.ToHandler<…>, never, EventStore |
 * EventRegistry>`, which we then satisfy by merging the caller's store
 * layer with the registry layer further below.
 *
 * `RegistryPush`'s handler accepts an optional `callerActor` used for
 * observability logging on duplicate-with-differing-schema
 * (`registryPushHandler`'s source comment explains the spec). The
 * RpcGroup's wire payload is just `{ defs }` — the caller's identity
 * lives in the Tenant context. We adapt here by lifting `Tenant` into
 * the handler and forwarding `tenant.subject` as `callerActor`, keeping
 * the log line informative about which local caller was responsible.
 * For the cloud backend, this same plumbing lives in rxweaveRpc.ts and
 * closes over an explicit `tenantId` closure arg; the pattern is
 * equivalent, just wired through the Tenant tag for parity.
 */
// Adapter shims resolve two narrow type-signature mismatches between
// the shared handlers and the wire contracts. These are NOT behavioral
// changes — they're compile-time only:
//
//   - Subscribe: the wire payload makes `filter` optional via
//     `Schema.optional(Filter)` which surfaces as `filter?: Filter` in
//     the ToHandlerFn signature. The handler's own signature uses the
//     same optional shape but under `exactOptionalPropertyTypes` the
//     two aren't directly assignable (the handler treats
//     `filter === undefined` identically to `filter` absent, but TS
//     demands the presence bit align). We forward the payload as-is.
//
//   - QueryAfter: the handler's `cursor` is typed as `EventId`, but
//     the wire allows `Cursor = EventId | "earliest" | "latest"`. The
//     underlying `EventStore.queryAfter` accepts `Cursor` (both stores
//     do), so this is a narrower-than-needed annotation on the shared
//     handler. We cast through `EventId` — runtime-safe because the
//     store doesn't distinguish.
//
// Task 11's conformance harness can tighten these if the shared
// handlers' signatures shift.
const rpcImpl = RxWeaveRpc.toLayer({
  Append: appendHandler,
  Subscribe: (payload) =>
    subscribeHandler(
      payload.filter === undefined
        ? { cursor: payload.cursor }
        : { cursor: payload.cursor, filter: payload.filter },
    ),
  GetById: getByIdHandler,
  Query: queryHandler,
  QueryAfter: (payload) =>
    queryAfterHandler({
      cursor: payload.cursor as EventId,
      filter: payload.filter,
      limit: payload.limit,
    }),
  RegistrySyncDiff: registrySyncDiffHandler,
  RegistryPush: (payload) =>
    Effect.gen(function* () {
      const tenant = yield* Tenant
      return yield* registryPushHandler({
        defs: payload.defs,
        callerActor: tenant.subject,
      })
    }),
})

/**
 * Start a Bun HTTP server hosting the RxWeaveRpc handlers over NDJSON.
 *
 * Returns a `ServerHandle` inside a `Scope.Scope`-requiring effect:
 * when the enclosing scope closes, the server's fiber is interrupted
 * and the listening socket released. This is what enables
 * `it.scoped(...)` tests to spin up + tear down cleanly, and what lets
 * callers wrap `startServer` in `Effect.scoped(...)` for long-running
 * programs that need a clean shutdown signal.
 *
 * Layer composition mirrors the pattern from `@effect/rpc`'s README:
 *   - `RpcServer.layer(RxWeaveRpc)` registers the Rpc group against the
 *     `Protocol` service that `layerProtocolHttp` will provide.
 *   - `RpcServer.layerProtocolHttp({ path })` mounts the RPC protocol
 *     on the ambient `HttpRouter.Default` at `/rxweave/rpc`.
 *   - `HttpRouter.Default.serve()` hands the resolved router to the
 *     `HttpServer` service that `BunHttpServer.layer` provides.
 *   - `RpcSerialization.layerNdjson` fixes the wire format.
 *   - `rpcImpl` provides the handler implementations.
 *   - `Tenant.LocalSingleton` + `opts.store` + registry layer satisfy
 *     the handlers' context.
 */
export const startServer = (
  opts: ServerOpts,
): Effect.Effect<ServerHandle, never, Scope.Scope> =>
  Effect.gen(function* () {
    const requestedPort = opts.port ?? 5300
    const host = opts.host ?? "127.0.0.1"
    const registryLayer = opts.registry ?? EventRegistry.Live

    // Bun layer: build this slice first so we can read the
    // actually-bound port (important for `port: 0` ephemeral mode).
    // `Layer.build` acquires resources into the enclosing Scope; the
    // returned Context carries the running `HttpServer` service.
    const bunServerLive = BunHttpServer.layer({
      port: requestedPort,
      hostname: host,
    })
    const bunCtx = yield* Layer.build(bunServerLive)
    const runningServer = yield* HttpServer.HttpServer.pipe(
      Effect.provide(Layer.succeedContext(bunCtx)),
    )
    const resolvedPort =
      runningServer.address._tag === "TcpAddress"
        ? runningServer.address.port
        : requestedPort

    // Compose the RPC stack on top of the already-built Bun context.
    // `Layer.succeedContext(bunCtx)` reuses the same running instance
    // so subsequent layers don't spin up a second server.
    const rpcProtocolLive = RpcServer.layerProtocolHttp({
      path: "/rxweave/rpc",
    }).pipe(Layer.provide(RpcSerialization.layerNdjson))
    const handlersLive = rpcImpl.pipe(
      Layer.provide(opts.store),
      Layer.provide(registryLayer),
      Layer.provide(Tenant.LocalSingleton),
    )
    const rpcServerLive = RpcServer.layer(RxWeaveRpc).pipe(
      Layer.provide(handlersLive),
    )

    // Bearer-token auth. When `opts.auth` is set we wrap every
    // request in a middleware that reads the `Authorization` header
    // and consults `verifyToken`; a missing/invalid token returns 401
    // and the inner RPC app never runs. When `opts.auth` is undefined
    // we fall back to `Default.serve()` with no middleware so the
    // no-auth path is a true passthrough — zero overhead, easier to
    // reason about in the embedded case where in-process callers
    // don't need a token at all.
    //
    // `HttpMiddleware.make` is a type-preserving identity: at runtime
    // it returns its argument unchanged; at the type level it brands
    // the function with the `HttpMiddleware` interface so
    // `HttpRouter.Default.serve(middleware)` accepts it as a
    // `Middleware.HttpMiddleware.Applied<App.Default, E, R>`. Inlining
    // the lambda inside `HttpMiddleware.make(...)` is what makes the
    // generic inference land without an explicit cast.
    const expectedTokens = opts.auth?.bearer
    const ServerLive =
      expectedTokens !== undefined
        ? HttpRouter.Default.serve(
            HttpMiddleware.make((app) =>
              Effect.gen(function* () {
                const req = yield* HttpServerRequest.HttpServerRequest
                const header = req.headers["authorization"] ?? ""
                const provided = header.startsWith("Bearer ")
                  ? header.slice("Bearer ".length)
                  : ""
                if (!verifyToken({ expected: expectedTokens, provided })) {
                  return HttpServerResponse.empty({ status: 401 })
                }
                return yield* app
              }),
            ),
          ).pipe(
            Layer.provide(rpcServerLive),
            Layer.provide(rpcProtocolLive),
            Layer.provide(Layer.succeedContext(bunCtx)),
          )
        : HttpRouter.Default.serve().pipe(
            Layer.provide(rpcServerLive),
            Layer.provide(rpcProtocolLive),
            Layer.provide(Layer.succeedContext(bunCtx)),
          )

    // Build the rest of the stack. Scope-bound resources release on
    // scope close — that's the "close the Scope -> shut the server
    // down" semantic we promise in `ServerHandle`'s docstring.
    yield* Layer.build(ServerLive)

    return { port: resolvedPort, host }
  })
