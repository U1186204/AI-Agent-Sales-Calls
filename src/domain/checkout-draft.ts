/**
 * Checkout drafts: created by the agent's `start_checkout` (no PII), rendered by the inline
 * form (`getCheckoutDraft`, `listDraftSlots`), consumed by review/confirm. TTL 30 minutes.
 */
import { z } from "zod";
import {
  ProductLineInput,
  Quote,
  ServiceConfig,
  type ServiceOptions,
  type SlotSummary,
  type StartCheckoutOutput,
} from "@/contracts";
import { CHECKOUT_DRAFT_TTL_MIN } from "@/config/constants";
import { getServiceDefinition } from "@/config/pricing";
import { randomId } from "@/guard/crypto";
import { DomainError, requireBusiness } from "./business";
import { quoteService } from "./catalog";
import { db } from "./db";
import { isAnchorBookable, openStarts, toSlotSummary } from "./availability";
import { resolveLines, type LineRequest } from "./inventory";
import { formatDuration, priceProducts, slotsNeeded } from "./pricing";
import { buildServiceOptions } from "./service-options";

/** What a draft stores in `selection` (JSON). Never PII. */
export const DraftSelection = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("product"),
    lines: z.array(ProductLineInput),
    zip: z.string().optional(),
  }),
  z.object({
    kind: z.literal("service"),
    config: ServiceConfig,
    tierName: z.string(),
    durationMin: z.number().int(),
    slotId: z.string().optional(),
  }),
]);
export type DraftSelection = z.output<typeof DraftSelection>;

export type CreateDraftInput =
  | { kind: "product"; lines: LineRequest[]; zip?: string }
  | { kind: "service"; selection: z.input<typeof ServiceConfig> & { slotId?: string } };

export type CreateDraftResult = z.output<typeof StartCheckoutOutput>;

export function productSummary(lines: { qty: number; name: string; sku: string }[]): string {
  return lines.map((l) => `${l.qty} × ${l.name} (${l.sku})`).join("; ");
}

export function describeService(
  businessId: string,
  sel: Extract<DraftSelection, { kind: "service" }>,
) {
  const def = getServiceDefinition(businessId, sel.config.serviceCode);
  const extras = [
    ...sel.config.addOns.map((a) => def?.addOns.find((x) => x.code === a.code)?.name ?? a.code),
    ...sel.config.surcharges.map(
      (s) => def?.surcharges.find((x) => x.code === s.code)?.name ?? s.code,
    ),
  ];
  return (
    `${def?.name ?? sel.config.serviceCode} — ${sel.tierName}` +
    (extras.length ? ` + ${extras.join(", ")}` : "") +
    ` (about ${formatDuration(sel.durationMin)})`
  );
}

