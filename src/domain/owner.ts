/**
 * Owner dashboard queries (AT-71). Cross-business by design (the owner sees all five demo
 * businesses); callers MUST gate these behind owner auth. Customer PII is only ever returned
 * masked: "J. Smith", "j***@example.com", "(***) ***-1234".
 */
import { BOOKING_HORIZON_DAYS } from "@/config/constants";
import { decryptJson, decryptString } from "@/guard/crypto";
import {
  maskContactDetails,
  maskEmail as maskEmailFully,
  redactContactDetails,
} from "@/guard/redact";
import { addDays, localDateString, zonedTimeToUtc } from "@/lib/tz";
import { BUSINESSES, requireBusiness } from "./business";
import { db } from "./db";
import { appointmentLabel } from "./availability";
import { maskEmail, maskName, maskPhone } from "./mask";
import { getDailyUsage } from "./conversations";

const LOW_STOCK = 5;

function dec(v: string): string {
  try {
    return decryptString(v);
  } catch {
    return "";
  }
}

interface EncCustomer {
  firstNameEnc: string;
  lastNameEnc: string;
  emailEnc: string;
  phoneEnc: string;
}

export interface MaskedContact {
  name: string;
  email: string;
  phone: string;
}

function maskCustomer(c: EncCustomer): MaskedContact {
  return {
    name: maskName(dec(c.firstNameEnc), dec(c.lastNameEnc)),
    email: maskEmail(dec(c.emailEnc)),
    phone: maskPhone(dec(c.phoneEnc)),
  };
}

const businessName = (id: string) => BUSINESSES.find((b) => b.id === id)?.name ?? id;

// ---------------------------------------------------------------------------

export interface OwnerOverview {
  generatedAt: string;
  usageToday: Awaited<ReturnType<typeof getDailyUsage>>;
  totals: {
    orders: number;
    bookings: number;
    revenueCents: number;
    conversations: number;
    openEscalations: number;
  };
  businesses: {
    id: string;
    name: string;
    kind: string;
    orders: number;
    bookings: number;
    revenueCents: number;
    conversations: number;
    openEscalations: number;
    lowStock: number;
    outOfStock: number;
  }[];
}

/**
 * Dashboard overview. With `businessId`, EVERY count and sum is scoped to that business
 * (ISO-2); the LLM usage figure stays global (the daily budget is shared by all businesses).
 */
export async function ownerOverview(businessId?: string): Promise<OwnerOverview> {
  const where = businessId ? { businessId } : {};
  const [orders, bookings, convs, escs, products, usageToday] = await Promise.all([
    db().order.groupBy({
      by: ["businessId"],
      where,
      _count: { _all: true },
      _sum: { totalCents: true },
    }),
    db().booking.groupBy({
      by: ["businessId"],
      where,
      _count: { _all: true },
      _sum: { totalCents: true },
    }),
    db().conversation.groupBy({ by: ["businessId"], where, _count: { _all: true } }),
    db().escalation.groupBy({
      by: ["businessId"],
      where: { ...where, status: "open" },
      _count: { _all: true },
    }),
    db().product.findMany({
      where: { ...where, active: true },
      select: { businessId: true, qtyOnHand: true },
    }),
    getDailyUsage(),
  ]);
  const pick = <T extends { businessId: string }>(rows: T[], id: string) =>
    rows.find((r) => r.businessId === id);
  const businesses = BUSINESSES.filter((b) => !businessId || b.id === businessId).map((b) => {
    const o = pick(orders, b.id);
    const bk = pick(bookings, b.id);
    const prods = products.filter((p) => p.businessId === b.id);
    return {
      id: b.id,
      name: b.name,
      kind: b.kind,
      orders: o?._count._all ?? 0,
      bookings: bk?._count._all ?? 0,
      revenueCents: (o?._sum.totalCents ?? 0) + (bk?._sum.totalCents ?? 0),
      conversations: pick(convs, b.id)?._count._all ?? 0,
      openEscalations: pick(escs, b.id)?._count._all ?? 0,
      lowStock: prods.filter((p) => p.qtyOnHand > 0 && p.qtyOnHand <= LOW_STOCK).length,
      outOfStock: prods.filter((p) => p.qtyOnHand <= 0).length,
    };
  });
  const sum = (k: "orders" | "bookings" | "revenueCents" | "conversations" | "openEscalations") =>
    businesses.reduce((s, b) => s + b[k], 0);
  return {
    generatedAt: new Date().toISOString(),
    usageToday,
    totals: {
      orders: sum("orders"),
      bookings: sum("bookings"),
      revenueCents: sum("revenueCents"),
      conversations: sum("conversations"),
      openEscalations: sum("openEscalations"),
    },
    businesses,
  };
}

