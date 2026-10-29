/** Checkout drafts, review, confirm, status lookup, encryption at rest, isolation. */
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hmacLookup, isEncrypted } from "@/guard/crypto";
import {
  checkAvailability,
  confirmCheckout,
  createCheckoutDraft,
  createConversation,
  DomainError,
  getCheckoutDraft,
  listDraftSlots,
  listOrders,
  lookupStatus,
  reviewCheckout,
  type ConfirmResult,
} from "@/domain";
import { customer, setupTestDb, type TestDb } from "./support/test-db";

let t: TestDb;
/** The conversation that created a draft (checkout bodies must carry it, SEC-3). */
const convOf = async (draftId: string) =>
  (await t.prisma.checkoutDraft.findUnique({ where: { id: draftId } }))?.conversationId ??
  "no-such-conversation";
beforeAll(async () => {
  t = await setupTestDb("checkout");
}, 120_000);
afterAll(async () => {
  await t?.cleanup();
});

async function productDraft(businessId: string, lines: { sku: string; qty: number }[]) {
  const conv = await createConversation(businessId);
  const d = await createCheckoutDraft(businessId, conv.id, { kind: "product", lines });
  if (!("draftId" in d)) throw new Error(`draft failed: ${JSON.stringify(d)}`);
  return { conv, draftId: d.draftId, draft: d };
}

const qty = async (businessId: string, sku: string) =>
  (await t.prisma.product.findFirstOrThrow({ where: { businessId, sku } })).qtyOnHand;

function okResult(r: ConfirmResult) {
  if (!r.ok) throw new Error(`confirm failed: ${r.code} ${r.message}`);
  return r;
}

