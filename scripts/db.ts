/**
 * Cross-platform database lifecycle helper (Git Bash / cmd / macOS / Linux).
 *
 *   tsx scripts/db.ts setup   create the SQLite directory, apply migrations (`prisma migrate deploy`)
 *   tsx scripts/db.ts reset   clear the mock outbox, drop the database, then `setup`
 *
 * Seeding is a separate step (`tsx prisma/seed/index.ts`); `npm run seed` and
 * `npm run db:reset` chain both.
 *
 * For SQLite, `reset` deletes the database file (plus -journal/-wal/-shm). For any other
 * provider it falls back to `prisma migrate reset --force --skip-seed`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

if (existsSync(".env")) process.loadEnvFile(".env");

const DEFAULT_DATABASE_URL = "file:./.data/oasis.db";
const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

function sqliteFile(dbUrl: string): string | null {
  if (!dbUrl.startsWith("file:")) return null;
  const raw = dbUrl.slice("file:".length).split("?")[0] ?? "";
  return path.resolve(process.cwd(), raw);
}

function prisma(args: string[]): void {
  // Resolve the local CLI entry and run it with the current Node binary: no shell, no .cmd shims.
  const cli = path.resolve("node_modules", "prisma", "build", "index.js");
  // PRISMA_HIDE_UPDATE_MESSAGE: never nudge users to the Prisma 8 RC (SPEC §3 pins 7.x).
  const res = spawnSync(process.execPath, [cli, ...args], {
    stdio: "inherit",
    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
  });
  if (res.status !== 0) {
    console.error(`prisma ${args.join(" ")} failed (exit ${res.status ?? "signal"})`);
    process.exit(res.status ?? 1);
  }
}

function setup(): void {
  const file = sqliteFile(url);
  if (file) mkdirSync(path.dirname(file), { recursive: true });
  prisma(["migrate", "deploy"]);
}

function clearOutbox(): void {
  // Mock email/SMS files contain customer details; a reset should not leave them behind.
  const dir = path.resolve(process.cwd(), process.env.OUTBOX_DIR || ".data/outbox");
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`Cleared mock outbox ${path.relative(process.cwd(), dir)}`);
  }
}

function reset(): void {
  const file = sqliteFile(url);
  if (file) {
    // The main file goes first: if a running server holds it open, nothing else is touched.
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const f = file + suffix;
      if (existsSync(f)) {
        try {
          rmSync(f, { force: true });
        } catch {
          console.error(
            `Could not delete ${path.relative(process.cwd(), f)}: a running server holds it open.\n` +
              "Stop the dev server (Ctrl+C) and run `npm run db:reset` again.",
          );
          process.exit(1);
        }
      }
    }
    console.log(`Dropped SQLite database ${path.relative(process.cwd(), file)}`);
    clearOutbox();
    setup();
  } else {
    prisma(["migrate", "reset", "--force", "--skip-seed"]);
    clearOutbox();
  }
}

const cmd = process.argv[2];
if (cmd === "setup") setup();
else if (cmd === "reset") reset();
else {
  console.error("Usage: tsx scripts/db.ts <setup|reset>");
  process.exit(2);
}