export interface ListFilter {
  businessId?: string;
  status?: string;
  limit?: number;
}

export interface OwnerOrderRow {
  reference: string;
  businessId: string;
  businessName: string;
  status: string;
  customer: MaskedContact;
  items: { sku: string; name: string; qty: number }[];
  itemCount: number;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  shipZone: number;
  paymentStatus: string | null;
  createdAt: string;
}

export async function listOrders(filter: ListFilter = {}): Promise<OwnerOrderRow[]> {
  const rows = await db().order.findMany({
    where: { businessId: filter.businessId, status: filter.status },
    include: { customer: true, payment: true },
    orderBy: { createdAt: "desc" },
    take: Math.min(filter.limit ?? 100, 500),
  });
  return rows.map((o) => {
    const items = (
      (Array.isArray(o.lines) ? o.lines : []) as unknown as {
        sku: string;
        name: string;
        qty: number;
      }[]
    ).map((l) => ({ sku: l.sku, name: l.name, qty: l.qty }));
    return {
      reference: o.reference,
      businessId: o.businessId,
      businessName: businessName(o.businessId),
      status: o.status,
      customer: maskCustomer(o.customer),
      items,
      itemCount: items.reduce((s, i) => s + i.qty, 0),
      subtotalCents: o.subtotalCents,
      shippingCents: o.shippingCents,
      taxCents: o.taxCents,
      totalCents: o.totalCents,
      shipZone: o.shipZone,
      paymentStatus: o.payment?.status ?? null,
      createdAt: o.createdAt.toISOString(),
    };
  });
}

export interface OwnerBookingRow {
  reference: string;
  businessId: string;
  businessName: string;
  status: string;
  customer: MaskedContact;
  serviceCode: string;
  tierName: string;
  contractor: string;
  startsAt: string;
  appointment: string;
  /** Short zone label at the appointment, e.g. "MDT" (WF-7). */
  timezoneLabel: string;
  durationMin: number;
  totalCents: number;
  paymentStatus: string | null;
  createdAt: string;
}

/** "MDT" — the short zone name in effect at `instant`. */
export function timezoneLabelAt(instant: Date, tz: string): string {
  return (
    new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
      .formatToParts(instant)
      .find((p) => p.type === "timeZoneName")?.value ?? tz
  );
}

/** Sortable business-local wall-clock key "YYYY-MM-DD HH:MM". */
function localWallKey(instant: Date, tz: string): string {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
  return `${localDateString(instant, tz)} ${time}`;
}

/**
 * Bookings sorted by LOCAL start (business wall-clock time, then UTC), each with its
 * timezone label, so mixed-timezone rows read in order (WF-7).
 */
export async function listBookings(
  filter: ListFilter & { from?: Date; to?: Date } = {},
): Promise<OwnerBookingRow[]> {
  const rows = await db().booking.findMany({
    where: {
      businessId: filter.businessId,
      status: filter.status,
      startsAt: filter.from || filter.to ? { gte: filter.from, lt: filter.to } : undefined,
    },
    include: { customer: true, payment: true, contractor: { select: { name: true } } },
    orderBy: { startsAt: "asc" },
    take: Math.min(filter.limit ?? 100, 500),
  });
  const keyed = rows.map((bk) => {
    const tz = requireBusiness(bk.businessId).timezone;
    const sel = (bk.selection ?? {}) as { tierName?: string };
    const row: OwnerBookingRow = {
      reference: bk.reference,
      businessId: bk.businessId,
      businessName: businessName(bk.businessId),
      status: bk.status,
      customer: maskCustomer(bk.customer),
      serviceCode: bk.serviceCode,
      tierName: sel.tierName ?? "",
      contractor: bk.contractor.name,
      startsAt: bk.startsAt.toISOString(),
      appointment: appointmentLabel(bk.startsAt, tz),
      timezoneLabel: timezoneLabelAt(bk.startsAt, tz),
      durationMin: bk.durationMin,
      totalCents: bk.totalCents,
      paymentStatus: bk.payment?.status ?? null,
      createdAt: bk.createdAt.toISOString(),
    };
    return { row, key: localWallKey(bk.startsAt, tz), t: bk.startsAt.getTime() };
  });
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.t - b.t));
  return keyed.map((k) => k.row);
}

export interface InventoryRow {
  businessId: string;
  sku: string;
  name: string;
  category: string;
  qtyOnHand: number;
  priceCents: number;
  level: "ok" | "low" | "out";
}

export async function inventoryLevels(businessId?: string): Promise<InventoryRow[]> {
  const rows = await db().product.findMany({
    where: { businessId, active: true },
    orderBy: [{ businessId: "asc" }, { qtyOnHand: "asc" }, { sku: "asc" }],
  });
  return rows.map((p) => ({
    businessId: p.businessId,
    sku: p.sku,
    name: p.name,
    category: p.category,
    qtyOnHand: p.qtyOnHand,
    priceCents: p.priceCents,
    level: p.qtyOnHand <= 0 ? "out" : p.qtyOnHand <= LOW_STOCK ? "low" : "ok",
  }));
}

