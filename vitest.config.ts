import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside React Server Components; unit tests run in plain Node.
      "server-only": fileURLToPath(
        new URL("./tests/unit/support/server-only-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/generated/**", "src/app/**"],
      reportsDirectory: "coverage",
    },
  },
});
