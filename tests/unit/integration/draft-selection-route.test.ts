/**
 * PATCH /api/checkout/draft/:id/selection (booking form "Service details") against a temp DB:
 * contract shapes, conversation binding, rate limit, size cap, CSRF via the proxy guard.
 */
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PATCH } from "@/app/api/checkout/draft/[draftId]/selection/route";
import { CheckoutResult, DraftSelectionUpdated } from "@/contracts";
import { resetEnvCache } from "@/config/env";
import { checkAvailability, createCheckoutDraft, createConversation, quoteService } from "@/domain";
import { guardApi, MAX_BODY_BYTES } from "@/guard/api";
import { setLogSink } from "@/guard/logger";
import { PEER_HEADER, peerHeaderValue } from "@/guard/peer-address";
import { resetRateLimits } from "@/guard/rate-limit";
import { setupTestDb, type TestDb } from "../domain/support/test-db";

const BASE = "http://localhost:3000";
let t: TestDb;
let logs: string[] = [];
const saved = process.env.RATE_LIMIT_DRAFT_EDIT_PER_10MIN;

beforeAll(async () => {
  t = await setupTestDb("draft-selection-route");
}, 120_000);
afterAll(async () => {
  await t?.cleanup();
});
beforeEach(() => {
  resetEnvCache();
  resetRateLimits();
  logs = [];
  setLogSink((l) => logs.push(l));
});
afterEach(() => {
  if (saved === undefined) delete process.env.RATE_LIMIT_DRAFT_EDIT_PER_10MIN;
  else process.env.RATE_LIMIT_DRAFT_EDIT_PER_10MIN = saved;
  resetEnvCache();
  resetRateLimits();
  setLogSink();
});

function patch(draftId: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`${BASE}/api/checkout/draft/${draftId}/selection`, {
    method: "PATCH",
    headers: {
      origin: BASE,
      "content-type": "application/json",
      [PEER_HEADER]: peerHeaderValue("203.0.113.77"),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const params = (draftId: string) => ({ params: Promise.resolve({ draftId }) });

async function draft() {
  const conv = await createConversation("mountpro-tv");
  const slot = (
    await checkAvailability("mountpro-tv", { serviceCode: "tv-mounting", durationMin: 45 })
  ).slots[0]!;
  const d = await createCheckoutDraft("mountpro-tv", conv.id, {
    kind: "service",
    selection: { serviceCode: "tv-mounting", tierCode: "S", slotId: slot.slotId },
  });
  if (!("draftId" in d)) throw new Error(JSON.stringify(d));
  return { conversationId: conv.id, draftId: d.draftId };
}

describe("PATCH /api/checkout/draft/:id/selection", () => {
  it("200: returns the re-priced draft view with options; prices come only from the server", async () => {
    const { conversationId, draftId } = await draft();
    const config = {
      serviceCode: "tv-mounting",
      tierCode: "M",
      addOns: [{ code: "on-wall-raceway", qty: 1 }],
      // ignored: the server never reads client prices
      priceCents: 1,
    };
    const res = await PATCH(patch(draftId, { conversationId, config }), params(draftId));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = DraftSelectionUpdated.parse(await res.json());
    const expected = await quoteService("mountpro-tv", config);
    if (!("quote" in expected)) throw new Error("quote");
    expect(body.draft.quote.totalCents).toBe(expected.quote.totalCents);
    expect(body.draft.service?.config.tierCode).toBe("M");
    expect(body.draft.service?.options.addOnGroups.length).toBeGreaterThan(0);
    expect(body.draft.availability?.dates.length).toBeGreaterThan(0);
    expect(body.slotCleared).toBe(false);
    expect(logs.join("\n")).toMatch(/draft_edited/);
  });

  it("422 validation with field errors, 404 for another conversation, 400 malformed", async () => {
    const { conversationId, draftId } = await draft();
    const conflict = await PATCH(
      patch(draftId, {
        conversationId,
        config: {
          serviceCode: "tv-mounting",
          tierCode: "S",
          addOns: [
            { code: "in-wall-concealment", qty: 1 },
            { code: "on-wall-raceway", qty: 1 },
          ],
        },
      }),
      params(draftId),
    );
    expect(conflict.status).toBe(422);
    const f = CheckoutResult.parse(await conflict.json());
    expect(f).toMatchObject({ ok: false, code: "validation" });
    if (!f.ok) expect(Object.keys(f.fieldErrors ?? {}).length).toBeGreaterThan(0);

    const other = (await createConversation("mountpro-tv")).id;
    const stolen = await PATCH(
      patch(draftId, {
        conversationId: other,
        config: { serviceCode: "tv-mounting", tierCode: "S" },
      }),
      params(draftId),
    );
    expect(stolen.status).toBe(404);
    expect(CheckoutResult.parse(await stolen.json())).toMatchObject({ code: "draft_not_found" });

    for (const bad of ["{not json", { conversationId }, { config: { serviceCode: "x" } }]) {
      const r = await PATCH(patch(draftId, bad), params(draftId));
      expect(r.status).toBe(400);
      expect(CheckoutResult.parse(await r.json())).toMatchObject({ ok: false, code: "validation" });
    }
  });

  it("429 over the per-IP edit limit, with Retry-After", async () => {
    process.env.RATE_LIMIT_DRAFT_EDIT_PER_10MIN = "2";
    resetEnvCache();
    resetRateLimits();
    const { conversationId, draftId } = await draft();
    const body = { conversationId, config: { serviceCode: "tv-mounting", tierCode: "S" } };
    for (let i = 0; i < 2; i++) {
      expect((await PATCH(patch(draftId, body), params(draftId))).status).toBe(200);
    }
    const limited = await PATCH(patch(draftId, body), params(draftId));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(CheckoutResult.parse(await limited.json())).toMatchObject({ code: "rate_limited" });
  });

  it("413 for an over-size body", async () => {
    const { conversationId, draftId } = await draft();
    const huge = JSON.stringify({ conversationId, pad: "x".repeat(MAX_BODY_BYTES + 10) });
    const r = await PATCH(patch(draftId, huge), params(draftId));
    expect(r.status).toBe(413);
  });

  it("CSRF: the proxy guard blocks a cross-site PATCH before the handler", () => {
    const cross = patch("d1", {}, { origin: "https://evil.example" });
    const blocked = guardApi(cross, "req-1");
    expect(blocked?.status).toBe(403);
    const missing = new NextRequest(`${BASE}/api/checkout/draft/d1/selection`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(guardApi(missing, "req-2")?.status).toBe(403);
    expect(guardApi(patch("d1", {}), "req-3")).toBeNull();
  });
});
