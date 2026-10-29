/**
 * Validated environment. The ONLY module that reads `process.env` for app settings
 * (domain/agent/guard/notify import `env` from here).
 *
 * - Parsed lazily on first access so `next build` and unit tests never fail on import.
 * - Empty strings count as "unset" (so `ANTHROPIC_API_KEY=` in .env means "no key").
 * - Every variable has a working demo default except the optional provider keys.
 *   Demo secrets are flagged via `env.demo` so the UI/logs can warn.
 */
import { z } from "zod";

/** Demo-only values. Also shipped in .env.example. Replace all of them for production. */
export const DEMO_SECRETS = {
  OASIS_ENCRYPTION_KEY: "c02vb6ANBtVm42agXXjsinwlKpwNYCsaplT336jGgVs=",
  OASIS_HMAC_KEY: "5+JbULno+xksIUmRKaaCNiC1XoxJo9QrB++Mpt6wHC4=",
  SESSION_SECRET: "dhknrHmQZAIJNjrk4cAMsJDi1yqKFm9TqxBTq8p7Eyw=",
  /** scrypt hash of the documented demo password `oasis-demo-2026`. */
  OWNER_PASSWORD_HASH:
    "scrypt$16384$8$1$txjopdnqqlu/GfCHK/cP+Q==$A5h7cVd27GyLGZ3vNeHnpF8Kf6uwCGnJOQFV1RG5FE0=",
} as const;

/** Env variable names of every demo secret, in the order they are reported. */
export const DEMO_SECRET_VARS = [
  "OWNER_PASSWORD_HASH",
  "SESSION_SECRET",
  "OASIS_ENCRYPTION_KEY",
  "OASIS_HMAC_KEY",
] as const;
export type DemoSecretVar = (typeof DEMO_SECRET_VARS)[number];

export const DEFAULT_DATABASE_URL = "file:./.data/oasis.db";

const SCRYPT_HASH_RE = /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/;

/** Explains the usual cause of a malformed owner hash (EDGE-5: `$` expansion by .env loaders). */
export const OWNER_HASH_CORRUPTED_MESSAGE =
  "looks corrupted — its `$` signs were probably expanded by the .env loader. " +
  'In .env write every `$` as `\\$` (`npm run owner:hash -- "<password>"` prints that line); ' +
  "in a host/Docker environment variable use the raw hash and do NOT also define it in .env. " +
  "Expected format: scrypt$N$r$p$salt$hash";

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const optionalString = z.preprocess(blankToUndefined, z.string().optional());
const str = (def: string) => z.preprocess(blankToUndefined, z.string().default(def));
const int = (def: number, min: number, max: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().min(min).max(max).default(def));
const num = (def: number, min: number, max: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().min(min).max(max).default(def));
const bool = (def: boolean) =>
  z.preprocess(blankToUndefined, z.stringbool().default(def)) as unknown as z.ZodType<boolean>;

