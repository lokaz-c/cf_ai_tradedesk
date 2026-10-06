// Types for `import { env, exports } from "cloudflare:workers"` in tests.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("../src/index");
  }
  interface Env {
    AI: Ai;
    DB: D1Database;
    TRADE_SESSION: DurableObjectNamespace;
    CHAT_RATE_LIMITER: RateLimit;
    ALLOWED_ORIGINS: string;
    MAX_MESSAGE_CHARS: number;
    MAX_HISTORY_CHARS: number;
    MAX_OUTPUT_TOKENS: number;
    RATE_LIMIT_PERIOD_SECONDS: number;
    // Test-only binding defined in vitest.config.ts.
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
