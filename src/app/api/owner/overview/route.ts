/** GET /api/owner/overview → OwnerOverview (owner session required; 401 otherwise). */
import type { OwnerOverview } from "@/contracts";
import { getEnv } from "@/config/env";
import { ownerOverview, ownerToday } from "@/domain";
import { ownerGet } from "../../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = ownerGet("overview", async ({ businessId }): Promise<OwnerOverview> => {
  // ISO-2: with ?businessId every count/sum is scoped (LLM usage + budget stay global).
  const [o, today] = await Promise.all([
    ownerOverview(businessId),
    ownerToday(new Date(), businessId),
  ]);
  const businesses = o.businesses;
  const env = getEnv();
  return {
    // SEC-1: the banner covers EVERY demo secret, not just the owner password.
    demoCredentials: env.demoSecrets.length > 0,
    demoSecrets: [...env.demoSecrets],
    generatedAt: o.generatedAt,
    today: {
      date: today.date,
      orders: today.orders,
      bookings: today.bookings,
      revenueCents: today.revenueCents,
      conversations: today.conversations,
      inputTokens: today.usage.inputTokens,
      outputTokens: today.usage.outputTokens,
      costUsd: today.usage.costMicros / 1_000_000,
      dailyBudgetUsd: env.OASIS_DAILY_BUDGET_USD,
    },
    totals: {
      orders: o.totals.orders,
      bookings: o.totals.bookings,
      openEscalations: o.totals.openEscalations,
      lowStock: o.businesses.reduce((s, b) => s + b.lowStock, 0),
      outOfStock: o.businesses.reduce((s, b) => s + b.outOfStock, 0),
    },
    businesses: businesses.map((b) => ({
      businessId: b.id,
      businessName: b.name,
      kind: b.kind === "service" ? "service" : "product",
      orders: b.orders,
      bookings: b.bookings,
      revenueCents: b.revenueCents,
      conversations: b.conversations,
    })),
  };
});
