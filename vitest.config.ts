import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: false,
    passWithNoTests: false,
    include: ["test/**/*.test.ts"],
    reporters: ["default"],
  },
})
