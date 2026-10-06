import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Setup files can run more than once; applyD1Migrations only applies
// migrations that have not been recorded yet, so this is idempotent.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