export interface AvailabilityDay {
  businessId: string;
  date: string;
  open: number;
  booked: number;
  total: number;
}

/** Per service business per local date: open vs booked slot counts for the next `days`. */
export async function availabilitySummary(
  businessId?: string,
  days = 14,
  now: Date = new Date(),
): Promise<AvailabilityDay[]> {
  const span = Math.min(Math.max(days, 1), BOOKING_HORIZON_DAYS);
  const out: AvailabilityDay[] = [];
  for (const b of BUSINESSES.filter(
    (x) => x.kind === "service" && (!businessId || x.id === businessId),
  )) {
    const today = localDateString(now, b.timezone);
    const from = zonedTimeToUtc(today, "00:00", b.timezone);
    const to = zonedTimeToUtc(addDays(today, span), "00:00", b.timezone);
    const slots = await db().slot.findMany({
      where: { businessId: b.id, startsAt: { gte: from, lt: to } },
      select: { startsAt: true, status: true },
    });
    const byDate = new Map<string, AvailabilityDay>();
    for (let i = 0; i < span; i++) {
      const d = addDays(today, i);
      byDate.set(d, { businessId: b.id, date: d, open: 0, booked: 0, total: 0 });
    }
    for (const s of slots) {
      const row = byDate.get(localDateString(s.startsAt, b.timezone));
      if (!row) continue;
      row.total++;
      if (s.status === "open" && s.startsAt > now) row.open++;
      else if (s.status !== "open") row.booked++;
    }
    out.push(...byDate.values());
  }
  return out;
}

export async function listNotifications(limit = 100, businessId?: string) {
  return db().notification.findMany({
    where: { businessId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 500),
    select: {
      id: true,
      businessId: true,
      channel: true,
      audience: true,
      provider: true,
      status: true,
      toMasked: true,
      subject: true,
      relatedRef: true,
      error: true,
      createdAt: true,
    },
  });
}

export interface OwnerConversationRow {
  id: string;
  businessId: string;
  businessName: string;
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  costUsd: number;
  escalated: boolean;
  outcome: string;
}

/** Metadata only (no message content). */
export async function listConversations(
  limit = 100,
  businessId?: string,
): Promise<OwnerConversationRow[]> {
  const rows = await db().conversation.findMany({
    where: { businessId },
    orderBy: { lastActiveAt: "desc" },
    take: Math.min(Math.max(limit, 1), 500),
  });
  return rows.map((c) => ({
    id: c.id,
    businessId: c.businessId,
    businessName: businessName(c.businessId),
    createdAt: c.createdAt.toISOString(),
    lastActiveAt: c.lastActiveAt.toISOString(),
    messageCount: c.messageCount,
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    costMicros: c.costMicros,
    costUsd: c.costMicros / 1e6,
    escalated: c.escalated,
    outcome: c.outcome,
  }));
}

// ---------------------------------------------------------------------------
// Today's activity + per-contractor availability (dashboard overview / availability tab)
// ---------------------------------------------------------------------------

export interface OwnerTodayStats {
  /** UTC day key (same as UsageDay). */
  date: string;
  orders: number;
  bookings: number;
  revenueCents: number;
  conversations: number;
  usage: Awaited<ReturnType<typeof getDailyUsage>>;
}

/**
 * Orders/bookings/conversations created since 00:00 UTC today (scoped to `businessId` when
 * given, ISO-2), plus today's global LLM usage.
 */
