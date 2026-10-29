/**
 * Prisma accessor for the domain layer. Delegates to `getPrisma()` in `@/db`, which is the
 * single override point shared with the guard budget reader and the notify store; unit tests
 * point all of them at a per-file temporary SQLite database with `setDomainPrisma()`.
 * Not exported from the public barrel.
 */
import { getPrisma, setPrismaOverride, type PrismaClient } from "@/db";

export function db(): PrismaClient {
  return getPrisma();
}

/** Test hook: route every domain (and guard/notify) query to `client`; null restores the app client. */
export function setDomainPrisma(client: PrismaClient | null): void {
  setPrismaOverride(client);
}

/** Transaction client type (what `$transaction(async (tx) => …)` hands you). */
export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
