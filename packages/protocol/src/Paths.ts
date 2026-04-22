/**
 * HTTP paths the RxWeave server exposes. Exported as constants so
 * browser-side adapters (CloudStore URL, session-token fetch) and
 * server-side mounts (RpcServer.layerProtocolHttp, sessionTokenRouteLayer)
 * share one source of truth — renaming any of these paths silently
 * routes the browser to the framework's 404 handler, which is hard to
 * debug because the RPC client has no retry signal for an unroutable URL.
 *
 * Lives in `@rxweave/protocol` (not `@rxweave/server`) because the
 * browser bundle imports from here and pulling in `@rxweave/server`
 * drags `@effect/platform-bun` + `@effect/platform-node-shared` into
 * the client bundle via transitive deps.
 */

export const RXWEAVE_RPC_PATH = "/rxweave/rpc"

export const SESSION_TOKEN_PATH = "/rxweave/session-token"