export async function ownerToday(
  now: Date = new Date(),
  businessId?: string,
): Promise<OwnerTodayStats> {
  const date = now.toISOString().slice(0, 10);
  const since = new Date(`${date}T00:00:00.000Z`);
  const scope = businessId ? { businessId } : {};
  const [orders, bookings, conversations, usage] = await Promise.all([
    db().order.aggregate({
      where: { ...scope, createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { totalCents: true },
    }),
    db().booking.aggregate({
      where: { ...scope, createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { totalCents: true },
    }),
    db().conversation.count({ where: { ...scope, createdAt: { gte: since } } }),
    getDailyUsage(date),
  ]);
  return {
    date,
    orders: orders._count._all,
    bookings: bookings._count._all,
    revenueCents: (orders._sum.totalCents ?? 0) + (bookings._sum.totalCents ?? 0),
    conversations,
    usage,
  };
}

export interface ContractorAvailabilityRow {
  businessId: string;
  businessName: string;
  timezone: string;
  contractorId: string;
  contractor: string;
  /** One entry per local date, in the same order as `days`. */
  days: { date: string; open: number; booked: number; held: number }[];
}

/**
 * Per service business, per active contractor, per local date (business timezone) for the
 * next `days` days: open (future) / booked / held slot counts. `days` lists the dates of the
 * first business (all demo businesses share a timezone-agnostic "today + n" calendar).
 */
export async function contractorAvailability(
  businessId?: string,
  days = 14,
  now: Date = new Date(),
): Promise<{ days: string[]; items: ContractorAvailabilityRow[] }> {
  const span = Math.min(Math.max(days, 1), BOOKING_HORIZON_DAYS);
  const items: ContractorAvailabilityRow[] = [];
  let dayList: string[] | null = null;
  for (const b of BUSINESSES.filter(
    (x) => x.kind === "service" && (!businessId || x.id === businessId),
  )) {
    const today = localDateString(now, b.timezone);
    const dates = Array.from({ length: span }, (_, i) => addDays(today, i));
    dayList ??= dates;
    const from = zonedTimeToUtc(today, "00:00", b.timezone);
    const to = zonedTimeToUtc(addDays(today, span), "00:00", b.timezone);
    const [contractors, slots] = await Promise.all([
      db().contractor.findMany({
        where: { businessId: b.id, active: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
      db().slot.findMany({
        where: { businessId: b.id, startsAt: { gte: from, lt: to } },
        select: { contractorId: true, startsAt: true, status: true },
      }),
    ]);
    for (const c of contractors) {
      const byDate = new Map(dates.map((d) => [d, { date: d, open: 0, booked: 0, held: 0 }]));
      for (const s of slots) {
        if (s.contractorId !== c.id) continue;
        const row = byDate.get(localDateString(s.startsAt, b.timezone));
        if (!row) continue;
        if (s.status === "open") {
          if (s.startsAt > now) row.open++;
        } else if (s.status === "held") row.held++;
        else row.booked++;
      }
      items.push({
        businessId: b.id,
        businessName: b.name,
        timezone: b.timezone,
        contractorId: c.id,
        contractor: c.name,
        days: [...byDate.values()],
      });
    }
  }
  return { days: dayList ?? [], items };
}

// ---------------------------------------------------------------------------
// Escalations + transcripts (WF-2)
// ---------------------------------------------------------------------------

export interface OwnerEscalationRow {
  ticketRef: string;
  businessId: string;
  businessName: string;
  createdAt: string;
  reason: string;
  /** Emails, phone numbers, cards, SSNs and passwords removed. */
  summary: string;
  contactEmailMasked: string | null;
  conversationId: string | null;
  status: "open" | "resolved";
}

/** Newest first. Summaries are decrypted, then scrubbed again (older rows predate INJ-5). */
export async function listEscalations(
  limit = 100,
  businessId?: string,
): Promise<OwnerEscalationRow[]> {
  const rows = await db().escalation.findMany({
    where: { businessId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 500),
  });
  return rows.map((e) => {
    let summary = "";
    let contact: string | null = null;
    try {
      const data = decryptJson<{ summary?: unknown; contactEmail?: unknown }>(e.summaryEnc);
      summary = typeof data.summary === "string" ? data.summary : "";
      contact =
        typeof data.contactEmail === "string" && data.contactEmail ? data.contactEmail : null;
    } catch {
      summary = "[unreadable]";
    }
    return {
      ticketRef: e.id,
      businessId: e.businessId,
      businessName: businessName(e.businessId),
      createdAt: e.createdAt.toISOString(),
      reason: e.reason,
      summary: redactContactDetails(summary),
      contactEmailMasked: contact ? maskEmailFully(contact) : null,
      conversationId: e.conversationId,
      status: e.status === "resolved" ? "resolved" : "open",
    };
  });
}

export interface OwnerTranscriptView {
  conversationId: string;
  businessId: string;
  businessName: string;
  messages: { role: "user" | "assistant"; text: string; createdAt: string }[];
}

/**
 * Masked transcript of one conversation (oldest first, max 200): customer + assistant text
 * only (app events and tool records are omitted). Stored text is already redacted (cards,
 * SSNs, passwords); emails and phone numbers are masked here. Null for an unknown id.
 */
export async function getConversationTranscript(
  conversationId: string,
): Promise<OwnerTranscriptView | null> {
  const conv = await db().conversation.findUnique({ where: { id: conversationId } });
  if (!conv) return null;
  const rows = await db().message.findMany({
    where: { conversationId, role: { in: ["user", "assistant"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 200,
  });
  return {
    conversationId: conv.id,
    businessId: conv.businessId,
    businessName: businessName(conv.businessId),
    messages: rows.map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      text: maskContactDetails(dec(m.contentEnc)),
      createdAt: m.createdAt.toISOString(),
    })),
  };
}
