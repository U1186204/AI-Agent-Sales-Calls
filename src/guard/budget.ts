/**
 * USD budget guardrails (SPEC §8, AT-81).
 *
 * - `estimateCostMicros(model, usage)` converts an Anthropic `usage` object (snake_case from
 *   the SDK, or camelCase `TokenUsage`) into integer micro-dollars via `config/models.ts`,
 *   including prompt-cache write/read tokens.
 * - `checkBudget({conversationId})` is READ-ONLY: it compares `Conversation.costMicros`
 *   against `OASIS_SESSION_BUDGET_USD` and today's (UTC) `UsageDay.costMicros` against
 *   `OASIS_DAILY_BUDGET_USD`. The domain records spend (addUsage); this file never writes.
 *
 * Call `checkBudget` before every LLM call; when `ok` is false, skip the call and show the
 * friendly fallback.
 */
import { getEnv } from "@/config/env";
import { costMicros, type TokenUsage } from "@/config/models";

/** Anthropic SDK `response.usage` shape (fields we read). */
export interface AnthropicUsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export type UsageInput = TokenUsage | AnthropicUsageLike;

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** Normalize either usage shape to camelCase `TokenUsage`. */
export function normalizeUsage(usage: UsageInput): Required<TokenUsage> {
  const u = usage as Record<string, unknown>;
  return {
    inputTokens: n(u.inputTokens ?? u.input_tokens),
    outputTokens: n(u.outputTokens ?? u.output_tokens),
    cacheCreationInputTokens: n(u.cacheCreationInputTokens ?? u.cache_creation_input_tokens),
    cacheReadInputTokens: n(u.cacheReadInputTokens ?? u.cache_read_input_tokens),
  };
}

/** Cost in integer micro-dollars (USD × 1e6), rounded up. Unknown models use the top price. */
export function estimateCostMicros(model: string, usage: UsageInput): number {
  return costMicros(model, normalizeUsage(usage));
}

export const usdToMicros = (usd: number): number => Math.round(usd * 1_000_000);

/** UTC day key used by `UsageDay.day`. */
export function utcDayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export type BudgetReason = "session" | "daily";

export interface BudgetCheck {
  ok: boolean;
  reason?: BudgetReason;
  sessionMicros: number;
  sessionLimitMicros: number;
  dailyMicros: number;
  dailyLimitMicros: number;
}

/** Read access needed by `checkBudget` (injectable for tests). */
export interface BudgetReader {
  conversationCostMicros(conversationId: string): Promise<number>;
  dayCostMicros(day: string): Promise<number>;
}

/** Reads through `getPrisma()` so the unit-test DB override applies here too. */
export const prismaBudgetReader: BudgetReader = {
  async conversationCostMicros(conversationId) {
    const { getPrisma } = await import("@/db");
    const row = await getPrisma().conversation.findUnique({
      where: { id: conversationId },
      select: { costMicros: true },
    });
    return row?.costMicros ?? 0;
  },
  async dayCostMicros(day) {
    const { getPrisma } = await import("@/db");
    const row = await getPrisma().usageDay.findUnique({
      where: { day },
      select: { costMicros: true },
    });
    return row?.costMicros ?? 0;
  },
};

/** Pure decision used by `checkBudget` (daily wins over session when both are exceeded). */
export function evaluateBudget(input: {
  sessionMicros: number;
  dailyMicros: number;
  sessionLimitMicros: number;
  dailyLimitMicros: number;
}): BudgetCheck {
  const base = { ...input };
  if (input.dailyMicros >= input.dailyLimitMicros) return { ok: false, reason: "daily", ...base };
  if (input.sessionMicros >= input.sessionLimitMicros)
    return { ok: false, reason: "session", ...base };
  return { ok: true, ...base };
}

export async function checkBudget(
  input: { conversationId?: string | null; now?: Date },
  reader: BudgetReader = prismaBudgetReader,
): Promise<BudgetCheck> {
  const env = getEnv();
  const [sessionMicros, dailyMicros] = await Promise.all([
    input.conversationId ? reader.conversationCostMicros(input.conversationId) : 0,
    reader.dayCostMicros(utcDayKey(input.now)),
  ]);
  return evaluateBudget({
    sessionMicros,
    dailyMicros,
    sessionLimitMicros: usdToMicros(env.OASIS_SESSION_BUDGET_USD),
    dailyLimitMicros: usdToMicros(env.OASIS_DAILY_BUDGET_USD),
  });
}
