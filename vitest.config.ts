import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: "@/", replacement: path.resolve(__dirname, "apps/web/src") + "/" },
      {
        find: "@jules/shared",
        replacement: path.resolve(__dirname, "packages/shared/src/index.ts"),
      },
      {
        find: "@jules/config",
        replacement: path.resolve(__dirname, "packages/config/src/index.ts"),
      },
      {
        find: "@jules/core",
        replacement: path.resolve(__dirname, "packages/core/src/index.ts"),
      },
      {
        find: "@jules/observability",
        replacement: path.resolve(__dirname, "packages/observability/src/index.ts"),
      },
      { find: "@jules/db", replacement: path.resolve(__dirname, "packages/db/src/index.ts") },
      {
        find: "@jules/jules-client",
        replacement: path.resolve(__dirname, "packages/jules-client/src/index.ts"),
      },
      { find: "@jules/ai", replacement: path.resolve(__dirname, "packages/ai/src/index.ts") },
      {
        find: "@jules/policy",
        replacement: path.resolve(__dirname, "packages/policy/src/index.ts"),
      },
      {
        find: "@jules/test-utils",
        replacement: path.resolve(__dirname, "packages/test-utils/src/index.ts"),
      },
      {
        find: "ioredis",
        replacement: path.resolve(__dirname, "apps/worker/node_modules/ioredis"),
      },
      { find: "bullmq", replacement: path.resolve(__dirname, "apps/worker/node_modules/bullmq") },
      { find: "pg", replacement: path.resolve(__dirname, "packages/db/node_modules/pg") },
      {
        find: "drizzle-orm",
        replacement: path.resolve(__dirname, "packages/db/node_modules/drizzle-orm"),
      },
    ],
  },
  test: {
    globals: true,
    fileParallelism: false,
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/build/**",
        "**/*.d.ts",
        "**/migrations/**",
        "**/test-utils/**",
        "**/vitest.config.ts",
      ],
    },
  },
});
