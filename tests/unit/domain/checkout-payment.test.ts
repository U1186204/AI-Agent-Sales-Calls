/** confirmCheckout × PaymentProvider seam: injected fakes, declines roll everything back. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { confirmCheckout, createCheckoutDraft, createConversation, listDraftSlots } from "@/domain";
import { emailHash } from "@/domain/checkout";
import type {
  CreateIntentInput,
  PaymentIntentResult,
  PaymentProvider,
  RefundPaymentInput,
} from "@/payments";
import { customer, setupTestDb, type TestDb } from "./support/test-db";

let t: TestDb;
beforeAll(async () => {
  t = await setupTestDb("payment");
}, 120_000);
afterAll(async () => {
  await t?.cleanup();
});

/** Records every call; answers createIntent with `result`. */
function fakeProvider(result: PaymentIntentResult) {
  const intents: CreateIntentInput[] = [];
  const refunds: RefundPaymentInput[] = [];
  const provider: PaymentProvider = {
    id: "stripe",
    async createIntent(input) {
      intents.push(input);
      return result;
    },
    async confirm() {
      return result;
    },
    async refund(input) {
      refunds.push(input);
      return { status: "refunded" };
    },
  };
  return { provider, intents, refunds };
}

async function productDraft(sku: string, qty: number) {
  const conv = await createConversation("volt-supply");
  const d = await createCheckoutDraft("volt-supply", conv.id, {
    kind: "product",
    lines: [{ sku, qty }],
  });
  if (!("draftId" in d)) throw new Error(JSON.stringify(d));
  return { draftId: d.draftId, conversationId: conv.id };
}

const qty = async (sku: string) =>
  (await t.prisma.product.findFirstOrThrow({ where: { businessId: "volt-supply", sku } }))
    .qtyOnHand;

