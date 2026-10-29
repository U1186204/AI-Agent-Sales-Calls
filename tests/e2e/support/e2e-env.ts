/** Locations and server env for the e2e run (shared by playwright.config.ts and global setup). */

import { DEMO_SECRETS } from "../../../src/config/env";

export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100);
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

/** Relative to the repo root (the web server's cwd). */
export const E2E_DIR = ".data/e2e";
export const E2E_DB_FILE = `${E2E_DIR}/oasis.db`;
export const E2E_OUTBOX = `${E2E_DIR}/outbox`;

/**
 * Env for the e2e web server. Variables set here win over .env (Next.js never overrides
 * variables that are already set), so the dev DB and outbox are never used.
 */
export const E2E_SERVER_ENV: Record<string, string> = {
  DATABASE_URL: `file:./${E2E_DB_FILE}`,
  OUTBOX_DIR: E2E_OUTBOX,
  APP_URL: E2E_BASE_URL,
  // TEST ONLY: deterministic scripted assistant (src/agent/stub.ts); no API key needed.
  OASIS_LLM_STUB: "1",
  ANTHROPIC_API_KEY: "",
  // Real providers are never called from e2e.
  RESEND_API_KEY: "",
  TWILIO_ACCOUNT_SID: "",
  TWILIO_AUTH_TOKEN: "",
  TWILIO_FROM: "",
  OASIS_FAULT: "none",
  // Pin the documented demo owner login and secrets so a customised .env (own password,
  // own keys) never breaks the suite. `$` is escaped because Next.js expands it in env values.
  OWNER_USERNAME: "owner",
  OWNER_PASSWORD_HASH: DEMO_SECRETS.OWNER_PASSWORD_HASH.split("$").join("\\$"),
  SESSION_SECRET: DEMO_SECRETS.SESSION_SECRET,
  OASIS_ENCRYPTION_KEY: DEMO_SECRETS.OASIS_ENCRYPTION_KEY,
  OASIS_HMAC_KEY: DEMO_SECRETS.OASIS_HMAC_KEY,
  // Every test runs from 127.0.0.1: lift the per-IP limits (limits have their own unit tests).
  RATE_LIMIT_IP_PER_10MIN: "10000",
  RATE_LIMIT_API_PER_MIN: "100000",
  RATE_LIMIT_STATUS_PER_10MIN: "10000",
  RATE_LIMIT_CHECKOUT_PER_10MIN: "10000",
  RATE_LIMIT_DRAFT_EDIT_PER_10MIN: "10000",
  RATE_LIMIT_ESCALATION_PER_HOUR: "10000",
  RATE_LIMIT_ESCALATION_GLOBAL_PER_HOUR: "10000",
  OASIS_MAX_TURNS: "500",
  OASIS_DAILY_BUDGET_USD: "1000",
  OASIS_SESSION_BUDGET_USD: "100",
  LOG_LEVEL: "warn",
};
