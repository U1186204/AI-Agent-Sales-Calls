import { defineConfig, devices } from "@playwright/test";
import { E2E_BASE_URL, E2E_PORT, E2E_SERVER_ENV } from "./tests/e2e/support/e2e-env";

/**
 * E2E + screenshots (SPEC §10). The web server is a fresh production build on port 3100
 * (E2E_PORT) — never a reused dev server — with a dedicated database (.data/e2e/oasis.db,
 * reseeded by tests/e2e/global-setup.ts), a dedicated mock outbox, and the TEST-ONLY
 * scripted assistant (OASIS_LLM_STUB=1), so the full-stack specs (`fullstack-*.spec.ts`)
 * run without an API key and never touch the dev DB. The `ui-*` specs mock the API with
 * page.route and run against the same server.
 *
 * Screenshots go to .artifacts/screenshots (gitignored). Projects cover the three
 * design breakpoints: 375 (phone), 768 (tablet), 1440 (desktop). API-only full-stack
 * specs (fullstack-api.spec.ts) run once, in the desktop project.
 */
const BASE_URL = E2E_BASE_URL;
/** Specs without UI run once (desktop project only). */
const API_ONLY = /fullstack-api\.spec\.ts/;

export const SCREENSHOT_DIR = ".artifacts/screenshots";

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "phone-375",
      testIgnore: API_ONLY,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 375, height: 812 },
        isMobile: false,
        hasTouch: true,
      },
    },
    {
      name: "tablet-768",
      testIgnore: API_ONLY,
      use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 } },
    },
    {
      name: "desktop-1440",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: `npm run build && npm run start -- -p ${E2E_PORT}`,
    url: BASE_URL,
    env: E2E_SERVER_ENV,
    // Never reuse: an already-running server could be a dev server on the dev database.
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