describe("confirmCheckout with an injected PaymentProvider", () => {
  it("calls createIntent with the final total and the order reference, records the payment", async () => {
    const fake = fakeProvider({ status: "captured", providerRef: "pi_123" });
    const { draftId, conversationId } = await productDraft("EL-WIR-1222-250", 1);
    const r = await confirmCheckout(
      { kind: "product", draftId, conversationId, customer: customer() },
      new Date(),
      { paymentProvider: fake.provider },
    );
    if (!r.ok) throw new Error(`${r.code} ${r.message}`);
    expect(fake.intents).toEqual([
      {
        amountCents: r.totalCents,
        currency: "usd",
        reference: r.reference,
        businessId: "volt-supply",
        customerEmailHash: emailHash("jane.smith@example.com"),
      },
    ]);
    expect(r.payment).toEqual({ provider: "stripe", status: "captured" });
    const order = await t.prisma.order.findUniqueOrThrow({
      where: { reference: r.reference },
      include: { payment: true },
    });
    expect(order.payment).toMatchObject({
      provider: "stripe",
      status: "captured",
      providerRef: "pi_123",
      amountCents: order.totalCents,
    });
    expect(fake.refunds).toEqual([]);
  });

  it("default provider (none) keeps Payment{none,not_required}", async () => {
    const { draftId, conversationId } = await productDraft("EL-WIR-1222-250", 1);
    const r = await confirmCheckout({
      kind: "product",
      draftId,
      conversationId,
      customer: customer(),
    });
    if (!r.ok) throw new Error(`${r.code} ${r.message}`);
    expect(r.payment).toEqual({ provider: "none", status: "not_required" });
    const order = await t.prisma.order.findUniqueOrThrow({
      where: { reference: r.reference },
      include: { payment: true },
    });
    expect(order.payment).toMatchObject({ provider: "none", status: "not_required" });
  });

  it("a failed payment is a structured payment_failed with no stock, order or draft change", async () => {
    const fake = fakeProvider({ status: "failed", failureMessage: "Card declined." });
    const before = await qty("EL-WIR-1222-250");
    const orders = await t.prisma.order.count();
    const payments = await t.prisma.payment.count();
    const { draftId, conversationId } = await productDraft("EL-WIR-1222-250", 2);
    const r = await confirmCheckout(
      { kind: "product", draftId, conversationId, customer: customer() },
      new Date(),
      { paymentProvider: fake.provider },
    );
    expect(r).toEqual({ ok: false, code: "payment_failed", message: "Card declined." });
    expect(fake.intents).toHaveLength(1);
    expect(await qty("EL-WIR-1222-250")).toBe(before);
    expect(await t.prisma.order.count()).toBe(orders);
    expect(await t.prisma.payment.count()).toBe(payments);
    const draft = await t.prisma.checkoutDraft.findUniqueOrThrow({ where: { id: draftId } });
    expect(draft).toMatchObject({ status: "open", resultRef: null });

    // The same draft can be retried and succeed with a working provider.
    const ok = await confirmCheckout(
      { kind: "product", draftId, conversationId, customer: customer() },
      new Date(),
      { paymentProvider: fakeProvider({ status: "authorized", providerRef: "pi_ok" }).provider },
    );
    expect(ok).toMatchObject({ ok: true, replayed: false });
    expect(await qty("EL-WIR-1222-250")).toBe(before - 2);
  });

  it("pending (client action needed) is not supported yet and also rolls back", async () => {
    const fake = fakeProvider({ status: "pending", clientSecret: "cs_1" });
    const before = await qty("EL-WIR-1222-250");
    const { draftId, conversationId } = await productDraft("EL-WIR-1222-250", 1);
    const r = await confirmCheckout(
      { kind: "product", draftId, conversationId, customer: customer() },
      new Date(),
      { paymentProvider: fake.provider },
    );
    expect(r).toMatchObject({ ok: false, code: "payment_failed" });
    expect(await qty("EL-WIR-1222-250")).toBe(before);
  });

  it("a failed payment on a booking leaves every slot open", async () => {
    const conv = await createConversation("mountpro-tv");
    const d = await createCheckoutDraft("mountpro-tv", conv.id, {
      kind: "service",
      selection: { serviceCode: "tv-mounting", tierCode: "L" },
    });
    if (!("draftId" in d)) throw new Error(JSON.stringify(d));
    const slots = await listDraftSlots(d.draftId, undefined, new Date(), conv.id);
    if (!slots.ok) throw new Error(slots.message);
    const pick = slots.slots[0]!;
    const bookings = await t.prisma.booking.count();
    const fake = fakeProvider({ status: "failed" });
    const r = await confirmCheckout(
      {
        kind: "service",
        draftId: d.draftId,
        conversationId: conv.id,
        customer: customer(),
        slotId: pick.slotId,
      },
      new Date(),
      { paymentProvider: fake.provider },
    );
    expect(r).toMatchObject({ ok: false, code: "payment_failed" });
    expect(fake.intents[0]?.amountCents).toBeGreaterThan(0);
    const slot = await t.prisma.slot.findUniqueOrThrow({ where: { id: pick.slotId } });
    expect(slot).toMatchObject({ status: "open", coveredByBookingId: null, bookingId: null });
    expect(await t.prisma.booking.count()).toBe(bookings);
    expect(
      (await t.prisma.checkoutDraft.findUniqueOrThrow({ where: { id: d.draftId } })).status,
    ).toBe("open");
  });

  it("a provider that throws is an internal failure with nothing claimed", async () => {
    const before = await qty("EL-WIR-1222-250");
    const { draftId, conversationId } = await productDraft("EL-WIR-1222-250", 1);
    const boom: PaymentProvider = {
      id: "stripe",
      createIntent: async () => {
        throw new Error("network down");
      },
      confirm: async () => ({ status: "failed" }),
      refund: async () => ({ status: "failed" }),
    };
    const r = await confirmCheckout(
      { kind: "product", draftId, conversationId, customer: customer() },
      new Date(),
      { paymentProvider: boom },
    );
    expect(r).toMatchObject({ ok: false, code: "internal" });
    expect(await qty("EL-WIR-1222-250")).toBe(before);
  });
});
