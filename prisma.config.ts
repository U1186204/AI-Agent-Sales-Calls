import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

// Prisma 7 no longer loads .env automatically. Node 24 can, without dotenv.
if (existsSync(".env")) process.loadEnvFile(".env");

export const DEFAULT_DATABASE_URL = "file:./.data/oasis.db";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed/index.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  },
});
