export { Tenant, type TenantShape } from "./Tenant.js"
export { startServer, type ServerHandle, type ServerOpts } from "./Server.js"
export { generateAndPersistToken, generateToken, verifyToken } from "./Auth.js"
export { sessionTokenRouteLayer } from "./SessionToken.js"
// Re-export wire path constants from @rxweave/protocol so the server
// package exposes a single barrel for embedders. Protocol is the
// source of truth (browser-safe; no platform-bun/node-shared pull).
export { RXWEAVE_RPC_PATH, SESSION_TOKEN_PATH } from "@rxweave/protocol"
