/**
 * Review + confirm (SPEC AT-41..44). Both re-validate everything server-side:
 * CustomerForm (Zod), draft state, stock or slot run, service area, and a fresh quote with
 * shipping to the entered ZIP. User errors are structured results, never throws.
 *
 * confirmCheckout runs in ONE Prisma transaction: guarded stock decrements
 * (`qtyOnHand >= qty`) or guarded slot claims (`status = open`, count must equal the run
 * length), payment via the injected PaymentProvider (src/payments; default from
 * PAYMENT_PROVIDER = "none" → Payment{none,not_required}), customer upsert (all PII encrypted),
 * Order/Booking + Payment row, draft → completed. Any conflict — including a `failed` payment —
 * rolls everything back. Idempotent on draftId.
 */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  CheckoutInput,
  type CheckoutResult,
  type CheckoutReview,
  type CustomerFormData,
  type Quote,
  type SlotSummary,
  zipStateWarning,
} from "@/contracts";
import { getServiceDefinition } from "@/config/pricing";
import { encryptJson, encryptString, generateReference, hmacLookup } from "@/guard/crypto";
import {
  getPaymentProvider,
  SETTLED_PAYMENT_STATUSES,
  type PaymentIntentResult,
  type PaymentProvider,
} from "@/payments";
import { requireBusiness } from "./business";
import { isZipServed } from "./catalog";
import { db, type Tx } from "./db";
import { appointmentLabel, findRunForAnchor, toSlotSummary, type Run } from "./availability";
import { describeService, draftStatus, DraftSelection, productSummary } from "./checkout-draft";
import { resolveLines } from "./inventory";
import { addressSummary, maskEmail, maskName, maskPhone } from "./mask";
import { priceProducts, priceService, type PricedItem } from "./pricing";

export type CheckoutFailure = Extract<CheckoutResult, { ok: false }> & {
  /** Set for `already_completed`: the existing order/booking reference. */
  reference?: string;
};
export type CheckoutRequest = z.input<typeof CheckoutInput>;

/** Normalize email for the lookup hash (same normalization as the Email contract). */
export function emailHash(email: string): string {
  return hmacLookup(email.trim().toLowerCase());
}

class Conflict extends Error {
  constructor(public readonly failure: CheckoutFailure) {
    super(failure.message);
  }
}

const fail = (
  code: CheckoutFailure["code"],
  message: string,
  extra: Partial<CheckoutFailure> = {},
): CheckoutFailure => ({ ok: false, code, message, ...extra });

