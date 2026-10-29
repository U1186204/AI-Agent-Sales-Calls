/**
 * Prisma client singleton (Prisma 7 + better-sqlite3 driver adapter).
 * Hot-reload safe: in development the instance is cached on globalThis so Next.js
 * fast refresh does not open a new connection per edit.
 *
 * `getPrisma()` is the accessor every module should use (domain, guard budget reader,
 * notify store). Unit tests swap the client for a per-file temporary database with
 * `setPrismaOverride()` (via the domain's `setDomainPrisma`), so no module can bypass the
 * override and touch the dev database by importing `prisma` directly.
 */
import "server-only";
import { createPrismaClient, type PrismaClient } from "./db-client";

const globalForPrisma = globalThis as unknown as {
  __oasisPrisma?: PrismaClient;
  __oasisPrismaOverride?: PrismaClient | null;
};

export const prisma: PrismaClient = globalForPrisma.__oasisPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.__oasisPrisma = prisma;

/** The active client: the test override when set, else the app singleton. */
export function getPrisma(): PrismaClient {
  return globalForPrisma.__oasisPrismaOverride ?? prisma;
}

/** Test hook: route every `getPrisma()` caller to `client` (null restores the app client). */
export function setPrismaOverride(client: PrismaClient | null): void {
  globalForPrisma.__oasisPrismaOverride = client;
}

export type { PrismaClient };
