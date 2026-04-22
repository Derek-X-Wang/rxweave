import { HttpRouter, HttpServerResponse } from "@effect/platform"
import { Effect, Layer } from "effect"
import { SESSION_TOKEN_PATH } from "@rxweave/protocol"

/**
 * Registers `GET /rxweave/session-token` on the ambient
 * `HttpRouter.Default`. Mount this in the same layer stack as
 * `RpcServer.layerProtocolHttp` so both routes land on the same
 * Bun listener.
 *
 * The endpoint returns `{ token: string | null }`:
 *   - `string` — the current bearer token, when auth is configured.
 *   - `null`   — when the server is running without auth.
 *
 * Why this exists (spec §3.3): the browser-side Phase F adapter can't
 * read `.rxweave/serve.token` from disk (sandbox), and we refuse to
 * ship the token in the Vite bundle. Exposing it over loopback to
 * same-origin clients is safe because any process with 127.0.0.1
 * access could already read the token file — the filesystem is the
 * actual trust boundary here, HTTP just mirrors it.
 *
 * Why the route is registered against `HttpRouter.Default` (not a
 * standalone `HttpRouter.empty` mounted separately): the existing
 * Server.ts composes the RPC onto `HttpRouter.Default` via
 * `RpcServer.layerProtocolHttp` and serves via
 * `HttpRouter.Default.serve(...)`. Adding our route via
 * `Default.use((r) => r.get(...))` accumulates it into that same
 * router state. Using a separate router would require rewiring the
 * serve layer to a custom tag or concat — more surface, more risk.
 *
 * Unauthenticated by design. The accompanying change in Server.ts's
 * auth middleware path-bypasses requests whose URL pathname is
 * exactly `SESSION_TOKEN_PATH` so this endpoint can serve the token
 * WITHOUT requiring the token (chicken-and-egg).
 */
export const sessionTokenRouteLayer = (
  tokens: ReadonlyArray<string>,
): Layer.Layer<never> =>
  HttpRouter.Default.use((router) =>
    router.get(
      SESSION_TOKEN_PATH,
      HttpServerResponse.json({ token: tokens[0] ?? null }),
    ),
  )
