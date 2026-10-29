/**
 * Server start hook (Next.js instrumentation). Node-only work lives in
 * ./instrumentation-node (imported conditionally so the edge compile never sees it):
 *
 * 1. Validates the environment up front. An invalid env (e.g. a `$`-expanded
 *    OWNER_PASSWORD_HASH, EDGE-5) or a production deployment that still uses the public demo
 *    secrets (SEC-1) logs a clear error naming the variables and EXITS NON-ZERO, so the server
 *    never half-starts (bound to the port but unable to serve).
 * 2. Logs a loud warning when demo secrets are used on localhost (fine for a local demo).
 * 3. Installs the trusted client-address stamp used by the rate limiters (SEC-2).
 * 4. Prints the TEST-ONLY scripted-LLM banner (OASIS_LLM_STUB=1), or an error when ignored.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}