/** Validate and store a draft. Unknown SKUs/codes and qty > stock are rejected. */
export async function createCheckoutDraft(
  businessId: string,
  conversationId: string,
  input: CreateDraftInput,
  now: Date = new Date(),
): Promise<CreateDraftResult> {
  const business = requireBusiness(businessId);
  const conv = await db().conversation.findFirst({ where: { id: conversationId, businessId } });
  if (!conv) throw new DomainError("unknown_conversation", "Conversation not found for business");
  if (input.kind !== business.kind) {
    return {
      error: "invalid_selection",
      message: `${business.name} ${business.kind === "product" ? "sells products" : "books services"}; use a ${business.kind} checkout.`,
    };
  }

  let selection: DraftSelection;
  let quote: Quote;
  let summary: string;

  if (input.kind === "product") {
    if (input.lines.length === 0)
      return { error: "invalid_selection", message: "The cart is empty." };
    const { items, issues } = await resolveLines(businessId, input.lines, "strict");
    const missing = issues.filter((i) => i.problem === "not_found");
    if (missing.length) {
      return {
        error: "unknown_sku",
        message: `Not in this catalog: ${missing.map((i) => i.sku).join(", ")}.`,
      };
    }
    const out = issues.filter((i) => i.problem === "out_of_stock");
    if (out.length) {
      return {
        error: "out_of_stock",
        message: `Out of stock: ${out.map((i) => i.sku).join(", ")}.`,
      };
    }
    const short = issues.filter((i) => i.problem === "insufficient_stock");
    if (short.length) {
      return {
        error: "insufficient_stock",
        message: `Not enough stock: ${short.map((i) => `${i.sku} (only ${i.available} available)`).join(", ")}.`,
      };
    }
    const zip =
      input.zip && /^\d{5}(-\d{4})?$/.test(input.zip.trim()) ? input.zip.trim() : undefined;
    quote = priceProducts(items, zip).quote;
    selection = { kind: "product", lines: items.map((i) => ({ sku: i.sku, qty: i.qty })), zip };
    summary = productSummary(items);
  } else {
    const { slotId, ...config } = input.selection;
    const r = await quoteService(businessId, config);
    if ("notFound" in r) return { error: "unknown_service", message: r.message };
    if ("invalid" in r) return { error: "invalid_selection", message: r.message };
    if (r.requiresOnSiteEstimate) {
      // EDGE-2: never hand the customer a form whose calendar can have no bookable day.
      return {
        error: "requires_on_site_estimate",
        message: r.onSiteEstimateReason ?? "This job needs an on-site estimate.",
      };
    }
    if (slotId && !(await isAnchorBookable(businessId, slotId, r.durationMin, now))) {
      return {
        error: "slot_unavailable",
        message: "That time is no longer available for a job this long. Please pick another time.",
      };
    }
    selection = {
      kind: "service",
      config: ServiceConfig.parse(config),
      tierName: r.tierName,
      durationMin: r.durationMin,
      slotId,
    };
    quote = r.quote;
    summary = describeService(businessId, selection);
  }

  const expiresAt = new Date(now.getTime() + CHECKOUT_DRAFT_TTL_MIN * 60_000);
  const draft = await db().checkoutDraft.create({
    data: {
      // 128-bit random id (SEC-11); the draft is additionally bound to `conversationId`.
      id: randomId(),
      businessId,
      conversationId,
      kind: input.kind,
      selection,
      quote,
      status: "open",
      expiresAt,
    },
  });
  return {
    draftId: draft.id,
    kind: input.kind,
    summary,
    quote,
    expiresAt: expiresAt.toISOString(),
  };
}

export interface DraftView {
  draftId: string;
  /** The conversation that created the draft (server-side only; never sent to clients). */
  conversationId: string;
  businessId: string;
  businessName: string;
  kind: "product" | "service";
  status: "open" | "completed" | "expired";
  expiresAt: string;
  timezone: string;
  summary: string;
  quote: Quote;
  items?: { sku: string; name: string; qty: number; unitCents: number; lineCents: number }[];
  service?: {
    code: string;
    name: string;
    tierName: string;
    durationMin: number;
    slotsNeeded: number;
    /** Pre-selected time, if the agent picked one and it is still open. */
    slot: SlotSummary | null;
    /** The configuration being booked (codes only). */
    config: ServiceConfig;
    /** Every option of the service, labelled for customers. */
    options: ServiceOptions;
  };
  /** Order/booking reference once completed. */
  reference?: string;
}

/** Load a draft row + parsed selection/quote (internal). */
export async function loadDraft(draftId: string) {
  const row = await db().checkoutDraft.findUnique({ where: { id: draftId } });
  if (!row) return null;
  const selection = DraftSelection.safeParse(row.selection);
  const quote = Quote.safeParse(row.quote);
  if (!selection.success || !quote.success) return null;
  return { row, selection: selection.data, quote: quote.data };
}

