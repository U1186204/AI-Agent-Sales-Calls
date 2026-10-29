/**
 * Playwright global setup: migrate + reseed the DEDICATED e2e database (.data/e2e/oasis.db)
 * and empty its mock outbox, so every `npm run test:e2e` starts from the same state.
 *
 * Never touches the dev database: DATABASE_URL is forced to the e2e file here, and the
 * web server (playwright.config.ts) is started with the same URL. The seed runs with
 * cwd = .data/e2e so its seed-meta.json lands there too, not in the dev .data/.
 *
 * Playwright starts the webServer before global setup; that is safe because the server
 * opens the database lazily (first query) and seeding wipes + reloads rows in place
 * (the file is never deleted under an open handle).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { E2E_DB_FILE, E2E_DIR, E2E_OUTBOX } from "./support/e2e-env";

const ROOT = process.cwd();

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const res = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(
      `e2e DB setup failed: node ${args.join(" ")} (exit ${res.status})\n${res.stderr || res.stdout}`,
    );
  }
}

export default async function globalSetup(): Promise<void> {
  const dir = path.join(ROOT, E2E_DIR);
  mkdirSync(dir, { recursive: true });
  rmSync(path.join(ROOT, E2E_OUTBOX), { recursive: true, force: true });

  const url = `file:${path.join(ROOT, E2E_DB_FILE).replace(/\\/g, "/")}`;
  const env = { ...process.env, DATABASE_URL: url };
  const prismaCli = path.join(ROOT, "node_modules", "prisma", "build", "index.js");
  const tsx = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

  run([prismaCli, "migrate", "deploy"], ROOT, env);
  run([tsx, path.join(ROOT, "prisma", "seed", "index.ts")], dir, env);
}
