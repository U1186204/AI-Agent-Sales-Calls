/**
 * Full-stack API checks (AT-41 server side, AT-43, AT-83 CSRF). No UI, so they run once:
 * playwright.config.ts ignores this file in the phone and tablet projects.
 */
import { expect, test } from "@playwright/test";
import { CheckoutResult } from "../../src/contracts";
import {
  apiChat,
  apiConfirm,
  formBlock,
  newCustomer,
  ORIGIN,
  skuOf,
  stockOf,
} from "./support/fullstack";

test.describe("full stack: API checks", () => {
  test("cross-origin POSTs are rejected with 403", async ({ request }) => {
    for (const path of [
      "/api/checkout/confirm",
      "/api/checkout/review",
      "/api/status",
      "/api/chat",
    ]) {
      const res = await request.post(path, {
        headers: { origin: "https://evil.example" },
        data: {},
      });
      expect(res.status(), path).toBe(403);
      expect(res.headers()["x-request-id"]).toBeTruthy();
    }
  });

  test("server re-validates: bad email / phone / ZIP via the API → 422 with field errors", async ({
    request,
  }) => {
    const chat = await apiChat(request, "volt-supply", "buy 1");
    const form = formBlock(chat);
    const conversationId = chat.conversationId;
    const c = newCustomer("api422", { email: "nope", phone: "123", zip: "9021" });
    for (const path of ["/api/checkout/review", "/api/checkout/confirm"]) {
      const res = await request.post(path, {
        headers: ORIGIN,
        data: { kind: "product", draftId: form.draftId, conversationId, customer: c },
      });
      expect(res.status(), path).toBe(422);
      const body = CheckoutResult.parse(await res.json());
      expect(body.ok).toBe(false);
      if (!body.ok) {
        expect(body.code).toBe("validation");
        expect(Object.keys(body.fieldErrors ?? {}).sort()).toEqual(["email", "phone", "zip"]);
      }
    }
    // Malformed body → 400; unknown draft → 404.
    expect(
      (
        await request.post("/api/checkout/confirm", { headers: ORIGIN, data: { nope: 1 } })
      ).status(),
    ).toBe(400);
    const missing = await apiConfirm(request, {
      kind: "product",
      draftId: "missing-draft",
      conversationId,
      customer: newCustomer("api404"),
    });
    expect(missing.status).toBe(404);
  });

  test("AT-43: parallel confirms of the same draft → one reference, stock decremented once", async ({
    request,
  }) => {
    const chat = await apiChat(request, "volt-supply", "buy 1");
    const form = formBlock(chat);
    const sku = skuOf(form.summary)!;
    const before = await stockOf(request, sku);
    const body = {
      kind: "product",
      draftId: form.draftId,
      conversationId: chat.conversationId,
      customer: newCustomer("race"),
    };
    const results = await Promise.all([apiConfirm(request, body), apiConfirm(request, body)]);
    const refs = new Set(results.map((r) => (r.result.ok ? r.result.reference : r.result.code)));
    expect(refs.size).toBe(1);
    expect(results.every((r) => r.status === 200)).toBe(true);
    // Exactly one fresh confirmation; the other is an idempotent replay (no re-notification).
    expect(results.filter((r) => r.result.ok && !r.result.replayed)).toHaveLength(1);
    expect(results.filter((r) => r.raw.notifications)).toHaveLength(1);
    expect(await stockOf(request, sku)).toBe(before - 1);
  });
});
