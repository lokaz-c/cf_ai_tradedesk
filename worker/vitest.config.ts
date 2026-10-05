import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // The D1 schema lives in ../migrations (shared with `wrangler d1 migrations`).
  // Read it in Node and hand it to the Workers runtime as a test-only binding,
  // so test/apply-migrations.ts can apply the real migrations to the local D1.
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, "../migrations"),
  );

  return {
    plugins: [
      cloudflareTest({
        // Workers AI has no local simulator. Keep every binding local so tests
        // never reach a Cloudflare account; tests mock env.AI.run instead.
        remoteBindings: false,
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      restoreMocks: true,
      // A stuck stream should fail fast rather than hang CI.
      testTimeout: 10_000,
    },
  };
});
