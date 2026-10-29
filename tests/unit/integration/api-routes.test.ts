/**
 * Integration: checkout / status / owner route handlers against a temporary DB, plus the
 * TEST-ONLY scripted LLM (OASIS_LLM_STUB). Notifications use the real mock providers and the
 * real Prisma notification store — which must write to the TEST database (getPrisma override).
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as getDraft } from "@/app/api/checkout/draft/[draftId]/route";
import { GET as getSlots } from "@/app/api/checkout/draft/[draftId]/slots/route";
import { POST as review } from "@/app/api/checkout/review/route";
import { POST as confirm } from "@/app/api/checkout/confirm/route";
import { POST as status } from "@/app/api/status/route";
import { GET as ownerOverview } from "@/app/api/owner/overview/route";
import { GET as ownerOrders } from "@/app/api/owner/orders/route";
import { GET as ownerBookings } from "@/app/api/owner/bookings/route";
import { GET as ownerInventory } from "@/app/api/owner/inventory/route";
import { GET as ownerAvailability } from "@/app/api/owner/availability/route";
import { GET as ownerNotifications } from "@/app/api/owner/notifications/route";
import { GET as ownerConversations } from "@/app/api/owner/conversations/route";
import { GET as ownerEscalations } from "@/app/api/owner/escalations/route";
import { GET as ownerTranscript } from "@/app/api/owner/conversations/[id]/transcript/route";
import { createStubLlmClient } from "@/agent/stub";
import { runTurn } from "@/agent";
import { SESSION_COOKIE, signSession } from "@/auth/session-token";
import { activateSession } from "@/auth/session-store";
import { PEER_HEADER, peerHeaderValue } from "@/guard/peer-address";
import {
  CheckoutDraftView,
  CheckoutResult,
  CheckoutReview,
  DraftSlotsView,
  OWNER_ENDPOINTS,
  OwnerEscalationsResponse,
  OwnerOverview,
  OwnerTranscript,
  StatusResponse,
  TEST_STUB_MODEL,
} from "@/contracts";
import { getEnv, resetEnvCache } from "@/config/env";
import { createCheckoutDraft, createConversation, checkAvailability } from "@/domain";
import { setLogSink } from "@/guard/logger";
import { resetRateLimits } from "@/guard/rate-limit";
import { customer, setupTestDb, type TestDb } from "../domain/support/test-db";

const BASE = "http://localhost:3000";
const SKU = "EL-WIR-1222-250";
let t: TestDb;
/** The conversation that created a draft (checkout bodies must carry it, SEC-3). */
const convOf = async (draftId: string) =>
  (await t.prisma.checkoutDraft.findUnique({ where: { id: draftId } }))?.conversationId ??
  "no-such-conversation";
let outbox: string;
let logs: string[] = [];
const KEYS = ["OUTBOX_DIR", "RATE_LIMIT_STATUS_PER_10MIN", "RATE_LIMIT_CHECKOUT_PER_10MIN"];
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  t = await setupTestDb("api-routes");
}, 120_000);
afterAll(async () => {
  await t?.cleanup();
});
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  outbox = mkdtempSync(path.join(tmpdir(), "oasis-outbox-"));
  process.env.OUTBOX_DIR = outbox;
  resetEnvCache();
  resetRateLimits();
  logs = [];
  setLogSink((l) => logs.push(l));
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEnvCache();
  resetRateLimits();
  setLogSink();
  rmSync(outbox, { recursive: true, force: true });
});

function req(pathname: string, init: { body?: unknown; ip?: string; cookie?: string } = {}) {
  const headers: Record<string, string> = {
    origin: BASE,
    // the trusted socket stamp (what the server derives from the real TCP peer, SEC-2)
    [PEER_HEADER]: peerHeaderValue(init.ip ?? "203.0.113.50"),
    "x-request-id": "req-int-test-0001",
  };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`${BASE}${pathname}`, {
    method: init.body === undefined ? "GET" : "POST",
    headers,
    body:
      init.body === undefined
        ? undefined
        : typeof init.body === "string"
          ? init.body
          : JSON.stringify(init.body),
  });
}

const params = (draftId: string) => ({ params: Promise.resolve({ draftId }) });

