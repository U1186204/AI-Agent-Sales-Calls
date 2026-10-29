/**
 * Per-test-file SQLite database for domain tests (works on Windows, macOS, Linux).
 *
 * 1. Creates `.data/test-<name>-<pid>-<rand>/oasis.db`.
 * 2. Applies every migration SQL file in prisma/migrations with better-sqlite3.
 * 3. Runs the real seed (`prisma/seed/index.ts` via tsx) with cwd = that folder, so its
 *    `.data/seed-meta.json` (test dates) lands inside the temp folder, not the dev one.
 * 4. Points the domain layer at a Prisma client for that file.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createPrismaClient, type PrismaClient } from "@/db-client";
import { setDomainPrisma } from "@/domain/db";
import { readSeedTestDates, type SeedTestDates } from "../../../../prisma/seed/test-dates";

const ROOT = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

export interface TestDb {
  prisma: PrismaClient;
  dates: SeedTestDates;
  file: string;
  cleanup: () => Promise<void>;
}

export async function setupTestDb(name: string): Promise<TestDb> {
  const dir = path.join(
    ROOT,
    ".data",
    `test-${name}-${process.pid}-${randomBytes(3).toString("hex")}`,
  );
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "oasis.db");

  const migrationsDir = path.join(ROOT, "prisma", "migrations");
  const sqlite = new Database(file);
  for (const m of readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()) {
    sqlite.exec(readFileSync(path.join(migrationsDir, m, "migration.sql"), "utf8"));
  }
  sqlite.close();

  const url = `file:${file.replace(/\\/g, "/")}`;
  const tsx = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const res = spawnSync(process.execPath, [tsx, path.join(ROOT, "prisma", "seed", "index.ts")], {
    cwd: dir,
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`Seed failed (exit ${res.status}): ${res.stderr || res.stdout}`);
  }

  const prisma = createPrismaClient(url);
  setDomainPrisma(prisma);
  return {
    prisma,
    dates: readSeedTestDates(dir),
    file,
    cleanup: async () => {
      setDomainPrisma(null);
      await prisma.$disconnect();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may still hold the file briefly; .data/ is gitignored.
      }
    },
  };
}

/** A valid CustomerForm payload (fictional, example.com / 555-01xx). */
export function customer(overrides: Record<string, string> = {}) {
  return {
    firstName: "Jane",
    lastName: "Smith",
    email: "Jane.Smith@Example.com",
    phone: "(512) 555-0123",
    address1: "100 Congress Ave",
    city: "Austin",
    state: "tx",
    zip: "78701",
    instructions: "Leave at the side door",
    ...overrides,
  };
}
