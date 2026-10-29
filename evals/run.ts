/**
 * `npm run eval` — real-LLM evals (SPEC §10).
 *
 * 1. Loads .env; exits 2 (without touching anything) if ANTHROPIC_API_KEY is missing.
 * 2. Rebuilds a dedicated eval DB at .data/eval/oasis.db (migrations + seed; the dev DB and
 *    its seed-meta are never touched) and points DATABASE_URL / OUTBOX_DIR at it.
 * 3. Imports the app modules (only now, so they pick up the eval env) and runs evals/main.ts.
 *
 * Options: `npm run eval -- <id-substring>` runs matching cases only (report not written);
 * EVAL_CONCURRENCY (default 3).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, ".data", "eval");
const DB_FILE = path.join(DATA_DIR, "oasis.db");

if (existsSync(path.join(ROOT, ".env"))) process.loadEnvFile(path.join(ROOT, ".env"));

if (!process.env.ANTHROPIC_API_KEY?.trim()) {
  console.error(
    "ANTHROPIC_API_KEY is not set. The eval suite calls the real model.\n" +
      "Add ANTHROPIC_API_KEY=... to .env (or export it) and run `npm run eval` again.\n" +
      "docs/evals.md was not written.",
  );
  process.exit(2);
}

// Eval-only environment (set before any app module reads env).
const dbUrl = `file:${DB_FILE.replace(/\\/g, "/")}`;
process.env.DATABASE_URL = dbUrl;
process.env.OUTBOX_DIR = path.join(DATA_DIR, "outbox");
process.env.OASIS_FAULT = "none"; // fault cases inject faults per turn
process.env.OASIS_DAILY_BUDGET_USD = process.env.EVAL_DAILY_BUDGET_USD ?? "25";
process.env.RESEND_API_KEY = ""; // never send real email/SMS from evals
process.env.TWILIO_ACCOUNT_SID = "";

// App modules import "server-only" (throws outside React Server Components): stub it here.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: "data:text/javascript,export {};", shortCircuit: true, format: "module" };
    }
    return nextResolve(specifier, context);
  },
});

function resetEvalDb(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const f = DB_FILE + suffix;
    if (existsSync(f)) rmSync(f, { force: true });
  }
  rmSync(path.join(DATA_DIR, "outbox"), { recursive: true, force: true });
  const migrations = path.join(ROOT, "prisma", "migrations");
  const sqlite = new Database(DB_FILE);
  for (const m of readdirSync(migrations, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()) {
    sqlite.exec(readFileSync(path.join(migrations, m, "migration.sql"), "utf8"));
  }
  sqlite.close();
  // Seed with cwd = the eval dir so .data/seed-meta.json (test dates) lands there.
  const tsx = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const res = spawnSync(process.execPath, [tsx, path.join(ROOT, "prisma", "seed", "index.ts")], {
    cwd: DATA_DIR,
    env: { ...process.env, DATABASE_URL: dbUrl },
    encoding: "utf8",
  });
  if (res.status !== 0) {
    console.error(`Eval DB seed failed:\n${res.stderr || res.stdout}`);
    process.exit(1);
  }
  console.log(`Eval DB ready: ${path.relative(ROOT, DB_FILE)}`);
}

resetEvalDb();
const { main } = await import("./main");
const code = await main({
  dataDir: DATA_DIR,
  root: ROOT,
  concurrency: Number(process.env.EVAL_CONCURRENCY ?? 3) || 3,
  filter: process.argv[2],
});
process.exit(code);