async function productDraft(qty = 1) {
  const conv = await createConversation("volt-supply");
  const d = await createCheckoutDraft("volt-supply", conv.id, {
    kind: "product",
    lines: [{ sku: SKU, qty }],
  });
  if (!("draftId" in d)) throw new Error(JSON.stringify(d));
  return d.draftId;
}

const stock = async () =>
  (await t.prisma.product.findFirstOrThrow({ where: { businessId: "volt-supply", sku: SKU } }))
    .qtyOnHand;

const ownerCookie = () => {
  const env = getEnv();
  const { token, session } = signSession(env.OWNER_USERNAME, env.SESSION_SECRET);
  activateSession(session.sid, session.exp);
  return `${SESSION_COOKIE}=${token}`;
};

describe("checkout routes", () => {
  it("GET draft returns the CheckoutDraftView; 404 unknown", async () => {
    const draftId = await productDraft(2);
    const res = await getDraft(
      req(`/api/checkout/draft/${draftId}?conversationId=${await convOf(draftId)}`),
      params(draftId),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-int-test-0001");
    const view = CheckoutDraftView.parse(await res.json());
    expect(view).toMatchObject({ kind: "product", status: "open", businessId: "volt-supply" });
    expect(view.items?.[0]).toMatchObject({ sku: SKU, qty: 2 });

    const missing = await getDraft(
      req("/api/checkout/draft/nope?conversationId=x"),
      params("nope"),
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("draft_not_found");
  });

  it("SEC-3: a draft is bound to its conversation (GET, slots, review, confirm, replay)", async () => {
    const draftId = await productDraft(1);
    const owner = await convOf(draftId);
    const other = (await createConversation("volt-supply")).id;
    // GET without / with another conversation: same 404 as an unknown draft
    for (const q of ["", `?conversationId=${other}`]) {
      const r = await getDraft(req(`/api/checkout/draft/${draftId}${q}`), params(draftId));
      expect(r.status).toBe(404);
    }
    // the header form works for the owner
    const viaHeader = await getDraft(
      new NextRequest(`${BASE}/api/checkout/draft/${draftId}`, {
        headers: { origin: BASE, "x-conversation-id": owner },
      }),
      params(draftId),
    );
    expect(viaHeader.status).toBe(200);
    // an attacker holding only the draft id cannot review or confirm it
    const attacker = {
      kind: "product",
      draftId,
      conversationId: other,
      customer: customer({ email: "mallory@evil.example" }),
    };
    expect((await review(req("/api/checkout/review", { body: attacker }))).status).toBe(404);
    expect((await confirm(req("/api/checkout/confirm", { body: attacker }))).status).toBe(404);
    const noConv = { kind: "product", draftId, customer: customer() };
    expect((await confirm(req("/api/checkout/confirm", { body: noConv }))).status).toBe(400);
    // the real customer confirms; a replay from another conversation never sees the reference
    const mine = { kind: "product", draftId, conversationId: owner, customer: customer() };
    const ok = CheckoutResult.parse(
      await (await confirm(req("/api/checkout/confirm", { body: mine }))).json(),
    );
    expect(ok.ok).toBe(true);
    const replay = await confirm(req("/api/checkout/confirm", { body: attacker }));
    expect(replay.status).toBe(404);
    expect(JSON.stringify(await replay.json())).not.toMatch(/OAS-/);
    // the completed draft shows the FINAL total (WF-3)
    const view = CheckoutDraftView.parse(
      await (
        await getDraft(
          req(`/api/checkout/draft/${draftId}?conversationId=${owner}`),
          params(draftId),
        )
      ).json(),
    );
    expect(view.status).toBe("completed");
    if (ok.ok) expect(view.quote.totalCents).toBe(ok.totalCents);
  });

  it("SEC-5: a chunked body over 64 KB is cut off with 413", async () => {
    const big = JSON.stringify({
      kind: "product",
      draftId: "x",
      conversationId: "y",
      customer: { junk: "x".repeat(70_000) },
    });
    const res = await review(
      new NextRequest(`${BASE}/api/checkout/review`, {
        method: "POST",
        headers: { origin: BASE, "content-type": "application/json" },
        body: new Blob([big]).stream(),
        duplex: "half",
      } as never),
    );
    expect(res.status).toBe(413);
  });

  it("service draft view has availability; slots endpoint lists real starts", async () => {
    const conv = await createConversation("mountpro-tv");
    const avail = await checkAvailability("mountpro-tv", { serviceCode: "tv-mounting" });
    const slotId = avail.slots[0]!.slotId;
    const d = await createCheckoutDraft("mountpro-tv", conv.id, {
      kind: "service",
      selection: { serviceCode: "tv-mounting", tierCode: "M", slotId },
    });
    if (!("draftId" in d)) throw new Error(JSON.stringify(d));
    const view = CheckoutDraftView.parse(
      await (
        await getDraft(
          req(`/api/checkout/draft/${d.draftId}?conversationId=${conv.id}`),
          params(d.draftId),
        )
      ).json(),
    );
    expect(view.service?.slot?.slotId).toBe(slotId);
    expect(view.availability?.dates.length).toBeGreaterThan(0);
    const date = view.availability!.dates[0]!;
    const res = await getSlots(
      req(`/api/checkout/draft/${d.draftId}/slots?date=${date}&conversationId=${conv.id}`),
      params(d.draftId),
    );
    const slots = DraftSlotsView.parse(await res.json());
    expect(slots.date).toBe(date);
    expect(slots.slots.length).toBeGreaterThan(0);
    const bad = await getSlots(
      req(`/api/checkout/draft/${d.draftId}/slots?date=tomorrow&conversationId=${conv.id}`),
      params(d.draftId),
    );
    expect(bad.status).toBe(400);

    // The chosen slotId travels through ServiceCheckoutInput and is re-checked at confirm.
    const other = slots.slots[slots.slots.length - 1]!.slotId;
    const ok = await confirm(
      req("/api/checkout/confirm", {
        body: {
          kind: "service",
          draftId: d.draftId,
          conversationId: await convOf(d.draftId),
          customer: customer(),
          slotId: other,
        },
      }),
    );
    expect(ok.status).toBe(200);
    const booking = await t.prisma.booking.findFirstOrThrow({ where: { draftId: d.draftId } });
    // Booked at exactly the time picked in the form (contractor may differ to keep the time).
    expect(booking.startsAt.toISOString()).toBe(slots.slots.at(-1)!.startsAt);
  });

  it("review: 400 malformed, 422 field errors (canonical keys), 200 review", async () => {
    const draftId = await productDraft();
    expect((await review(req("/api/checkout/review", { body: "{nope" }))).status).toBe(400);
    expect((await review(req("/api/checkout/review", { body: { kind: "x" } }))).status).toBe(400);

    const bad = await review(
      req("/api/checkout/review", {
        body: {
          kind: "product",
          draftId,
          conversationId: await convOf(draftId),
          customer: customer({ email: "nope", phone: "123", zip: "9021" }),
        },
      }),
    );
    expect(bad.status).toBe(422);
    const body = CheckoutResult.parse(await bad.json());
    expect(body.ok).toBe(false);
    if (!body.ok) {
      expect(body.code).toBe("validation");
      expect(Object.keys(body.fieldErrors ?? {}).sort()).toEqual(["email", "phone", "zip"]);
    }

    const good = await review(
      req("/api/checkout/review", {
        body: {
          kind: "product",
          draftId,
          conversationId: await convOf(draftId),
          customer: customer(),
        },
      }),
    );
    expect(good.status).toBe(200);
    const rv = CheckoutReview.parse(await good.json());
    expect(rv.customer.emailMasked).not.toContain("jane.smith");
    expect(JSON.stringify(rv)).not.toContain("Congress");
  });

  it("confirm: commits, notifies 3 channels into the TEST DB + outbox; replay does not re-notify", async () => {
    const draftId = await productDraft();
    const before = await stock();
    const body = {
      kind: "product",
      draftId,
      conversationId: await convOf(draftId),
      customer: customer(),
    };
    const res = await confirm(req("/api/checkout/confirm", { body }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    const r = CheckoutResult.parse(json);
    if (!r.ok) throw new Error("expected ok");
    expect(r.replayed).toBe(false);
    expect(json.notifications).toEqual({
      customerEmail: "mocked",
      businessEmail: "mocked",
      businessSms: "mocked",
    });
    expect(await stock()).toBe(before - 1);
    const rows = await t.prisma.notification.findMany({ where: { relatedRef: r.reference } });
    expect(rows.map((n) => `${n.audience}:${n.channel}`).sort()).toEqual([
      "business:email",
      "business:sms",
      "customer:email",
    ]);
    expect(rows.every((n) => !n.toMasked.includes("jane.smith"))).toBe(true);
    expect(readdirSync(outbox)).toHaveLength(3);

    const again = await confirm(req("/api/checkout/confirm", { body }));
    const r2 = CheckoutResult.parse(await again.json());
    expect(r2).toMatchObject({ ok: true, reference: r.reference, replayed: true });
    expect(await t.prisma.notification.count({ where: { relatedRef: r.reference } })).toBe(3);
    expect(await stock()).toBe(before - 1);
    // No PII in logs.
    expect(logs.join("\n")).not.toMatch(/jane|5550123|Congress/i);
  });

  it("AT-43: parallel confirms of one draft → one reference, stock decremented once", async () => {
    const draftId = await productDraft();
    const before = await stock();
    const body = {
      kind: "product",
      draftId,
      conversationId: await convOf(draftId),
      customer: customer(),
    };
    const results = await Promise.all(
      [1, 2, 3].map(() => confirm(req("/api/checkout/confirm", { body }))),
    );
    const parsed = await Promise.all(
      results.map(async (r) => CheckoutResult.parse(await r.json())),
    );
    const refs = new Set(parsed.filter((p) => p.ok).map((p) => (p.ok ? p.reference : "")));
    expect(refs.size).toBe(1);
    expect(await stock()).toBe(before - 1);
    expect(await t.prisma.order.count({ where: { draftId } })).toBe(1);
  });

  it("confirm: 404 unknown draft, 429 over the per-IP checkout limit", async () => {
    process.env.RATE_LIMIT_CHECKOUT_PER_10MIN = "2";
    resetEnvCache();
    resetRateLimits();
    const body = {
      kind: "product",
      draftId: "missing",
      conversationId: "nope",
      customer: customer(),
    };
    const a = await confirm(req("/api/checkout/confirm", { body, ip: "198.51.100.7" }));
    expect(a.status).toBe(404);
    await confirm(req("/api/checkout/confirm", { body, ip: "198.51.100.7" }));
    const c = await confirm(req("/api/checkout/confirm", { body, ip: "198.51.100.7" }));
    expect(c.status).toBe(429);
    expect(c.headers.get("retry-after")).toBeTruthy();
    expect(CheckoutResult.parse(await c.json())).toMatchObject({ ok: false, code: "rate_limited" });
  });
});

describe("POST /api/status", () => {
  it("finds across businesses; wrong email / wrong ref → identical generic not-found", async () => {
    const draftId = await productDraft();
    const r = CheckoutResult.parse(
      await (
        await confirm(
          req("/api/checkout/confirm", {
            body: {
              kind: "product",
              draftId,
              conversationId: await convOf(draftId),
              customer: customer(),
            },
          }),
        )
      ).json(),
    );
    if (!r.ok) throw new Error("confirm failed");
    const found = StatusResponse.parse(
      await (
        await status(
          req("/api/status", { body: { reference: r.reference, email: "jane.smith@example.com" } }),
        )
      ).json(),
    );
    expect(found).toMatchObject({ found: true, reference: r.reference, status: "confirmed" });
    expect(JSON.stringify(found)).not.toMatch(/firstName|Jane/);

    const wrongEmail = await status(
      req("/api/status", { body: { reference: r.reference, email: "other@example.com" } }),
    );
    const wrongRef = await status(
      req("/api/status", {
        body: { reference: "OAS-AAAA-BBBB", email: "jane.smith@example.com" },
      }),
    );
    expect(wrongEmail.status).toBe(200);
    expect(wrongRef.status).toBe(200);
    expect(await wrongEmail.json()).toEqual(await wrongRef.json());
    expect((await status(req("/api/status", { body: { reference: "x" } }))).status).toBe(400);
  });

  it("rate limits lookups per IP (anti-enumeration)", async () => {
    process.env.RATE_LIMIT_STATUS_PER_10MIN = "3";
    resetEnvCache();
    resetRateLimits();
    const body = { reference: "OAS-AAAA-BBBB", email: "x@example.com" };
    for (let i = 0; i < 3; i++) {
      expect((await status(req("/api/status", { body, ip: "198.51.100.9" }))).status).toBe(200);
    }
    const blocked = await status(req("/api/status", { body, ip: "198.51.100.9" }));
    expect(blocked.status).toBe(429);
    expect((await status(req("/api/status", { body, ip: "198.51.100.10" }))).status).toBe(200);
  });
});

describe("owner routes", () => {
  const routes = {
    overview: ownerOverview,
    orders: ownerOrders,
    bookings: ownerBookings,
    inventory: ownerInventory,
    availability: ownerAvailability,
    notifications: ownerNotifications,
    conversations: ownerConversations,
  } as const;

  it("401 without a session", async () => {
    for (const [name, handler] of Object.entries(routes)) {
      const res = await handler(req(`/api/owner/${name}`));
      expect(res.status, name).toBe(401);
    }
  });

  it("every endpoint matches the dashboard contract; businessId filter; 400 unknown business", async () => {
    const cookie = ownerCookie();
    for (const [name, handler] of Object.entries(routes)) {
      const res = await handler(req(`/api/owner/${name}`, { cookie }));
      expect(res.status, name).toBe(200);
      const schema = OWNER_ENDPOINTS[name as keyof typeof OWNER_ENDPOINTS].schema;
      const parsed = schema.safeParse(await res.json());
      expect(parsed.success, `${name}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
    }
    const inv = OWNER_ENDPOINTS.inventory.schema.parse(
      await (
        await ownerInventory(req("/api/owner/inventory?businessId=volt-supply", { cookie }))
      ).json(),
    );
    expect(inv.items.length).toBeGreaterThan(0);
    expect(inv.items.every((i) => i.businessId === "volt-supply")).toBe(true);
    const av = OWNER_ENDPOINTS.availability.schema.parse(
      await (await ownerAvailability(req("/api/owner/availability", { cookie }))).json(),
    );
    expect(av.days).toHaveLength(14);
    expect(av.items.length).toBeGreaterThan(0);
    const bad = await ownerOrders(req("/api/owner/orders?businessId=evil", { cookie }));
    expect(bad.status).toBe(400);
  });

  it("orders show masked customer names", async () => {
    const draftId = await productDraft();
    await confirm(
      req("/api/checkout/confirm", {
        body: {
          kind: "product",
          draftId,
          conversationId: await convOf(draftId),
          customer: customer(),
        },
      }),
    );
    const orders = OWNER_ENDPOINTS.orders.schema.parse(
      await (await ownerOrders(req("/api/owner/orders", { cookie: ownerCookie() }))).json(),
    );
    expect(orders.items[0]?.customerName).toBe("J. Smith");
  });
});

describe("OASIS_LLM_STUB scripted client", () => {
  it("buy → search + start_checkout form; completed event → confirmation with reference", async () => {
    const conv = await createConversation("volt-supply");
    const client = createStubLlmClient();
    const turn = await runTurn(
      { conversationId: conv.id, userText: "I want to buy 2 please", reqId: "r1" },
      { client },
    );
    expect(turn.toolCalls.map((c) => c.name)).toEqual(["search_catalog", "start_checkout"]);
    const form = turn.response.blocks.find((b) => b.type === "form");
    expect(form).toMatchObject({ type: "form", kind: "product" });
    expect(turn.response.usage?.model).toBe(TEST_STUB_MODEL);
    if (form?.type !== "form") throw new Error("no form");

    const r = CheckoutResult.parse(
      await (
        await confirm(
          req("/api/checkout/confirm", {
            body: {
              kind: "product",
              draftId: form.draftId,
              conversationId: await convOf(form.draftId),
              customer: customer(),
            },
          }),
        )
      ).json(),
    );
    if (!r.ok) throw new Error("confirm failed");
    const ev = await runTurn(
      {
        conversationId: conv.id,
        event: { type: "checkout_completed", draftId: form.draftId, reference: r.reference },
        reqId: "r2",
      },
      { client },
    );
    expect(ev.replyText).toContain(r.reference);
  });

  it("book → list_services + check_availability + start_checkout with an open slot", async () => {
    const conv = await createConversation("mountpro-tv");
    const turn = await runTurn(
      { conversationId: conv.id, userText: "Can I book a TV mounting?", reqId: "r3" },
      { client: createStubLlmClient() },
    );
    expect(turn.toolCalls.map((c) => c.name)).toEqual([
      "list_services",
      "check_availability",
      "start_checkout",
    ]);
    expect(turn.response.blocks.some((b) => b.type === "form" && b.kind === "service")).toBe(true);
  });

  it("anything else → a grounded reply from get_policies", async () => {
    const conv = await createConversation("volt-supply");
    const turn = await runTurn(
      { conversationId: conv.id, userText: "hello there", reqId: "r4" },
      { client: createStubLlmClient() },
    );
    expect(turn.toolCalls.map((c) => c.name)).toEqual(["get_policies"]);
    expect(turn.replyText).toMatch(/Volt/);
  });

  it("is honored only with a localhost APP_URL", async () => {
    const { parseEnv } = await import("@/config/env");
    expect(parseEnv({ OASIS_LLM_STUB: "1" }).llmStubActive).toBe(true);
    expect(
      parseEnv({ OASIS_LLM_STUB: "1", APP_URL: "https://shop.example.com" }).llmStubActive,
    ).toBe(false);
    expect(parseEnv({}).llmStubActive).toBe(false);
  });
});

describe("owner escalations + transcripts (WF-2) and overview fixes", () => {
  it("escalations list and transcript need a session and return masked data", async () => {
    const conv = await createConversation("brightnest-cleaning");
    await runTurn(
      {
        conversationId: conv.id,
        event: {
          type: "request_human",
          note: "Text me at 512-555-0123",
          contactEmail: "pat@example.com",
        },
        reqId: "req-int-test-0001",
      },
      { client: null },
    );
    expect((await ownerEscalations(req("/api/owner/escalations"))).status).toBe(401);
    const list = OwnerEscalationsResponse.parse(
      await (
        await ownerEscalations(
          req("/api/owner/escalations?businessId=brightnest-cleaning", { cookie: ownerCookie() }),
        )
      ).json(),
    );
    const e = list.items.find((x) => x.conversationId === conv.id)!;
    expect(e.ticketRef).toMatch(/^ESC-/);
    expect(e.contactEmailMasked).toBe("p***@e***.com");
    expect(e.summary).not.toContain("555-0123");
    expect(e.businessName).toBe("BrightNest House Cleaning");

    const tp = (id: string) => ({ params: Promise.resolve({ id }) });
    expect(
      (await ownerTranscript(req(`/api/owner/conversations/${conv.id}/transcript`), tp(conv.id)))
        .status,
    ).toBe(401);
    expect(
      (
        await ownerTranscript(
          req("/api/owner/conversations/nope/transcript", { cookie: ownerCookie() }),
          tp("nope"),
        )
      ).status,
    ).toBe(404);
    const tr = OwnerTranscript.parse(
      await (
        await ownerTranscript(
          req(`/api/owner/conversations/${conv.id}/transcript`, { cookie: ownerCookie() }),
          tp(conv.id),
        )
      ).json(),
    );
    expect(tr.businessName).toBe("BrightNest House Cleaning");
    expect(tr.messages.at(-1)?.role).toBe("assistant");
    expect(JSON.stringify(tr)).not.toMatch(/pat@example\.com|555-0123/);
  });

  it("overview reports every demo secret and scopes totals by businessId (SEC-1, ISO-2)", async () => {
    const o = OwnerOverview.parse(
      await (
        await ownerOverview(
          req("/api/owner/overview?businessId=greenstripe-lawn", { cookie: ownerCookie() }),
        )
      ).json(),
    );
    expect(o.demoCredentials).toBe(true);
    expect(o.demoSecrets).toEqual([
      "OWNER_PASSWORD_HASH",
      "SESSION_SECRET",
      "OASIS_ENCRYPTION_KEY",
      "OASIS_HMAC_KEY",
    ]);
    expect(o.businesses.map((b) => b.businessId)).toEqual(["greenstripe-lawn"]);
    expect(o.totals.orders).toBe(0);
  });

  it("bookings carry a timezone label + local start and are in local-time order (WF-7)", async () => {
    const b = OWNER_ENDPOINTS.bookings.schema.parse(
      await (await ownerBookings(req("/api/owner/bookings", { cookie: ownerCookie() }))).json(),
    );
    expect(b.items.length).toBeGreaterThan(0);
    for (const row of b.items) {
      expect(row.localStart).toContain(row.timezoneLabel);
    }
  });
});
