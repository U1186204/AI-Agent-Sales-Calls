/** Conversations, usage, escalation and owner views. */
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptJson, isEncrypted } from "@/guard/crypto";
import {
  addUsage,
  appendMessage,
  availabilitySummary,
  confirmCheckout,
  createCheckoutDraft,
  createConversation,
  DomainError,
  getConversation,
  getDailyUsage,
  inventoryLevels,
  listBookings,
  listConversations,
  listDraftSlots,
  listNotifications,
  ownerOverview,
  recordEscalation,
  setConversationOutcome,
} from "@/domain";
import { customer, setupTestDb, type TestDb } from "./support/test-db";

let t: TestDb;
/** The conversation that created a draft (checkout bodies must carry it, SEC-3). */
const convOf = async (draftId: string) =>
  (await t.prisma.checkoutDraft.findUnique({ where: { id: draftId } }))?.conversationId ??
  "no-such-conversation";
beforeAll(async () => {
  t = await setupTestDb("conversations");
}, 120_000);
afterAll(async () => {
  await t?.cleanup();
});

describe("conversations", () => {
  it("stores messages encrypted and returns decrypted history in order", async () => {
    const c = await createConversation("greenstripe-lawn");
    expect(c).toMatchObject({ businessId: "greenstripe-lawn", messageCount: 0, outcome: "none" });
    await appendMessage(c.id, "user", "How much to mow 1/4 acre?");
    const m2 = await appendMessage(c.id, "assistant", "A small lawn is $55.", [
      { id: "t1", label: "x" },
    ]);
    expect(m2.messageCount).toBe(2);
    const got = await getConversation(c.id, { withMessages: true });
    expect(got?.messages?.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(got?.messages?.[1]?.text).toBe("A small lawn is $55.");
    expect(got?.messages?.[1]?.trace).toEqual([{ id: "t1", label: "x" }]);

    const raw = new Database(t.file, { readonly: true });
    const rows = raw.prepare('SELECT "contentEnc" FROM "Message"').all() as {
      contentEnc: string;
    }[];
    raw.close();
    expect(rows.every((r) => isEncrypted(r.contentEnc) && !r.contentEnc.includes("mow"))).toBe(
      true,
    );
    expect(await getConversation("missing")).toBeNull();
    await expect(createConversation("nope")).rejects.toBeInstanceOf(DomainError);
  });

  it("adds usage to the conversation and UsageDay", async () => {
    const c = await createConversation("greenstripe-lawn");
    const day = "2031-01-02";
    const now = new Date(`${day}T12:00:00Z`);
    await addUsage(c.id, { inputTokens: 1000, outputTokens: 200, costMicros: 2000 }, now);
    const r = await addUsage(c.id, { inputTokens: 500, outputTokens: 100, costMicros: 1000 }, now);
    expect(r.conversation).toMatchObject({
      inputTokens: 1500,
      outputTokens: 300,
      costMicros: 3000,
    });
    expect(r.day).toEqual({
      day,
      inputTokens: 1500,
      outputTokens: 300,
      costMicros: 3000,
      requests: 2,
    });
    expect(await getDailyUsage(day)).toEqual(r.day);
    expect(await getDailyUsage("2031-01-03")).toMatchObject({ costMicros: 0, requests: 0 });
    await setConversationOutcome(c.id, "booking");
    expect((await getConversation(c.id))?.outcome).toBe("booking");
    await expect(setConversationOutcome("missing", "order")).rejects.toBeInstanceOf(DomainError);
  });
});

describe("recordEscalation (AT-51)", () => {
  it("creates a ticket, encrypts the summary and marks the conversation escalated", async () => {
    const c = await createConversation("brightnest-cleaning");
    const r = await recordEscalation("brightnest-cleaning", c.id, {
      reason: "requested_human",
      summary: "Customer wants to discuss a post-construction clean.",
      contactEmail: "Pat@Example.com",
    });
    expect(r.ticketId).toMatch(/^ESC-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    expect(r.responseTime).toBe("within 4 business hours");
    expect(r.supportEmail).toBe("support@brightnest-cleaning.example.com");
    expect(r.notification).toMatchObject({
      contactEmail: "pat@example.com",
      reason: "requested_human",
    });
    const row = await t.prisma.escalation.findUniqueOrThrow({ where: { id: r.ticketId } });
    expect(isEncrypted(row.summaryEnc)).toBe(true);
    expect(decryptJson<{ summary: string }>(row.summaryEnc).summary).toMatch(/post-construction/);
    const conv = await getConversation(c.id);
    expect(conv).toMatchObject({ escalated: true, outcome: "escalated" });

    const other = await createConversation("mountpro-tv");
    await expect(
      recordEscalation("brightnest-cleaning", other.id, {
        reason: "other",
        summary: "Wrong business id here",
      }),
    ).rejects.toBeInstanceOf(DomainError);
    const weird = await recordEscalation("brightnest-cleaning", null, {
      reason: "made-up",
      summary: "Something",
    });
    expect(weird.notification.reason).toBe("other");
  });
});

describe("owner views (masked)", () => {
  it("summarizes data and masks customer contact details", async () => {
    const conv = await createConversation("brightnest-cleaning");
    const d = await createCheckoutDraft("brightnest-cleaning", conv.id, {
      kind: "service",
      selection: {
        serviceCode: "standard-clean",
        tierCode: "2BR",
        addOns: [{ code: "inside-oven" }],
      },
    });
    if (!("draftId" in d)) throw new Error(JSON.stringify(d));
    const slots = await listDraftSlots(d.draftId, undefined, new Date(), conv.id);
    if (!slots.ok) throw new Error(slots.message);
    const r = await confirmCheckout({
      kind: "service",
      draftId: d.draftId,
      conversationId: await convOf(d.draftId),
      customer: customer({
        firstName: "Robin",
        lastName: "Lee",
        email: "robin.lee@example.com",
        phone: "2125550188",
      }),
      slotId: slots.slots[0]!.slotId,
    });
    expect(r.ok).toBe(true);

    const bookings = await listBookings({ businessId: "brightnest-cleaning" });
    expect(bookings).toHaveLength(1);
    expect(bookings[0]!.customer).toEqual({
      name: "R. Lee",
      email: "r***@example.com",
      phone: "(***) ***-0188",
    });
    expect(bookings[0]!.paymentStatus).toBe("not_required");
    expect(JSON.stringify(bookings)).not.toMatch(/robin|2125550188|Congress/i);

    const overview = await ownerOverview();
    const bn = overview.businesses.find((b) => b.id === "brightnest-cleaning")!;
    expect(bn.bookings).toBe(1);
    expect(bn.revenueCents).toBe(bookings[0]!.totalCents);
    expect(overview.businesses.find((b) => b.id === "volt-supply")!.outOfStock).toBe(3);

    const inv = await inventoryLevels("flowline-plumbing");
    expect(inv).toHaveLength(25);
    expect(
      inv
        .filter((i) => i.level === "out")
        .map((i) => i.sku)
        .sort(),
    ).toEqual(["PL-FAU-BATH", "PL-VLV-PRV34", "PL-WH-50G-ELEC"]);

    const avail = await availabilitySummary("mountpro-tv", 14);
    expect(avail).toHaveLength(14);
    const full = avail.find((a) => a.date === t.dates.services["mountpro-tv"].fullyBooked[0]);
    expect(full && full.total > 0 && full.open === 0).toBe(true);
    expect((await availabilitySummary()).length).toBe(14 * 3);

    const convs = await listConversations(50);
    const row = convs.find((c) => c.id === conv.id)!;
    expect(row).toMatchObject({ outcome: "booking", businessId: "brightnest-cleaning" });
    expect(row).not.toHaveProperty("messages");
    expect(Array.isArray(await listNotifications(10))).toBe(true);
  });
});