describe("createCheckoutDraft", () => {
  it("rejects unknown SKUs, other businesses' SKUs, out-of-stock and qty > stock", async () => {
    const conv = await createConversation("volt-supply");
    const mk = (sku: string, n: number) =>
      createCheckoutDraft("volt-supply", conv.id, { kind: "product", lines: [{ sku, qty: n }] });
    expect(await mk("EL-NOPE", 1)).toMatchObject({ error: "unknown_sku" });
    expect(await mk("PL-WAX-RING", 1)).toMatchObject({ error: "unknown_sku" }); // AT-95
    expect(await mk("EL-BRK-2P30", 1)).toMatchObject({ error: "out_of_stock" });
    expect(await mk("EL-WIR-1232-250", 3)).toMatchObject({ error: "insufficient_stock" });
    const svc = await createCheckoutDraft("volt-supply", conv.id, {
      kind: "service",
      selection: { serviceCode: "tv-mounting", tierCode: "M" },
    });
    expect(svc).toMatchObject({ error: "invalid_selection" });
  });

  it("refuses a conversation from another business (AT-95)", async () => {
    const plumbing = await createConversation("flowline-plumbing");
    await expect(
      createCheckoutDraft("volt-supply", plumbing.id, {
        kind: "product",
        lines: [{ sku: "EL-WIR-1222-250", qty: 1 }],
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("stores a 30-minute draft and exposes a PII-free view by id", async () => {
    const before = Date.now();
    const { draftId, draft } = await productDraft("volt-supply", [
      { sku: "el-wir-1222-250", qty: 1 },
      { sku: "EL-WIR-1222-250", qty: 1 },
    ]);
    expect(draft.quote.lines.filter((l) => l.kind === "goods")).toHaveLength(1);
    expect(draft.quote.subtotalCents).toBe(35800);
    const ttl = new Date(draft.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThan(29 * 60_000);
    expect(ttl).toBeLessThanOrEqual(31 * 60_000);
    const view = await getCheckoutDraft(draftId);
    expect(view).toMatchObject({
      draftId,
      kind: "product",
      status: "open",
      businessId: "volt-supply",
    });
    // server-side only (the API view omits it): the draft is bound to its conversation
    expect(view?.conversationId).toBe(await convOf(draftId));
    expect(view?.items?.[0]).toMatchObject({ sku: "EL-WIR-1222-250", qty: 2 });
    expect(await getCheckoutDraft("nope")).toBeNull();
  });
});

describe("reviewCheckout (AT-41)", () => {
  it("rejects bad email / phone / ZIP server-side with field errors, never throws", async () => {
    const { draftId } = await productDraft("volt-supply", [{ sku: "EL-WIR-1422-250", qty: 1 }]);
    const bad = await reviewCheckout({
      kind: "product",
      draftId,
      conversationId: await convOf(draftId),
      customer: customer({ email: "not-an-email", phone: "(012) 555-0123", zip: "1234" }),
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.code).toBe("validation");
    expect(Object.keys(bad.fieldErrors ?? {})).toEqual(
      expect.arrayContaining(["email", "phone", "zip"]),
    );

    for (const c of [
      customer({ phone: "555-0123" }),
      customer({ state: "XX" }),
      customer({ zip: "ABCDE" }),
      customer({ zip: "00000" }), // impossible ZIPs stay a hard error
    ]) {
      const r = await reviewCheckout({
        kind: "product",
        draftId,
        conversationId: await convOf(draftId),
        customer: c,
      });
      expect(r).toMatchObject({ ok: false, code: "validation" });
    }
    // garbage body
    const g = await reviewCheckout({ nope: true } as never);
    expect(g).toMatchObject({ ok: false, code: "validation" });
    expect(
      await reviewCheckout({
        kind: "product",
        draftId: "missing",
        conversationId: "x",
        customer: customer(),
      }),
    ).toMatchObject({
      ok: false,
      code: "draft_not_found",
    });
  });

  it("returns a fresh quote with shipping to the entered ZIP and a masked customer", async () => {
    const { draftId } = await productDraft("volt-supply", [{ sku: "EL-WIR-1422-250", qty: 1 }]);
    const r = await reviewCheckout({
      kind: "product",
      draftId,
      conversationId: await convOf(draftId),
      customer: customer({ zip: "99501", city: "Anchorage", state: "AK" }),
    });
    if (!r.ok) throw new Error(r.message);
    expect(r.review.quote.shipZone).toBe(8);
    expect(r.review.quote.shippingCents).toBe(1275 + 155 * 13); // 12.5 lb → 13
    expect(r.review.customer).toEqual({
      name: "J. Smith",
      emailMasked: "j***@example.com",
      phoneMasked: "(***) ***-0123",
      addressSummary: "Anchorage, AK 99501",
    });
    expect(JSON.stringify(r.review)).not.toMatch(/jane\.smith|5125550123|Congress/i);
  });
});

describe("ZIP ↔ state is a soft review warning, never a block (R2-1)", () => {
  // Real ZIPs whose area crosses a state line (Census multi-state ZCTAs from the verify report).
  it.each([
    ["99362", "OR", "Milton-Freewater", "Washington"],
    ["83120", "ID", "Freedom", "Wyoming"],
    ["97635", "CA", "New Pine Creek", "Oregon"],
  ])("%s with %s passes review (with a warning) and confirms", async (zip, state, city, usual) => {
    const { draftId } = await productDraft("volt-supply", [{ sku: "EL-WIR-1422-250", qty: 1 }]);
    const body = {
      kind: "product" as const,
      draftId,
      conversationId: await convOf(draftId),
      customer: customer({ zip, state, city }),
    };
    const r = await reviewCheckout(body);
    if (!r.ok) throw new Error(`review failed: ${r.code} ${JSON.stringify(r.fieldErrors)}`);
    expect(r.review.warnings).toContain(
      `ZIP ${zip} is usually in ${usual} — double-check your state.`,
    );
    expect(r.review.customer.addressSummary).toBe(`${city}, ${state} ${zip}`);
    const c = okResult(await confirmCheckout(body));
    expect(c.reference).toMatch(/^OAS-/);
    const order = await t.prisma.order.findUniqueOrThrow({ where: { reference: c.reference } });
    expect(order.totalCents).toBe(r.review.quote.totalCents);
  });

  it("a plain mismatch produces the warning; a matching state produces none", async () => {
    const { draftId } = await productDraft("volt-supply", [{ sku: "EL-WIR-1422-250", qty: 1 }]);
    const conversationId = await convOf(draftId);
    const mismatch = await reviewCheckout({
      kind: "product",
      draftId,
      conversationId,
      customer: customer({ zip: "90210", state: "TX" }),
    });
    if (!mismatch.ok) throw new Error(mismatch.message);
    expect(mismatch.review.warnings).toEqual([
      "ZIP 90210 is usually in California — double-check your state.",
    ]);
    const match = await reviewCheckout({
      kind: "product",
      draftId,
      conversationId,
      customer: customer(),
    });
    if (!match.ok) throw new Error(match.message);
    expect(match.review.warnings).toEqual([]);
  });
});

describe("confirmCheckout — orders (AT-43, AT-44, AT-84)", () => {
  let reference = "";

  it("creates the order, decrements stock, records Payment{none,not_required}", async () => {
    const before = await qty("volt-supply", "EL-WIR-1222-250");
    const { draftId, conv } = await productDraft("volt-supply", [
      { sku: "EL-WIR-1222-250", qty: 2 },
    ]);
    const r = okResult(
      await confirmCheckout({
        kind: "product",
        draftId,
        conversationId: await convOf(draftId),
        customer: customer(),
      }),
    );
    reference = r.reference;
    expect(r.reference).toMatch(/^OAS-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    expect(r.replayed).toBe(false);
    expect(await qty("volt-supply", "EL-WIR-1222-250")).toBe(before - 2);

    const order = await t.prisma.order.findUniqueOrThrow({
      where: { reference },
      include: { payment: true },
    });
    expect(order.payment).toMatchObject({
      provider: "none",
      status: "not_required",
      amountCents: order.totalCents,
    });
    expect(order.totalCents).toBe(r.totalCents);
    expect(order.shipZone).toBe(5);
    expect(order.subtotalCents).toBe(35800);
    expect(order.shippingCents).toBe(0); // free over $249, no heavy units
    expect(order.taxCents).toBe(2685);
    const draft = await t.prisma.checkoutDraft.findUniqueOrThrow({ where: { id: draftId } });
    expect(draft).toMatchObject({ status: "completed", resultRef: reference });
    expect(
      (await t.prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } })).outcome,
    ).toBe("order");

    // notification payload: the only decrypted PII leaving the domain
    expect(r.notification).toMatchObject({
      reference,
      kind: "product",
      customer: { firstName: "Jane", email: "jane.smith@example.com", phoneE164: "+15125550123" },
      business: { notifyEmail: "orders@volt-supply.example.com", notifyPhone: "+13175550101" },
      totals: { totalCents: order.totalCents, shippingCents: 0 },
    });
    expect(r.notification?.summaryLines.length).toBeGreaterThan(0);
  });

  it("is idempotent: a second confirm of the same draft replays the same reference", async () => {
    const before = await qty("volt-supply", "EL-WIR-1222-250");
    const draft = await t.prisma.checkoutDraft.findFirstOrThrow({
      where: { resultRef: reference },
    });
    const again = okResult(
      await confirmCheckout({
        kind: "product",
        draftId: draft.id,
        conversationId: await convOf(draft.id),
        customer: customer(),
      }),
    );
    expect(again).toMatchObject({ reference, replayed: true });
    expect(again.notification).toBeUndefined();
    expect(await qty("volt-supply", "EL-WIR-1222-250")).toBe(before);
    expect(
      await reviewCheckout({
        kind: "product",
        draftId: draft.id,
        conversationId: await convOf(draft.id),
        customer: customer(),
      }),
    ).toMatchObject({
      ok: false,
      code: "already_completed",
      reference,
    });
  });

  it("two simultaneous confirms of the same draft create exactly one order", async () => {
    const { draftId } = await productDraft("volt-supply", [{ sku: "EL-WIR-1422-250", qty: 1 }]);
    const before = await qty("volt-supply", "EL-WIR-1422-250");
    const [a, b] = await Promise.all([
      confirmCheckout({
        kind: "product",
        draftId,
        conversationId: await convOf(draftId),
        customer: customer(),
      }),
      confirmCheckout({
        kind: "product",
        draftId,
        conversationId: await convOf(draftId),
        customer: customer(),
      }),
    ]);
    const ra = okResult(a);
    const rb = okResult(b);
    expect(ra.reference).toBe(rb.reference);
    expect([ra.replayed, rb.replayed].sort()).toEqual([false, true]);
    expect(await qty("volt-supply", "EL-WIR-1422-250")).toBe(before - 1);
    expect(await t.prisma.order.count({ where: { draftId } })).toBe(1);
  });

  it("two drafts racing for the last units: only one wins, stock never negative", async () => {
    // EL-PNL-200A-40 is seeded with 3 units; each draft wants 2.
    expect(await qty("volt-supply", "EL-PNL-200A-40")).toBe(3);
    const d1 = await productDraft("volt-supply", [{ sku: "EL-PNL-200A-40", qty: 2 }]);
    const d2 = await productDraft("volt-supply", [{ sku: "EL-PNL-200A-40", qty: 2 }]);
    const results = await Promise.all([
      confirmCheckout({
        kind: "product",
        draftId: d1.draftId,
        conversationId: await convOf(d1.draftId),
        customer: customer(),
      }),
      confirmCheckout({
        kind: "product",
        draftId: d2.draftId,
        conversationId: await convOf(d2.draftId),
        customer: customer({ email: "sam@example.com" }),
      }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok);
    expect(loser).toMatchObject({ ok: false, code: "out_of_stock" });
    expect(await qty("volt-supply", "EL-PNL-200A-40")).toBe(1);
    const losingDraft = results[0]!.ok ? d2.draftId : d1.draftId;
    expect(
      (await t.prisma.checkoutDraft.findUniqueOrThrow({ where: { id: losingDraft } })).status,
    ).toBe("open");
    expect(await t.prisma.order.count({ where: { draftId: losingDraft } })).toBe(0);
  });

  it("expired drafts cannot be confirmed", async () => {
    const { draftId } = await productDraft("volt-supply", [{ sku: "EL-WIR-1422-250", qty: 1 }]);
    const later = new Date(Date.now() + 31 * 60_000);
    expect(
      await confirmCheckout(
        { kind: "product", draftId, conversationId: await convOf(draftId), customer: customer() },
        later,
      ),
    ).toMatchObject({
      ok: false,
      code: "draft_expired",
    });
    expect((await getCheckoutDraft(draftId, later))?.status).toBe("expired");
  });

  it("stores PII encrypted, never plaintext (AT-84)", async () => {
    const raw = new Database(t.file, { readonly: true });
    try {
      const customers = raw.prepare('SELECT * FROM "Customer"').all() as Record<string, string>[];
      expect(customers.length).toBeGreaterThan(0);
      const dump = JSON.stringify(customers);
      for (const needle of [
        "Jane",
        "Smith",
        "jane.smith",
        "example.com",
        "5125550123",
        "Congress",
        "Austin",
      ]) {
        expect(dump).not.toContain(needle);
      }
      for (const c of customers) {
        for (const col of ["firstNameEnc", "lastNameEnc", "emailEnc", "phoneEnc", "addressEnc"]) {
          expect(isEncrypted(c[col]!)).toBe(true);
        }
        expect(c.emailHash).toMatch(/^[0-9a-f]{64}$/);
      }
      const orders = raw
        .prepare('SELECT "instructionsEnc" FROM "Order" WHERE "instructionsEnc" IS NOT NULL')
        .all() as {
        instructionsEnc: string;
      }[];
      expect(orders.length).toBeGreaterThan(0);
      expect(
        orders.every(
          (o) => isEncrypted(o.instructionsEnc) && !o.instructionsEnc.includes("side door"),
        ),
      ).toBe(true);
      // Same email + business → one customer row (upsert by emailHash)
      const n = raw
        .prepare('SELECT COUNT(*) AS n FROM "Customer" WHERE "businessId" = ? AND "emailHash" = ?')
        .get("volt-supply", hmacLookup("jane.smith@example.com")) as { n: number };
      expect(n.n).toBe(1);
    } finally {
      raw.close();
    }
  });
});

describe("confirmCheckout — bookings (AT-43 slots)", () => {
  it("lists real starts for the draft's duration and books a multi-slot job", async () => {
    const conv = await createConversation("mountpro-tv");
    const d = await createCheckoutDraft("mountpro-tv", conv.id, {
      kind: "service",
      selection: {
        serviceCode: "tv-mounting",
        tierCode: "L",
        surcharges: [{ code: "above-fireplace" }],
      },
    });
    if (!("draftId" in d)) throw new Error(JSON.stringify(d));
    expect(d.quote.durationMin).toBe(90);

    const slots = await listDraftSlots(d.draftId, undefined, new Date(), conv.id);
    if (!slots.ok) throw new Error(slots.message);
    expect(slots.durationMin).toBe(90);
    const fixtures = t.dates.services["mountpro-tv"];
    expect(slots.availableDates).not.toContain(fixtures.fullyBooked[0]);
    expect(slots.availableDates).not.toContain(fixtures.lastSlotOnly); // only 1 slot open there
    const onLast = await listDraftSlots(d.draftId, fixtures.lastSlotOnly, new Date(), conv.id);
    expect(onLast.ok && onLast.slots).toEqual([]);
    const pick = slots.slots[0]!;

    // Missing slot → field error; then pick one in the form
    expect(
      await reviewCheckout({
        kind: "service",
        draftId: d.draftId,
        conversationId: await convOf(d.draftId),
        customer: customer(),
      }),
    ).toMatchObject({
      ok: false,
      code: "validation",
      fieldErrors: { slotId: expect.any(Array) },
    });
    const review = await reviewCheckout({
      kind: "service",
      draftId: d.draftId,
      conversationId: await convOf(d.draftId),
      customer: customer(),
      slotId: pick.slotId,
    });
    if (!review.ok) throw new Error(review.message);
    expect(review.review.service?.slot.localTime).toBe(pick.localTime);
    expect(review.review.quote.shippingCents).toBe(0);

    const r = okResult(
      await confirmCheckout({
        kind: "service",
        draftId: d.draftId,
        conversationId: await convOf(d.draftId),
        customer: customer(),
        slotId: pick.slotId,
      }),
    );
    const booking = await t.prisma.booking.findUniqueOrThrow({
      where: { reference: r.reference },
      include: { payment: true },
    });
    expect(booking.payment).toMatchObject({
      provider: "none",
      status: "not_required",
      amountCents: booking.totalCents,
    });
    expect(booking.durationMin).toBe(90);
    const covered = await t.prisma.slot.findMany({
      where: { coveredByBookingId: booking.id },
      orderBy: { startsAt: "asc" },
    });
    expect(covered).toHaveLength(2);
    expect(
      covered.every((s) => s.status === "booked" && s.contractorId === booking.contractorId),
    ).toBe(true);
    expect(covered[1]!.startsAt.getTime() - covered[0]!.startsAt.getTime()).toBe(3_600_000);
    expect(covered[0]!.bookingId).toBe(booking.id);
    expect(booking.slotId).toBe(covered[0]!.id);
    expect(r.notification?.appointment).toMatchObject({
      timezone: "America/Denver",
      durationMin: 90,
    });
    expect(r.notification?.appointment?.local).toMatch(/M[DS]T/);
  });

  it("two drafts racing for the same (only) slot: exactly one booking", async () => {
    const date = t.dates.services["mountpro-tv"].lastSlotOnly!;
    const avail = await checkAvailability("mountpro-tv", { durationMin: 60, date });
    expect(avail.slots).toHaveLength(1);
    const slotId = avail.slots[0]!.slotId;
    const mk = async () => {
      const conv = await createConversation("mountpro-tv");
      const d = await createCheckoutDraft("mountpro-tv", conv.id, {
        kind: "service",
        selection: { serviceCode: "tv-mounting", tierCode: "M", slotId },
      });
      if (!("draftId" in d)) throw new Error(JSON.stringify(d));
      return d.draftId;
    };
    const [a, b] = [await mk(), await mk()];
    const results = await Promise.all([
      confirmCheckout({
        kind: "service",
        draftId: a,
        conversationId: await convOf(a),
        customer: customer(),
      }),
      confirmCheckout({
        kind: "service",
        draftId: b,
        conversationId: await convOf(b),
        customer: customer({ email: "other@example.com" }),
      }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: "slot_unavailable" });
    const slot = await t.prisma.slot.findUniqueOrThrow({ where: { id: slotId } });
    expect(slot.status).toBe("booked");
    expect(await t.prisma.booking.count({ where: { slotId } })).toBe(1);
    const after = await checkAvailability("mountpro-tv", { durationMin: 60, date });
    expect(after.fullyBooked).toBe(true);
    // A new draft for the taken slot is rejected up front
    const conv = await createConversation("mountpro-tv");
    expect(
      await createCheckoutDraft("mountpro-tv", conv.id, {
        kind: "service",
        selection: { serviceCode: "tv-mounting", tierCode: "M", slotId },
      }),
    ).toMatchObject({ error: "slot_unavailable" });
  });
});

describe("lookupStatus (AT-50, AT-95)", () => {
  it("valid pair finds the order; wrong email, bad ref, other business → identical generic not-found", async () => {
    const order = await t.prisma.order.findFirstOrThrow({ where: { businessId: "volt-supply" } });
    const ok = await lookupStatus("volt-supply", {
      reference: order.reference.toLowerCase(),
      email: "  JANE.SMITH@example.com ",
    });
    expect(ok).toMatchObject({
      found: true,
      kind: "product",
      reference: order.reference,
      status: "confirmed",
      firstName: "Jane",
    });
    expect(JSON.stringify(ok)).not.toMatch(/jane\.smith|Smith|5125550123|Congress/);

    const wrongEmail = await lookupStatus("volt-supply", {
      reference: order.reference,
      email: "jane@example.org",
    });
    const badRef = await lookupStatus("volt-supply", {
      reference: "OAS-2222-2222",
      email: "jane.smith@example.com",
    });
    const malformed = await lookupStatus("volt-supply", { reference: "hello", email: "nope" });
    const otherBusiness = await lookupStatus("flowline-plumbing", {
      reference: order.reference,
      email: "jane.smith@example.com",
    });
    expect(wrongEmail).toMatchObject({ found: false });
    for (const r of [badRef, malformed, otherBusiness]) expect(r).toEqual(wrongEmail);
  });

  it("finds bookings with the appointment in business time", async () => {
    const bk = await t.prisma.booking.findFirstOrThrow({ where: { businessId: "mountpro-tv" } });
    const r = await lookupStatus("mountpro-tv", {
      reference: bk.reference,
      email: "jane.smith@example.com",
    });
    expect(r).toMatchObject({ found: true, kind: "service" });
    if (r.found) expect(r.appointment).toMatch(/M[DS]T/);
  });

  it("owner order list for one business never includes another business's orders", async () => {
    const plumbing = await productDraft("flowline-plumbing", [{ sku: "PL-WAX-RING", qty: 1 }]);
    okResult(
      await confirmCheckout({
        kind: "product",
        draftId: plumbing.draftId,
        conversationId: await convOf(plumbing.draftId),
        customer: customer(),
      }),
    );
    const volt = await listOrders({ businessId: "volt-supply" });
    expect(volt.length).toBeGreaterThan(0);
    expect(
      volt.every(
        (o) => o.businessId === "volt-supply" && o.items.every((i) => i.sku.startsWith("EL-")),
      ),
    ).toBe(true);
    expect(volt[0]!.customer).toEqual({
      name: "J. Smith",
      email: "j***@example.com",
      phone: "(***) ***-0123",
    });
  });
});
