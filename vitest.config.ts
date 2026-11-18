import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    // Freezes Date for the NewQuip pricing tests only (see the file header).
    setupFiles: ["./src/test/newquip-pricing-clock.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@portal": path.resolve(__dirname, "portal"),
      // `server-only` throws outside an RSC graph; stub it so server modules are unit-testable.
      "server-only": path.resolve(__dirname, "src/test/server-only-stub.ts"),
    },
  },
});
