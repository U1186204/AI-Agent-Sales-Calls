/**
 * Node.js-runtime start-up (imported only when NEXT_RUNTIME === "nodejs", see
 * src/instrumentation.ts): env validation with exit-on-error (SEC-1, EDGE-5), the
 * PAYMENT_PROVIDER check (exits when it names an unimplemented provider), demo-secret
 * warnings, the trusted peer-address stamp (SEC-2) and the test-stub banner.
 */
export async function registerNode(): Promise<void> {
  const { getEnv } = await import("./config/env");
  const { logger } = await import("./guard/logger");

  let env;
  try {
    env = getEnv();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("env_invalid", { message });
    console.error(`\n[oasis] ${message}\n`);
    process.exit(1);
  }

  // PAYMENT_PROVIDER must name an implemented provider (only "none" today).
  try {
    const { getPaymentProvider } = await import("./payments");
    getPaymentProvider(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("payment_provider_invalid", { message });
    console.error(`\n[oasis] ${message}\n`);
    process.exit(1);
  }

  if (env.demoSecrets.length > 0) {
    const fields = { variables: env.demoSecrets, appUrl: env.APP_URL };
    if (env.productionLike) {
      // Only reachable with OASIS_ALLOW_DEMO_SECRETS=true (parseEnv refuses otherwise).
      logger.error("demo_secrets_in_production", fields);
    } else {
      logger.warn("demo_secrets_in_use", fields);
      console.warn(
        `\n[oasis] DEMO SECRETS IN USE (${env.demoSecrets.join(", ")}). Fine for a local demo; ` +
          `replace them before deploying (see .env.example).\n`,
      );
    }
  }

  const { installPeerAddressStamp } = await import("./guard/peer-address");
  await installPeerAddressStamp();

  if (process.env.OASIS_LLM_STUB) {
    const { warnLlmStub } = await import("./agent/stub-warning");
    warnLlmStub();
  }
}
