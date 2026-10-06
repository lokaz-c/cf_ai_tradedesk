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
    DAILY_CHAT_BUDGET: number;
    RATE_LIMIT_PERIOD_SECONDS: number;
    MARKET_DATA_URL: string;
    MARKET_DATA_DISPLAY_SOURCES: string;
    MARKET_DATA_TIMEOUT_MS: number;
    MAX_TOOL_ROUNDS: number;
    // Test-only binding defined in vitest.config.ts.
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
