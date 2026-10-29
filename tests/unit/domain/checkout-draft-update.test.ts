/**
 * Booking-form "Service details": changing an open booking draft's configuration
 * (updateDraftServiceConfig) re-prices on the server, clears a time that no longer fits,
 * is bound to the draft's conversation, and review/confirm use what was stored.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkAvailability,
  confirmCheckout,
  createCheckoutDraft,
  createConversation,
  getCheckoutDraft,
  quoteService,
  reviewCheckout,
  updateDraftServiceConfig,
} from "@/domain";
import { customer, setupTestDb, type TestDb } from "./support/test-db";

let t: TestDb;
beforeAll(async () => {
  t = await setupTestDb("draft-update");
}, 120_000);
afterAll(async () => {
  await t?.cleanup();
});

const BIZ = "mountpro-tv";
const base = { serviceCode: "tv-mounting", tierCode: "S" };

/**
 * A MountPro draft for a small TV. `lastSlot`: at the only open slot of the `lastSlotOnly`
 * day (one 60-min slot, so a longer job no longer fits); otherwise the first open time.
 */
async function lastSlotDraft(lastSlot = false) {
  const conv = await createConversation(BIZ);
  const avail = lastSlot
    ? await checkAvailability(BIZ, {
        ...base,
        durationMin: 45,
        date: t.dates.services[BIZ].lastSlotOnly!,
      })
    : await checkAvailability(BIZ, { ...base, durationMin: 45 });
  const slot = lastSlot ? avail.slots.at(-1) : avail.slots[0];
  if (!slot) throw new Error("seed: no last slot");
  const d = await createCheckoutDraft(BIZ, conv.id, {
    kind: "service",
    selection: { ...base, slotId: slot.slotId },
  });
  if (!("draftId" in d)) throw new Error(JSON.stringify(d));
  return { conv: conv.id, draftId: d.draftId, slotId: slot.slotId };
}

describe("updateDraftServiceConfig", () => {
  it("re-prices with the pricing engine and keeps a slot that still fits", async () => {
    const { conv, draftId, slotId } = await lastSlotDraft(true);
    const config = { ...base, tierCode: "M", addOns: [{ code: "mount-tilt", qty: 1 }] };
    const r = await updateDraftServiceConfig(conv, draftId, config);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const expected = await quoteService(BIZ, config);
    if (!("quote" in expected)) throw new Error("quote failed");
    expect(r.view.quote.totalCents).toBe(expected.quote.totalCents);
    expect(r.view.service?.config).toMatchObject({
      tierCode: "M",
      addOns: [{ code: "mount-tilt" }],
    });
    expect(r.view.service?.durationMin).toBe(60);
    expect(r.view.service?.slot?.slotId).toBe(slotId);
    expect(r.slotCleared).toBe(false);
    expect(r.view.summary).toMatch(/Tilting mount/);
  });

  it("clears the chosen time when the longer job no longer fits it", async () => {
    const { conv, draftId } = await lastSlotDraft(true);
    const r = await updateDraftServiceConfig(conv, draftId, { ...base, tierCode: "XXL" });
    expect(r.ok && r.slotCleared).toBe(true);
    if (r.ok) expect(r.view.service?.slot).toBeNull();
    // review without a new time now fails instead of booking the old one
    const rev = await reviewCheckout({
      kind: "service",
      draftId,
      conversationId: conv,
      customer: customer(),
    });
    expect(rev.ok).toBe(false);
  });

  it("confirm charges the stored (edited) price, not the original one", async () => {
    const { conv, draftId } = await lastSlotDraft();
    const before = (await getCheckoutDraft(draftId))!.quote.totalCents;
    const config = { ...base, surcharges: [{ code: "above-fireplace", qty: 1 }] };
    const r = await updateDraftServiceConfig(conv, draftId, config);
    if (!r.ok) throw new Error(r.message);
    expect(r.view.quote.totalCents).toBeGreaterThan(before);
    const done = await confirmCheckout({
      kind: "service",
      draftId,
      conversationId: conv,
      customer: customer(),
      slotId: r.view.service!.slot!.slotId,
    });
    expect(done.ok).toBe(true);
    if (done.ok) expect(done.totalCents).toBe(r.view.quote.totalCents);
    // completed drafts are read-only
    const again = await updateDraftServiceConfig(conv, draftId, base);
    expect(again).toMatchObject({ ok: false, code: "already_completed" });
  });

  it("rejects unknown, conflicting and over-max codes without changing the draft", async () => {
    const { conv, draftId } = await lastSlotDraft();
    const before = await getCheckoutDraft(draftId);
    const bad = [
      { ...base, addOns: [{ code: "free-tv", qty: 1 }] },
      {
        ...base,
        addOns: [
          { code: "mount-fixed", qty: 1 },
          { code: "mount-tilt", qty: 1 },
        ],
      },
      { ...base, addOns: [{ code: "device-shelf", qty: 3 }] },
      { ...base, tierCode: "XXXL" },
      { serviceCode: "lawn-mowing", tierCode: "S" },
      {
        ...base,
        addOns: [
          { code: "soundbar-mount", qty: 1 },
          { code: "soundbar-mount", qty: 1 },
        ],
      },
    ];
    for (const config of bad) {
      const r = await updateDraftServiceConfig(conv, draftId, config);
      expect(r, JSON.stringify(config)).toMatchObject({ ok: false, code: "validation" });
    }
    const after = await getCheckoutDraft(draftId);
    expect(after?.quote).toEqual(before?.quote);
  });

  it("SEC-3: another conversation gets the same not-found as an unknown draft", async () => {
    const { draftId } = await lastSlotDraft();
    const other = (await createConversation(BIZ)).id;
    expect(await updateDraftServiceConfig(other, draftId, base)).toMatchObject({
      ok: false,
      code: "draft_not_found",
    });
    expect(await updateDraftServiceConfig(other, "no-such-draft", base)).toMatchObject({
      ok: false,
      code: "draft_not_found",
    });
  });

  it("expired drafts and product drafts cannot be edited; on-site-estimate jobs are refused", async () => {
    const { conv, draftId } = await lastSlotDraft();
    await t.prisma.checkoutDraft.update({
      where: { id: draftId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await updateDraftServiceConfig(conv, draftId, base)).toMatchObject({
      ok: false,
      code: "draft_expired",
    });

    const pc = await createConversation("volt-supply");
    const pd = await createCheckoutDraft("volt-supply", pc.id, {
      kind: "product",
      lines: [{ sku: "EL-WIR-1222-250", qty: 1 }],
    });
    if (!("draftId" in pd)) throw new Error("product draft");
    expect(await updateDraftServiceConfig(pc.id, pd.draftId, base)).toMatchObject({
      ok: false,
      code: "validation",
    });

    // BrightNest: a 5-bedroom move-out clean with every extra is longer than one day
    const bc = await createConversation("brightnest-cleaning");
    const bd = await createCheckoutDraft("brightnest-cleaning", bc.id, {
      kind: "service",
      selection: { serviceCode: "standard-clean", tierCode: "1BR" },
    });
    if (!("draftId" in bd)) throw new Error("cleaning draft");
    const long = await updateDraftServiceConfig(bc.id, bd.draftId, {
      serviceCode: "move-clean",
      tierCode: "5BR",
      addOns: [
        { code: "extra-bathroom", qty: 5 },
        { code: "inside-cabinets", qty: 1 },
        { code: "interior-windows", qty: 6 },
        { code: "laundry", qty: 4 },
      ],
    });
    expect(long).toMatchObject({ ok: false, code: "validation" });
    if (!long.ok) expect(long.message).toMatch(/estimate/i);
  });
});