function fieldErrorsFrom(issues: readonly z.core.$ZodIssue[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const i of issues) {
    const path = i.path.map(String);
    const key =
      path[0] === "customer" && path.length > 1
        ? path.slice(1).join(".")
        : path.join(".") || "form";
    (out[key] ??= []).push(i.message);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared preparation
// ---------------------------------------------------------------------------

type Prepared =
  | {
      kind: "product";
      draftId: string;
      businessId: string;
      conversationId: string;
      customer: CustomerFormData;
      expiresAt: Date;
      quote: Quote;
      items: (PricedItem & { productId: string })[];
    }
  | {
      kind: "service";
      draftId: string;
      businessId: string;
      conversationId: string;
      customer: CustomerFormData;
      expiresAt: Date;
      quote: Quote;
      serviceCode: string;
      serviceName: string;
      tierName: string;
      durationMin: number;
      selection: Extract<DraftSelection, { kind: "service" }>;
      run: Run & { contractorName: string };
      requestedSlotId: string;
      slot: SlotSummary;
      warnings: string[];
    };

async function prepare(
  client: Tx,
  raw: unknown,
  now: Date,
): Promise<{ ok: true; p: Prepared } | CheckoutFailure> {
  const parsed = CheckoutInput.safeParse(raw);
  if (!parsed.success) {
    return fail("validation", "Please fix the highlighted fields.", {
      fieldErrors: fieldErrorsFrom(parsed.error.issues),
    });
  }
  const input = parsed.data;
  const row = await client.checkoutDraft.findUnique({ where: { id: input.draftId } });
  // SEC-3: a draft is bound to the conversation that created it. Another conversation (or a
  // leaked draft id without it) gets the same "not found" as an unknown id.
  if (!row || row.conversationId !== input.conversationId)
    return fail("draft_not_found", "This checkout was not found. Please start again in chat.");
  const status = draftStatus(row, now);
  if (status === "completed") {
    return fail(
      "already_completed",
      `Already confirmed as ${row.resultRef ?? "an earlier order"}.`,
      {
        reference: row.resultRef ?? undefined,
      },
    );
  }
  if (status === "expired") {
    return fail(
      "draft_expired",
      "This checkout expired after 30 minutes. Ask in chat to start a new one.",
    );
  }
  const sel = DraftSelection.safeParse(row.selection);
  if (!sel.success) return fail("internal", "This checkout could not be read.");
  if (sel.data.kind !== input.kind) {
    return fail("validation", "Checkout type does not match.", {
      fieldErrors: { kind: ["Mismatch"] },
    });
  }
  const customer = input.customer;
  if (!isZipServed(row.businessId, customer.zip)) {
    return fail("outside_service_area", `Sorry, we do not serve ZIP ${customer.zip} yet.`, {
      fieldErrors: { zip: ["Outside our service area"] },
    });
  }
  const base = {
    draftId: row.id,
    businessId: row.businessId,
    conversationId: row.conversationId,
    customer,
    expiresAt: row.expiresAt,
  };

  if (sel.data.kind === "product") {
    const { items, issues } = await resolveLines(row.businessId, sel.data.lines, "strict", client);
    if (issues.length > 0) {
      const detail = issues
        .map((i) =>
          i.problem === "insufficient_stock"
            ? `${i.sku}: only ${i.available} left`
            : `${i.sku}: ${i.problem === "not_found" ? "no longer available" : "out of stock"}`,
        )
        .join("; ");
      return fail("out_of_stock", `Stock changed since your quote — ${detail}.`);
    }
    const { quote } = priceProducts(items, customer.zip);
    return { ok: true, p: { ...base, kind: "product", quote, items } };
  }

  const s = sel.data;
  const def = getServiceDefinition(row.businessId, s.config.serviceCode);
  if (!def) return fail("internal", "This service is no longer offered.");
  const priced = priceService(def, s.config);
  if (!priced.ok) return fail("internal", "This service selection is no longer valid.");
  const slotId = input.kind === "service" ? (input.slotId ?? s.slotId) : undefined;
  if (!slotId) {
    return fail("validation", "Please choose an appointment time.", {
      fieldErrors: { slotId: ["Choose a date and time"] },
    });
  }
  const durationMin = priced.quote.durationMin ?? s.durationMin;
  const run = await findRunForAnchor(client, row.businessId, slotId, durationMin, now);
  if (!run) {
    return fail("slot_unavailable", "That time was just taken. Please pick another time.", {
      fieldErrors: { slotId: ["No longer available"] },
    });
  }
  const tz = requireBusiness(row.businessId).timezone;
  return {
    ok: true,
    p: {
      ...base,
      kind: "service",
      quote: priced.quote,
      serviceCode: def.code,
      serviceName: def.name,
      tierName: priced.tierName,
      durationMin,
      selection: s,
      run,
      requestedSlotId: slotId,
      slot: toSlotSummary(run, run.contractorName, tz, durationMin),
      warnings: priced.warnings,
    },
  };
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export type ReviewResult = { ok: true; review: CheckoutReview } | CheckoutFailure;

export async function reviewCheckout(
  input: CheckoutRequest,
  now: Date = new Date(),
): Promise<ReviewResult> {
  try {
    const r = await prepare(db(), input, now);
    if (!r.ok) return r;
    const p = r.p;
    const b = requireBusiness(p.businessId);
    const c = p.customer;
    const review: CheckoutReview = {
      draftId: p.draftId,
      kind: p.kind,
      businessId: b.id,
      businessName: b.name,
      customer: {
        name: maskName(c.firstName, c.lastName),
        emailMasked: maskEmail(c.email),
        phoneMasked: maskPhone(c.phone),
        addressSummary: addressSummary(c),
      },
      quote: p.quote,
      expiresAt: p.expiresAt.toISOString(),
      warnings: [],
    };
    if (p.kind === "product") {
      review.items = p.items.map((i) => ({
        sku: i.sku,
        name: i.name,
        qty: i.qty,
        lineCents: i.priceCents * i.qty,
      }));
    } else {
      review.service = {
        code: p.serviceCode,
        name: p.serviceName,
        tierName: p.tierName,
        slot: p.slot,
      };
      if (p.run.anchorId !== p.requestedSlotId) {
        review.warnings.push(
          `Your appointment will be with ${p.run.contractorName} to keep this time.`,
        );
      }
      review.warnings.push(...p.warnings);
    }
    // R2-1: a ZIP/state mismatch never blocks (ZIP areas cross state lines); it is a soft
    // warning on the review step, and confirm accepts the same details unchanged.
    const zipWarning = zipStateWarning(c.zip, c.state);
    if (zipWarning) review.warnings.unshift(zipWarning);
    return { ok: true, review };
  } catch {
    return fail("internal", "Something went wrong preparing your review. Please try again.");
  }
}

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

/**
 * Everything the notify module needs. The ONLY place decrypted PII leaves the domain.
 * Never log this object.
 */
export interface CheckoutNotification {
  kind: "product" | "service";
  reference: string;
  businessId: string;
  businessName: string;
  business: { notifyEmail: string; notifyPhone: string; supportEmail: string };
  customer: { firstName: string; email: string; phoneE164: string };
  /** One line per item / priced component, e.g. "2 × Wax ring (PL-WAX-RING) — $9.98". */
  summaryLines: string[];
  summary: string;
  totals: {
    subtotalCents: number;
    discountCents: number;
    shippingCents: number;
    taxCents: number;
    totalCents: number;
  };
  quote: Quote;
  /** Bookings only. */
  appointment?: {
    startsAt: string;
    local: string;
    timezone: string;
    durationMin: number;
    contractor: string;
  };
  /** Products only. */
  shipping?: { zone: number; zip: string };
}

export type ConfirmResult =
  | (Extract<CheckoutResult, { ok: true }> & {
      notification?: CheckoutNotification;
      /** Fresh confirms only (domain-side; not part of the HTTP response). */
      payment?: { provider: PaymentProvider["id"]; status: PaymentIntentResult["status"] };
    })
  | CheckoutFailure;

interface CreatedIntent {
  result: PaymentIntentResult;
  amountCents: number;
  reference: string;
}

/** Injectable collaborators (tests pass fakes; production uses the configured defaults). */
export interface ConfirmDeps {
  /** Defaults to `getPaymentProvider()` (PAYMENT_PROVIDER, default "none"). */
  paymentProvider?: PaymentProvider;
}

/** The completed order/booking of `draftId`, only for the conversation that created it. */
async function existingResult(
  draftId: string,
  conversationId: string | null,
): Promise<ConfirmResult | null> {
  if (!conversationId) return null;
  const order = await db().order.findFirst({ where: { draftId, conversationId } });
  if (order) {
    return {
      ok: true,
      kind: "product",
      reference: order.reference,
      status: order.status,
      totalCents: order.totalCents,
      replayed: true,
    };
  }
  const booking = await db().booking.findFirst({ where: { draftId, conversationId } });
  if (booking) {
    return {
      ok: true,
      kind: "service",
      reference: booking.reference,
      status: booking.status,
      totalCents: booking.totalCents,
      replayed: true,
    };
  }
  return null;
}

async function uniqueReference(tx: Tx): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const ref = generateReference("OAS");
    const [o, b] = await Promise.all([
      tx.order.findUnique({ where: { reference: ref }, select: { id: true } }),
      tx.booking.findUnique({ where: { reference: ref }, select: { id: true } }),
    ]);
    if (!o && !b) return ref;
  }
  throw new Error("Could not allocate a unique reference");
}

async function upsertCustomer(tx: Tx, businessId: string, c: CustomerFormData): Promise<string> {
  const enc = {
    firstNameEnc: encryptString(c.firstName),
    lastNameEnc: encryptString(c.lastName),
    emailEnc: encryptString(c.email),
    phoneEnc: encryptString(c.phone),
    addressEnc: encryptJson({
      line1: c.address1,
      line2: c.address2 ?? null,
      city: c.city,
      state: c.state,
      zip: c.zip,
    }),
  };
  const hash = emailHash(c.email);
  const row = await tx.customer.upsert({
    where: { businessId_emailHash: { businessId, emailHash: hash } },
    create: { businessId, emailHash: hash, ...enc },
    update: enc,
    select: { id: true },
  });
  return row.id;
}

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

export async function confirmCheckout(
  input: CheckoutRequest,
  now: Date = new Date(),
  deps: ConfirmDeps = {},
): Promise<ConfirmResult> {
  let prepared: Prepared | null = null;
  let reference = "";
  let provider: PaymentProvider;
  try {
    provider = deps.paymentProvider ?? getPaymentProvider();
  } catch {
    return fail("internal", "Checkout is not available right now. Nothing was charged.");
  }
  /** The intent created in this attempt; voided below if the transaction then rolls back. */
  const attempt: { intent: CreatedIntent | null } = { intent: null };
  try {
    reference = await db().$transaction(
      async (tx) => {
        const r = await prepare(tx, input, now);
        if (!r.ok) throw new Conflict(r);
        const p = r.p;
        prepared = p;
        const ref = await uniqueReference(tx);
        const customerId = await upsertCustomer(tx, p.businessId, p.customer);
        const instructionsEnc = p.customer.instructions
          ? encryptString(p.customer.instructions)
          : null;
        const money = {
          subtotalCents: p.quote.subtotalCents,
          discountCents: p.quote.discountCents,
          shippingCents: p.quote.shippingCents,
          taxCents: p.quote.taxCents,
          totalCents: p.quote.totalCents,
        };
        // Claims first (stock/slots), then payment, then the order/booking: a declined
        // payment throws a Conflict and the claims roll back with everything else.
        const takePayment = async () => {
          const res = await provider.createIntent({
            amountCents: p.quote.totalCents,
            currency: "usd",
            reference: ref,
            businessId: p.businessId,
            customerEmailHash: emailHash(p.customer.email),
          });
          attempt.intent = { result: res, amountCents: p.quote.totalCents, reference: ref };
          // "pending" (needs a client-side step) is not supported until the review step can
          // run it (see src/payments/index.ts); treat it like a failure for now.
          if (!SETTLED_PAYMENT_STATUSES.includes(res.status)) {
            throw new Conflict(
              fail(
                "payment_failed",
                res.failureMessage ??
                  "Your payment could not be completed, so nothing was booked or charged. Please try again.",
              ),
            );
          }
          return {
            create: {
              provider: provider.id,
              status: res.status,
              amountCents: p.quote.totalCents,
              providerRef: res.providerRef ?? null,
            },
          };
        };

        if (p.kind === "product") {
          for (const it of p.items) {
            const res = await tx.product.updateMany({
              where: {
                id: it.productId,
                businessId: p.businessId,
                active: true,
                qtyOnHand: { gte: it.qty },
              },
              data: { qtyOnHand: { decrement: it.qty } },
            });
            if (res.count !== 1) {
              throw new Conflict(
                fail(
                  "out_of_stock",
                  `Sorry — ${it.name} (${it.sku}) just sold out or dropped below ${it.qty}.`,
                ),
              );
            }
          }
          const payment = await takePayment();
          await tx.order.create({
            data: {
              reference: ref,
              businessId: p.businessId,
              customerId,
              conversationId: p.conversationId,
              draftId: p.draftId,
              status: "confirmed",
              lines: p.items.map((i) => ({
                sku: i.sku,
                name: i.name,
                unit: i.unit,
                qty: i.qty,
                unitPriceCents: i.priceCents,
                lineCents: i.priceCents * i.qty,
                weightLb: i.weightLb,
              })),
              ...money,
              shipZone: p.quote.shipZone ?? 0,
              instructionsEnc,
              payment,
            },
          });
        } else {
          const bookingId = randomUUID();
          const res = await tx.slot.updateMany({
            where: { id: { in: p.run.slotIds }, businessId: p.businessId, status: "open" },
            data: { status: "booked", coveredByBookingId: bookingId, heldUntil: null },
          });
          if (res.count !== p.run.slotIds.length) {
            throw new Conflict(
              fail("slot_unavailable", "That time was just taken. Please pick another time.", {
                fieldErrors: { slotId: ["No longer available"] },
              }),
            );
          }
          const payment = await takePayment();
          await tx.booking.create({
            data: {
              id: bookingId,
              reference: ref,
              businessId: p.businessId,
              customerId,
              conversationId: p.conversationId,
              draftId: p.draftId,
              slotId: p.run.anchorId,
              contractorId: p.run.contractorId,
              serviceCode: p.serviceCode,
              selection: {
                tierCode: p.selection.config.tierCode,
                tierName: p.tierName,
                extraUnits: p.selection.config.extraUnits,
                addOns: p.selection.config.addOns,
                surcharges: p.selection.config.surcharges,
                frequency: p.selection.config.frequency,
                durationMin: p.durationMin,
                slotIds: p.run.slotIds,
              },
              status: "confirmed",
              startsAt: p.run.startsAt,
              durationMin: p.durationMin,
              ...money,
              shippingCents: 0,
              instructionsEnc,
              payment,
            },
          });
          await tx.slot.update({ where: { id: p.run.anchorId }, data: { bookingId } });
        }

        const done = await tx.checkoutDraft.updateMany({
          where: { id: p.draftId, status: "open" },
          // Keep the FINAL quote (shipping to the entered ZIP) so a reloaded form shows the
          // confirmed total (WF-3).
          data: { status: "completed", resultRef: ref, quote: p.quote },
        });
        if (done.count !== 1) {
          throw new Conflict(fail("already_completed", "This checkout was already confirmed."));
        }
        await tx.conversation.updateMany({
          where: { id: p.conversationId, businessId: p.businessId },
          data: { outcome: p.kind === "product" ? "order" : "booking", lastActiveAt: now },
        });
        return ref;
      },
      { maxWait: 15_000, timeout: 20_000 },
    );
  } catch (err) {
    await voidPayment(provider, attempt.intent);
    if (err instanceof Conflict) {
      if (err.failure.code === "already_completed") {
        const draftId = draftIdOf(input);
        const existing = draftId ? await existingResult(draftId, conversationIdOf(input)) : null;
        if (existing) return existing;
      }
      return err.failure;
    }
    // Unique violation on draftId → a concurrent confirm won; replay its result.
    const draftId = draftIdOf(input);
    if (isUniqueViolation(err) && draftId) {
      const existing = await existingResult(draftId, conversationIdOf(input));
      if (existing) return existing;
    }
    return fail(
      "internal",
      "Something went wrong confirming your order. Nothing was charged; please try again.",
    );
  }

  const p = prepared as Prepared | null;
  if (!p) return fail("internal", "Confirmation state lost.");
  return {
    ok: true,
    kind: p.kind,
    reference,
    status: "confirmed",
    totalCents: p.quote.totalCents,
    replayed: false,
    notification: buildNotification(p, reference),
    payment: { provider: provider.id, status: attempt.intent?.result.status ?? "not_required" },
  };
}

/**
 * Best-effort compensation: the transaction rolled back after the provider authorized or
 * captured money, so release it. Never throws (the customer already gets a failure result).
 */
async function voidPayment(provider: PaymentProvider, intent: CreatedIntent | null) {
  const ref = intent?.result.providerRef;
  if (!intent || !ref) return;
  if (intent.result.status !== "authorized" && intent.result.status !== "captured") return;
  try {
    await provider.refund({
      providerRef: ref,
      amountCents: intent.amountCents,
      reference: intent.reference,
      reason: "checkout_rolled_back",
    });
  } catch {
    // Reconciliation (provider dashboard / webhook) catches anything left behind.
  }
}

function draftIdOf(input: unknown): string | null {
  const id = (input as { draftId?: unknown } | null)?.draftId;
  return typeof id === "string" ? id : null;
}

function conversationIdOf(input: unknown): string | null {
  const id = (input as { conversationId?: unknown } | null)?.conversationId;
  return typeof id === "string" ? id : null;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

function buildNotification(p: Prepared, reference: string): CheckoutNotification {
  const b = requireBusiness(p.businessId);
  const q = p.quote;
  const summaryLines = q.lines.map(
    (l) =>
      `${l.qty > 1 && l.kind === "goods" ? `${l.qty} × ` : ""}${l.label}${l.kind === "goods" ? ` (${l.code})` : ""} — ${usd(l.amountCents)}`,
  );
  const base = {
    kind: p.kind,
    reference,
    businessId: b.id,
    businessName: b.name,
    business: {
      notifyEmail: b.notifyEmail,
      notifyPhone: b.notifyPhone,
      supportEmail: b.supportEmail,
    },
    customer: {
      firstName: p.customer.firstName,
      email: p.customer.email,
      phoneE164: p.customer.phone,
    },
    summaryLines,
    totals: {
      subtotalCents: q.subtotalCents,
      discountCents: q.discountCents,
      shippingCents: q.shippingCents,
      taxCents: q.taxCents,
      totalCents: q.totalCents,
    },
    quote: q,
  };
  if (p.kind === "product") {
    return {
      ...base,
      summary: productSummary(p.items),
      shipping:
        q.shipZone !== undefined && q.shipZip ? { zone: q.shipZone, zip: q.shipZip } : undefined,
    };
  }
  return {
    ...base,
    summary: describeService(p.businessId, p.selection),
    appointment: {
      startsAt: p.run.startsAt.toISOString(),
      local: appointmentLabel(p.run.startsAt, b.timezone),
      timezone: b.timezone,
      durationMin: p.durationMin,
      contractor: p.run.contractorName,
    },
  };
}