const base64Key32 = z.string().refine((v) => {
  try {
    return Buffer.from(v, "base64").length === 32;
  } catch {
    return false;
  }
}, "must be 32 random bytes, base64-encoded (e.g. `node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"`)");

export const EnvSchema = z.object({
  NODE_ENV: z.preprocess(
    blankToUndefined,
    z.enum(["development", "production", "test"]).default("development"),
  ),
  APP_URL: z.preprocess(blankToUndefined, z.url().default("http://localhost:3000")),
  LOG_LEVEL: z.preprocess(
    blankToUndefined,
    z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  ),
  TRUST_PROXY: bool(false),

  // --- LLM ---------------------------------------------------------------
  ANTHROPIC_API_KEY: optionalString,
  OASIS_MODEL: str("claude-haiku-4-5"),
  OASIS_MAX_OUTPUT_TOKENS: int(1024, 64, 8192),
  OASIS_MAX_TOOL_ROUNDS: int(6, 1, 20),
  OASIS_LLM_TIMEOUT_MS: int(30_000, 1_000, 120_000),
  OASIS_LLM_MAX_RETRIES: int(2, 0, 5),
  OASIS_FAULT: z.preprocess(
    blankToUndefined,
    z.enum(["none", "llm_timeout", "llm_error"]).default("none"),
  ),
  /**
   * TEST ONLY. `1` swaps the Anthropic client for the scripted stub in src/agent/stub.ts so
   * e2e/CI can run the full chat → checkout flow without an API key. Honored only when
   * APP_URL points at localhost (see `llmStubActive`).
   */
  OASIS_LLM_STUB: bool(false),

  // --- Guardrails (SPEC §8) ----------------------------------------------
  OASIS_SESSION_BUDGET_USD: num(0.25, 0, 100),
  OASIS_DAILY_BUDGET_USD: num(2, 0, 1000),
  OASIS_MAX_TURNS: int(40, 1, 500),
  OASIS_MAX_INPUT_CHARS: int(2000, 100, 20_000),
  RATE_LIMIT_IP_PER_10MIN: int(20, 1, 10_000),
  RATE_LIMIT_API_PER_MIN: int(60, 1, 100_000),
  /** POST /api/status per IP per 10 minutes (reference enumeration guard). */
  RATE_LIMIT_STATUS_PER_10MIN: int(10, 1, 100_000),
  /** POST /api/checkout/{review,confirm} per IP per 10 minutes. */
  RATE_LIMIT_CHECKOUT_PER_10MIN: int(30, 1, 100_000),
  /** PATCH /api/checkout/draft/:id/selection ("Service details" edits) per IP per 10 minutes. */
  RATE_LIMIT_DRAFT_EDIT_PER_10MIN: int(120, 1, 100_000),
  /** New "Talk to a person" tickets per IP per hour (R2-2: support-inbox flood guard). */
  RATE_LIMIT_ESCALATION_PER_HOUR: int(3, 1, 100_000),
  /** New "Talk to a person" tickets per business per hour, across all clients (R2-2). */
  RATE_LIMIT_ESCALATION_GLOBAL_PER_HOUR: int(30, 1, 100_000),

  // --- Data + crypto -----------------------------------------------------
  DATABASE_URL: str(DEFAULT_DATABASE_URL),
  OASIS_ENCRYPTION_KEY: z.preprocess(
    blankToUndefined,
    base64Key32.default(DEMO_SECRETS.OASIS_ENCRYPTION_KEY),
  ),
  OASIS_HMAC_KEY: z.preprocess(
    blankToUndefined,
    z.string().min(32).default(DEMO_SECRETS.OASIS_HMAC_KEY),
  ),
  SESSION_SECRET: z.preprocess(
    blankToUndefined,
    z.string().min(32).default(DEMO_SECRETS.SESSION_SECRET),
  ),

  /**
   * Escape hatch for a THROWAWAY public demo: allow a production start (non-localhost APP_URL)
   * while demo secrets are in use. An error is still logged at every start and the dashboard
   * shows the banner. Never set this for real data.
   */
  OASIS_ALLOW_DEMO_SECRETS: bool(false),

  // --- Owner auth --------------------------------------------------------
  OWNER_USERNAME: str("owner"),
  OWNER_PASSWORD_HASH: z.preprocess(
    // .env files escape `$` as `\$` (Next.js expands `$VAR`); Node's loader keeps the backslash.
    (v) => (typeof v === "string" ? blankToUndefined(v.trim().replace(/\\\$/g, "$")) : v),
    z
      .string()
      .superRefine((v, ctx) => {
        if (SCRYPT_HASH_RE.test(v)) return;
        ctx.addIssue({
          code: "custom",
          message: /^scrypt/i.test(v)
            ? OWNER_HASH_CORRUPTED_MESSAGE
            : "must be scrypt$N$r$p$salt$hash (generate it with `npm run owner:hash`)",
        });
      })
      .default(DEMO_SECRETS.OWNER_PASSWORD_HASH),
  ),

  // --- Notifications -----------------------------------------------------
  SUPPORT_EMAIL: z.preprocess(blankToUndefined, z.email().default("support@oasis.example.com")),
  EMAIL_FROM: str("Oasis Demo <onboarding@resend.dev>"),
  RESEND_API_KEY: optionalString,
  TWILIO_ACCOUNT_SID: optionalString,
  TWILIO_AUTH_TOKEN: optionalString,
  TWILIO_FROM: optionalString,
  OUTBOX_DIR: str(".data/outbox"),

  // --- Payments ------------------------------------------------------------
  /**
   * Payment provider id (src/payments). Only "none" (no online payment) is implemented; any
   * other value stops the server at start-up with a "not implemented yet" error
   * (getPaymentProvider, called from instrumentation-node).
   */
  PAYMENT_PROVIDER: z.preprocess(
    (v) => (typeof v === "string" ? blankToUndefined(v.trim().toLowerCase()) : v),
    z.string().default("none"),
  ),
});

export type Env = z.infer<typeof EnvSchema> & {
  /** Derived flags; never read secrets from here. */
  demo: {
    encryptionKey: boolean;
    hmacKey: boolean;
    sessionSecret: boolean;
    ownerPassword: boolean;
  };
  /** Names of the variables that still hold the shipped demo values (empty = none). */
  demoSecrets: DemoSecretVar[];
  /** NODE_ENV=production with a non-localhost APP_URL (a real deployment). */
  productionLike: boolean;
  llmEnabled: boolean;
  /** OASIS_LLM_STUB=1 AND a localhost APP_URL: the scripted test LLM is in use. */
  llmStubActive: boolean;
  emailProvider: "resend" | "mock";
  smsProvider: "twilio" | "mock";
};

let cached: Env | null = null;

/** True for http(s)://localhost, 127.0.0.1 or [::1] (any port). */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = result.data;
  const demo = {
    encryptionKey: e.OASIS_ENCRYPTION_KEY === DEMO_SECRETS.OASIS_ENCRYPTION_KEY,
    hmacKey: e.OASIS_HMAC_KEY === DEMO_SECRETS.OASIS_HMAC_KEY,
    sessionSecret: e.SESSION_SECRET === DEMO_SECRETS.SESSION_SECRET,
    ownerPassword: e.OWNER_PASSWORD_HASH === DEMO_SECRETS.OWNER_PASSWORD_HASH,
  };
  const demoSecrets = DEMO_SECRET_VARS.filter((name) => e[name] === DEMO_SECRETS[name]);
  const productionLike = e.NODE_ENV === "production" && !isLocalUrl(e.APP_URL);
  if (productionLike && demoSecrets.length > 0 && !e.OASIS_ALLOW_DEMO_SECRETS) {
    throw new Error(demoSecretsRefusal(demoSecrets));
  }
  return {
    ...e,
    demo,
    demoSecrets,
    productionLike,
    llmEnabled: Boolean(e.ANTHROPIC_API_KEY),
    llmStubActive: e.OASIS_LLM_STUB && isLocalUrl(e.APP_URL),
    emailProvider: e.RESEND_API_KEY ? "resend" : "mock",
    smsProvider: e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && e.TWILIO_FROM ? "twilio" : "mock",
  };
}

/** Error text when a production deployment still uses the public demo secrets (SEC-1). */
export function demoSecretsRefusal(names: readonly string[]): string {
  return (
    `Refusing to start: NODE_ENV=production with a public APP_URL, but these variables still hold ` +
    `the PUBLIC demo values from .env.example: ${names.join(", ")}. Anyone could forge owner ` +
    `sessions or decrypt customer data. Generate secrets with ` +
    `\`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"\` and the owner ` +
    `hash with \`npm run owner:hash -- "<passphrase>"\`. (Throwaway public demo only: ` +
    `OASIS_ALLOW_DEMO_SECRETS=true.)`
  );
}

/** Parsed env, computed once on first call. */
export function getEnv(): Env {
  cached ??= parseEnv();
  return cached;
}

/** Test helper: forget the cached env so the next access re-reads process.env. */
export function resetEnvCache(): void {
  cached = null;
}

/** Lazily-parsed env object: `env.OASIS_MODEL`. Parsing happens on first property access. */
export const env: Env = new Proxy({} as Env, {
  get: (_t, prop) => getEnv()[prop as keyof Env],
  has: (_t, prop) => prop in getEnv(),
  ownKeys: () => Reflect.ownKeys(getEnv()),
  getOwnPropertyDescriptor: (_t, prop) => {
    const value = getEnv()[prop as keyof Env];
    return value === undefined && !(prop in getEnv())
      ? undefined
      : { configurable: true, enumerable: true, value };
  },
});
