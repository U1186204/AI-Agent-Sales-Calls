import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/config/env";
import {
  checkBudget,
  estimateCostMicros,
  evaluateBudget,
  normalizeUsage,
  usdToMicros,
  utcDayKey,
  type BudgetReader,
} from "@/guard/budget";

afterEach(() => {
  delete process.env.OASIS_SESSION_BUDGET_USD;
  delete process.env.OASIS_DAILY_BUDGET_USD;
  resetEnvCache();
});

describe("estimateCostMicros", () => {
  it("prices haiku input/output ($1 / $5 per MTok)", () => {
    expect(estimateCostMicros("claude-haiku-4-5", { input_tokens: 1000, output_tokens: 200 })).toBe(
      1000 * 1 + 200 * 5,
    );
  });
  it("includes cache write (1.25x) and cache read (0.1x) tokens", () => {
    const micros = estimateCostMicros("claude-haiku-4-5", {
      input_tokens: 100,
      output_tokens: 10,
      cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 2000,
    });
    expect(micros).toBe(100 + 50 + 1250 + 200);
  });
  it("accepts camelCase usage and dated snapshot ids", () => {
    expect(
      estimateCostMicros("claude-haiku-4-5-20251001", { inputTokens: 10, outputTokens: 10 }),
    ).toBe(60);
  });
  it("prices unknown models conservatively (top tier)", () => {
    expect(estimateCostMicros("mystery-model", { input_tokens: 1, output_tokens: 1 })).toBe(24);
  });
  it("treats null/negative usage fields as 0", () => {
    expect(normalizeUsage({ input_tokens: null, output_tokens: -5 })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });
});

describe("budget decisions", () => {
  it("usdToMicros", () => {
    expect(usdToMicros(0.25)).toBe(250_000);
    expect(usdToMicros(2)).toBe(2_000_000);
  });
  it("evaluateBudget: ok / session / daily (daily wins)", () => {
    const limits = { sessionLimitMicros: 250_000, dailyLimitMicros: 2_000_000 };
    expect(evaluateBudget({ ...limits, sessionMicros: 249_999, dailyMicros: 0 }).ok).toBe(true);
    expect(evaluateBudget({ ...limits, sessionMicros: 250_000, dailyMicros: 0 }).reason).toBe(
      "session",
    );
    expect(evaluateBudget({ ...limits, sessionMicros: 0, dailyMicros: 2_000_000 }).reason).toBe(
      "daily",
    );
    expect(
      evaluateBudget({ ...limits, sessionMicros: 300_000, dailyMicros: 3_000_000 }).reason,
    ).toBe("daily");
  });

  const reader = (session: number, day: number, seen: string[] = []): BudgetReader => ({
    conversationCostMicros: async (id) => {
      seen.push(`conv:${id}`);
      return session;
    },
    dayCostMicros: async (d) => {
      seen.push(`day:${d}`);
      return day;
    },
  });

  it("checkBudget reads conversation + today's UsageDay against env limits", async () => {
    const seen: string[] = [];
    const now = new Date("2026-10-05T23:59:00Z");
    const r = await checkBudget({ conversationId: "c1", now }, reader(100_000, 500_000, seen));
    expect(r).toMatchObject({ ok: true, sessionLimitMicros: 250_000, dailyLimitMicros: 2_000_000 });
    expect(seen).toEqual(["conv:c1", "day:2026-10-05"]);
  });

  it("checkBudget honors env overrides", async () => {
    process.env.OASIS_SESSION_BUDGET_USD = "0.01";
    resetEnvCache();
    expect(await checkBudget({ conversationId: "c1" }, reader(10_000, 0))).toMatchObject({
      ok: false,
      reason: "session",
    });
    process.env.OASIS_DAILY_BUDGET_USD = "0.5";
    resetEnvCache();
    expect(await checkBudget({}, reader(0, 500_000))).toMatchObject({ ok: false, reason: "daily" });
  });

  it("utcDayKey", () => {
    expect(utcDayKey(new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02");
  });
});
