/**
 * Prisma client factory without the `server-only` guard, so CLI scripts (seed, evals) and
 * Vitest can create a client. App code imports `prisma` from `@/db` instead.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "./generated/prisma/client";
import { getEnv } from "./config/env";

export { PrismaClient };
export { Prisma } from "./generated/prisma/client";

export function createPrismaClient(databaseUrl: string = getEnv().DATABASE_URL): PrismaClient {
  if (!databaseUrl.startsWith("file:")) {
    throw new Error(
      "Only SQLite (file:) DATABASE_URLs are wired up. For Postgres, switch the Prisma provider and use @prisma/adapter-pg here.",
    );
  }
  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  return new PrismaClient({ adapter });
}
