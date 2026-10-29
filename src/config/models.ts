/**
 * Anthropic model pricing (USD per million tokens), checked 2026-10-05
 * (docs/research/free-tiers.md §1). Used by guard/budget to convert `response.usage` into cost.
 */
export interface ModelPrice {
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
  /** Multipliers on the input price for prompt caching. */
  cacheWrite5mMultiplier: number;
  cacheReadMultiplier: number;
}

const CACHE = { cacheWrite5mMultiplier: 1.25, cacheReadMultiplier: 0.1 } as const;

export const MODEL_PRICING = {
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5, ...CACHE },
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10, ...CACHE },
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20, ...CACHE },
} as const satisfies Record<string, ModelPrice>;

export type KnownModel = keyof typeof MODEL_PRICING;

/** Unknown models are priced as the most expensive known model so budgets stay conservative. */
export const FALLBACK_MODEL_PRICE: ModelPrice = MODEL_PRICING["claude-opus-5-5"];

/** Resolve a model id (alias or dated snapshot, e.g. `claude-haiku-4-5-20251001`) to its price. */
export function priceForModel(model: string): ModelPrice {
  const id = model.trim().toLowerCase();
  for (const [key, price] of Object.entries(MODEL_PRICING)) {
    if (id === key || id.startsWith(`${key}-`)) return price;
  }
  return FALLBACK_MODEL_PRICE;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/** Cost in integer micro-dollars (USD × 1e6), rounded up so budgets never under-count. */
export function costMicros(model: string, usage: TokenUsage): number {
  const p = priceForModel(model);
  // price per MTok in USD == micro-dollars per token
  const micros =
    usage.inputTokens * p.inputPerMTok +
    usage.outputTokens * p.outputPerMTok +
    (usage.cacheCreationInputTokens ?? 0) * p.inputPerMTok * p.cacheWrite5mMultiplier +
    (usage.cacheReadInputTokens ?? 0) * p.inputPerMTok * p.cacheReadMultiplier;
  return Math.ceil(micros);
}