export function draftStatus(
  row: { status: string; expiresAt: Date },
  now: Date = new Date(),
): DraftView["status"] {
  if (row.status === "completed") return "completed";
  if (row.status === "expired" || row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "open";
}

/** Public, PII-free view of ONE draft (by id) for the inline form. Null if unknown. */
export async function getCheckoutDraft(
  draftId: string,
  now: Date = new Date(),
): Promise<DraftView | null> {
  const d = await loadDraft(draftId);
  if (!d) return null;
  const { row, selection, quote } = d;
  const b = requireBusiness(row.businessId);
  const view: DraftView = {
    draftId: row.id,
    conversationId: row.conversationId,
    businessId: b.id,
    businessName: b.name,
    kind: selection.kind,
    status: draftStatus(row, now),
    expiresAt: row.expiresAt.toISOString(),
    timezone: b.timezone,
    summary: "",
    quote,
    reference: row.status === "completed" ? (row.resultRef ?? undefined) : undefined,
  };
  if (selection.kind === "product") {
    view.items = quote.lines
      .filter((l) => l.kind === "goods")
      .map((l) => ({
        sku: l.code,
        name: l.label,
        qty: l.qty,
        unitCents: l.unitCents,
        lineCents: l.amountCents,
      }));
    view.summary = productSummary(view.items);
  } else {
    const def = getServiceDefinition(b.id, selection.config.serviceCode);
    const options = buildServiceOptions(b.id, selection.config.serviceCode);
    if (!def || !options) return null;
    let slot: SlotSummary | null = null;
    if (selection.slotId && view.status === "open") {
      const run = await isAnchorBookable(b.id, selection.slotId, selection.durationMin, now);
      if (run) slot = toSlotSummary(run, run.contractorName, b.timezone, selection.durationMin);
    }
    view.service = {
      code: selection.config.serviceCode,
      name: def.name,
      tierName: selection.tierName,
      durationMin: selection.durationMin,
      slotsNeeded: slotsNeeded(selection.durationMin),
      slot,
      config: selection.config,
      options,
    };
    view.summary = describeService(b.id, selection);
  }
  return view;
}

/**
 * The draft view only when `draftId` was created by `conversationId` (SEC-3/ISO-1): a leaked
 * draft id alone reveals nothing. Null for unknown ids and for other conversations alike.
 */
export async function getCheckoutDraftForConversation(
  conversationId: string,
  draftId: string,
  now: Date = new Date(),
): Promise<DraftView | null> {
  const row = await db().checkoutDraft.findFirst({
    where: { id: draftId, conversationId },
    select: { id: true },
  });
  if (!row) return null;
  return getCheckoutDraft(draftId, now);
}

export type DraftSlotsResult =
  | {
      ok: true;
      timezone: string;
      durationMin: number;
      /** Business-local dates (YYYY-MM-DD) that have at least one start, within the horizon. */
      availableDates: string[];
      /** The date whose starts are listed (requested date, else the first available date). */
      date: string | null;
      slots: SlotSummary[];
    }
  | {
      ok: false;
      code: "draft_not_found" | "draft_expired" | "already_completed" | "not_service";
      message: string;
    };

/**
 * Real open start times for this draft's job length (form date/time picker). Only for the
 * conversation that created the draft (otherwise `draft_not_found`).
 */
export async function listDraftSlots(
  draftId: string,
  date: string | undefined,
  now: Date,
  conversationId: string,
): Promise<DraftSlotsResult> {
  const d = await loadDraft(draftId);
  if (!d || d.row.conversationId !== conversationId) {
    return { ok: false, code: "draft_not_found", message: "Checkout not found." };
  }
  const status = draftStatus(d.row, now);
  if (status === "completed") {
    return { ok: false, code: "already_completed", message: "This booking is already confirmed." };
  }
  if (status === "expired") {
    return {
      ok: false,
      code: "draft_expired",
      message: "This checkout expired. Ask for a new one.",
    };
  }
  if (d.selection.kind !== "service") {
    return { ok: false, code: "not_service", message: "Product orders have no time slots." };
  }
  const { horizon, starts } = await openStarts(d.row.businessId, d.selection.durationMin, now);
  const availableDates = [...new Set(starts.map((s) => s.localDate))];
  const chosen = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : (availableDates[0] ?? null);
  return {
    ok: true,
    timezone: horizon.tz,
    durationMin: d.selection.durationMin,
    availableDates,
    date: chosen,
    slots: chosen ? starts.filter((s) => s.localDate === chosen) : [],
  };
}

export type UpdateDraftResult =
  | { ok: true; view: DraftView; slotCleared: boolean }
  | {
      ok: false;
      code: "draft_not_found" | "draft_expired" | "already_completed" | "validation";
      message: string;
      fieldErrors?: Record<string, string[]>;
    };

/**
 * Change the service configuration of an OPEN booking draft created by `conversationId`
 * (customer edits in the form's "Service details"). The pricing engine re-prices it; a chosen
 * time that no longer fits the new job length is cleared. Review and confirm re-price and
 * re-check from what is stored here, so the client never supplies a price or a duration.
 */
export async function updateDraftServiceConfig(
  conversationId: string,
  draftId: string,
  input: z.input<typeof ServiceConfig>,
  now: Date = new Date(),
): Promise<UpdateDraftResult> {
  const d = await loadDraft(draftId);
  // SEC-3: another conversation's draft looks exactly like an unknown one.
  if (!d || d.row.conversationId !== conversationId) {
    return { ok: false, code: "draft_not_found", message: "This checkout was not found." };
  }
  const status = draftStatus(d.row, now);
  if (status === "completed") {
    return {
      ok: false,
      code: "already_completed",
      message: "This booking is already confirmed.",
    };
  }
  if (status === "expired") {
    return {
      ok: false,
      code: "draft_expired",
      message: "This checkout expired. Ask the assistant to start again.",
    };
  }
  if (d.selection.kind !== "service") {
    return {
      ok: false,
      code: "validation",
      message: "Only bookings have service details.",
      fieldErrors: { form: ["Only bookings have service details"] },
    };
  }
  const businessId = d.row.businessId;
  const r = await quoteService(businessId, input);
  if ("notFound" in r) {
    return {
      ok: false,
      code: "validation",
      message: "That service isn't offered here.",
      fieldErrors: { service: ["Unknown service"] },
    };
  }
  if ("invalid" in r) {
    const fieldErrors: Record<string, string[]> = {};
    for (const e of r.errors) (fieldErrors[e.field] ??= []).push(e.message);
    return { ok: false, code: "validation", message: r.message, fieldErrors };
  }
  if (r.requiresOnSiteEstimate) {
    const message = r.onSiteEstimateReason ?? "This job needs an on-site estimate.";
    return { ok: false, code: "validation", message, fieldErrors: { service: [message] } };
  }
  const prevSlot = d.selection.slotId;
  const keepSlot =
    prevSlot !== undefined && (await isAnchorBookable(businessId, prevSlot, r.durationMin, now));
  const selection: DraftSelection = {
    kind: "service",
    config: ServiceConfig.parse(input),
    tierName: r.tierName,
    durationMin: r.durationMin,
    slotId: keepSlot ? prevSlot : undefined,
  };
  // Only an open draft of this conversation is updated (a confirm racing this edit wins).
  const updated = await db().checkoutDraft.updateMany({
    where: { id: draftId, conversationId, status: "open", expiresAt: { gt: now } },
    data: { selection, quote: r.quote },
  });
  if (updated.count !== 1) {
    return {
      ok: false,
      code: "already_completed",
      message: "This checkout can no longer be changed.",
    };
  }
  const view = await getCheckoutDraft(draftId, now);
  if (!view) return { ok: false, code: "draft_not_found", message: "This checkout was not found." };
  return { ok: true, view, slotCleared: prevSlot !== undefined && !keepSlot };
}
