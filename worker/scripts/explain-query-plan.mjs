// Prints SQLite's EXPLAIN QUERY PLAN for the analyses queries after each
// migration, using a throwaway local D1 database (workerd's SQLite, through
// `wrangler d1 execute --local`). No Cloudflare login is needed.
//
//   cd worker && npm run db:explain

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ANALYSES_QUERIES } from "../src/queries.ts";

const workerDir = path.resolve(import.meta.dirname, "..");
const migrationsDir = path.resolve(workerDir, "../migrations");
const state = mkdtempSync(path.join(tmpdir(), "tradedesk-eqp-"));

function d1(args) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "tradedesk-db", "--local", "--persist-to", state, "--json", ...args],
    { cwd: workerDir, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  return JSON.parse(out);
}

function printPlans() {
  for (const [name, sql] of Object.entries(ANALYSES_QUERIES)) {
    // wrangler's --command takes no bind parameters, so use a literal ticker.
    const [{ results }] = d1(["--command", `EXPLAIN QUERY PLAN ${sql.replaceAll("?", "'NQ'")}`]);
    console.log(`${name}:`);
    for (const row of results) console.log(`  ${row.detail}`);
  }
}

try {
  console.log("Local D1 (workerd's SQLite), empty tables, no ANALYZE statistics\n");
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    d1(["--file", path.join(migrationsDir, file)]);
    console.log(`After ${file}`);
    printPlans();
    console.log();
  }
} finally {
  rmSync(state, { recursive: true, force: true });
}
