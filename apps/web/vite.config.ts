import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Proxies both the RPC endpoint (`/rxweave/rpc`) and the
      // session-token bootstrap (`/rxweave/session-token`) to the
      // embedded server on :5301. Matches the path layout
      // `@rxweave/server` installs on its Bun listener.
      "/rxweave": "http://localhost:5301",
    },
  },
})
