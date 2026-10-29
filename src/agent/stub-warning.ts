/**
 * Loud, once-per-process warnings about the TEST-ONLY scripted LLM (OASIS_LLM_STUB).
 * Called at server start (src/instrumentation.ts) and when the stub client is first created.
 */
import { getEnv } from "@/config/env";
import { logger } from "@/guard/logger";

const G = globalThis as unknown as { __oasisStubWarned?: boolean };

const BANNER = [
  "",
  "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
  "!!  OASIS_LLM_STUB=1 — TEST MODE. The AI assistant is a scripted fake.  !!",
  "!!  Never enable this in a real deployment (see .env.example).          !!",
  "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
  "",
].join("\n");

/** Logs the test-mode banner (or the "ignored" error for a non-local APP_URL) once. */
export function warnLlmStub(): void {
  if (G.__oasisStubWarned) return;
  const env = getEnv();
  if (!env.OASIS_LLM_STUB) return;
  G.__oasisStubWarned = true;
  if (env.llmStubActive) {
    console.warn(BANNER);
    logger.warn("llm_stub_enabled", { appUrl: env.APP_URL, testOnly: true });
  } else {
    logger.error("llm_stub_ignored", {
      reason: "OASIS_LLM_STUB is only honored when APP_URL is localhost",
      appUrl: env.APP_URL,
    });
  }
}
