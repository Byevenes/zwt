import { defineConfig } from "vitest/config"

export default defineConfig({
  // Integration tests spawn the CLI. Under Node (the mutant-cafe baseline) the full suite
  // runs slower than under Bun, and the default 5 s timeout fails one of them.
  test: { include: ["test/**/*.test.ts"], testTimeout: 20_000 }
})
