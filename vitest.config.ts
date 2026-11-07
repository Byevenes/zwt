import motherload from "motherload/vite"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [motherload()],
  test: { include: ["test/**/*.test.ts"] }
})
