// Types for `import { env, exports } from "cloudflare:workers"` in tests.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("../src/index");
  }
  interface Env {
    AI: Ai;
    DB: D1Database;
    TRADE_SESSION: DurableObjectNamespace;
    ALLOWED_ORIGINS: string;
    // Test-only binding defined in vitest.config.ts.
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
