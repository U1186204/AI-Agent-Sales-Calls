/**
 * Owner dashboard API shapes (all GET, owner session required, 401 when signed out).
 * All values are PII-masked server-side (customer names as "J. Smith").
 *
 *   GET /api/owner/overview       -> OwnerOverview
 *   GET /api/owner/orders         -> { items: OwnerOrder[] }          newest first, max 200
 *   GET /api/owner/bookings       -> { items: OwnerBooking[] }        by startsAt, max 200
 *   GET /api/owner/inventory      -> { items: OwnerInventoryItem[] }
 *   GET /api/owner/availability   -> { days: string[]; items: OwnerAvailability[] }  next 14 days
 *   GET /api/owner/notifications  -> { items: OwnerNotification[] }   newest first, max 200
 *   GET /api/owner/conversations  -> { items: OwnerConversation[] }   newest first, max 200
 *   GET /api/owner/escalations    -> OwnerEscalationsResponse          newest first, max 200
 *   GET /api/owner/conversations/:id/transcript -> OwnerTranscript     masked, oldest first
 *
 * Every list endpoint accepts an optional `?businessId=<slug>` filter.
 */
import { z } from "zod";

const BusinessRef = {
  businessId: z.string(),
  businessName: z.string(),
};

export const OwnerOverview = z.object({
  /**
   * True while ANY shipped demo secret is in use (owner password hash, SESSION_SECRET,
   * OASIS_ENCRYPTION_KEY, OASIS_HMAC_KEY): the dashboard shows a banner.
   */
  demoCredentials: z.boolean(),
  /** Names of the env variables still holding demo values (empty when none). */
  demoSecrets: z.array(z.string()).default([]),
  generatedAt: z.string(),
  today: z.object({
    /** Calendar day used for "today" (UTC, YYYY-MM-DD — the same day key as the LLM budget). */
    date: z.string(),
    orders: z.number().int(),
    bookings: z.number().int(),
    /** Orders + bookings confirmed today, totals in cents. */
    revenueCents: z.number().int(),
    conversations: z.number().int(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    costUsd: z.number(),
    dailyBudgetUsd: z.number(),
  }),
  totals: z.object({
    orders: z.number().int(),
    bookings: z.number().int(),
    openEscalations: z.number().int(),
    lowStock: z.number().int(),
    outOfStock: z.number().int(),
  }),
  businesses: z.array(
    z.object({
      ...BusinessRef,
      kind: z.enum(["product", "service"]),
      orders: z.number().int(),
      bookings: z.number().int(),
      revenueCents: z.number().int(),
      conversations: z.number().int(),
    }),
  ),
});
export type OwnerOverview = z.infer<typeof OwnerOverview>;

export const OwnerOrder = z.object({
  ...BusinessRef,
  reference: z.string(),
  status: z.string(),
  createdAt: z.string(),
  customerName: z.string(),
  itemCount: z.number().int(),
  totalCents: z.number().int(),
  shipZone: z.number().int().nullable(),
});
export type OwnerOrder = z.infer<typeof OwnerOrder>;

export const OwnerBooking = z.object({
  ...BusinessRef,
  reference: z.string(),
  status: z.string(),
  serviceName: z.string(),
  startsAt: z.string(),
  timezone: z.string(),
  /** Short zone label at the appointment time, e.g. "MDT". */
  timezoneLabel: z.string(),
  /** Appointment in the business timezone with the zone, e.g. "Tue, Oct 6, 2026, 1:00 PM MDT". */
  localStart: z.string(),
  durationMin: z.number().int(),
  contractor: z.string(),
  customerName: z.string(),
  totalCents: z.number().int(),
});
export type OwnerBooking = z.infer<typeof OwnerBooking>;

export const StockLevel = z.enum(["in_stock", "low", "out"]);
export type StockLevel = z.infer<typeof StockLevel>;

export const OwnerInventoryItem = z.object({
  ...BusinessRef,
  sku: z.string(),
  name: z.string(),
  category: z.string(),
  qtyOnHand: z.number().int(),
  priceCents: z.number().int(),
  stock: StockLevel,
});
export type OwnerInventoryItem = z.infer<typeof OwnerInventoryItem>;

export const OwnerAvailability = z.object({
  ...BusinessRef,
  timezone: z.string(),
  contractorId: z.string(),
  contractor: z.string(),
  /** Same order as the top-level `days` array. */
  days: z.array(
    z.object({
      date: z.string(),
      open: z.number().int(),
      booked: z.number().int(),
      held: z.number().int(),
    }),
  ),
});
export type OwnerAvailability = z.infer<typeof OwnerAvailability>;

export const NotificationChannel = z.enum(["email", "sms"]);
export const NotificationAudience = z.enum(["customer", "business", "support"]);
export const NotificationStatus = z.enum(["sent", "failed", "mocked"]);

export const OwnerNotification = z.object({
  id: z.string(),
  ...BusinessRef,
  createdAt: z.string(),
  channel: NotificationChannel,
  audience: NotificationAudience,
  provider: z.string(),
  status: NotificationStatus,
  toMasked: z.string(),
  subject: z.string().nullable(),
  relatedRef: z.string().nullable(),
  error: z.string().nullable(),
});
export type OwnerNotification = z.infer<typeof OwnerNotification>;

export const ConversationOutcome = z.enum(["none", "order", "booking", "escalated"]);

export const OwnerConversation = z.object({
  id: z.string(),
  ...BusinessRef,
  createdAt: z.string(),
  lastActiveAt: z.string(),
  messageCount: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number(),
  escalated: z.boolean(),
  outcome: ConversationOutcome,
});
export type OwnerConversation = z.infer<typeof OwnerConversation>;

export const OwnerList = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item) });

export const OwnerOrdersResponse = OwnerList(OwnerOrder);
export type OwnerOrdersResponse = z.infer<typeof OwnerOrdersResponse>;
export const OwnerBookingsResponse = OwnerList(OwnerBooking);
export type OwnerBookingsResponse = z.infer<typeof OwnerBookingsResponse>;
export const OwnerInventoryResponse = OwnerList(OwnerInventoryItem);
export type OwnerInventoryResponse = z.infer<typeof OwnerInventoryResponse>;
export const OwnerNotificationsResponse = OwnerList(OwnerNotification);
export type OwnerNotificationsResponse = z.infer<typeof OwnerNotificationsResponse>;
export const OwnerConversationsResponse = OwnerList(OwnerConversation);
export type OwnerConversationsResponse = z.infer<typeof OwnerConversationsResponse>;

export const OwnerAvailabilityResponse = z.object({
  days: z.array(z.string()),
  items: z.array(OwnerAvailability),
});
export type OwnerAvailabilityResponse = z.infer<typeof OwnerAvailabilityResponse>;

// ---------------------------------------------------------------------------------------
// Escalations + transcripts (WF-2). Owner session required; values redacted server-side.
//
//   GET /api/owner/escalations[?businessId=]            -> OwnerEscalationsResponse, newest first, max 200
//   GET /api/owner/conversations/:id/transcript          -> OwnerTranscript (404 unknown id)
// ---------------------------------------------------------------------------------------

export const EscalationStatus = z.enum(["open", "resolved"]);

export const OwnerEscalation = z.object({
  /** ESC-XXXX-XXXX */
  ticketRef: z.string(),
  ...BusinessRef,
  createdAt: z.string(),
  /** requested_human | frustration | unresolved | complaint | other */
  reason: z.string(),
  /** Conversation summary with emails, phone numbers and card numbers removed. */
  summary: z.string(),
  /** Contact email the customer chose to share (masked, e.g. "j***@e***.com"), or null. */
  contactEmailMasked: z.string().nullable(),
  /** Open the transcript with /api/owner/conversations/:id/transcript. */
  conversationId: z.string().nullable(),
  status: EscalationStatus,
});
export type OwnerEscalation = z.infer<typeof OwnerEscalation>;
export const OwnerEscalationsResponse = z.object({ items: z.array(OwnerEscalation) });
export type OwnerEscalationsResponse = z.infer<typeof OwnerEscalationsResponse>;

export const OwnerTranscriptMessage = z.object({
  role: z.enum(["user", "assistant"]),
  /** Redacted at storage (cards/SSNs/passwords); emails and phone numbers masked on read. */
  text: z.string(),
  createdAt: z.string(),
});
export const OwnerTranscript = z.object({
  conversationId: z.string(),
  businessName: z.string(),
  /** Oldest first; app events and tool records are omitted. Max 200. */
  messages: z.array(OwnerTranscriptMessage),
});
export type OwnerTranscript = z.infer<typeof OwnerTranscript>;

/** Escalations list + transcript endpoints (kept out of OWNER_ENDPOINTS: not plain tabs). */
export const OWNER_ESCALATIONS_ENDPOINT = {
  path: "/api/owner/escalations",
  schema: OwnerEscalationsResponse,
} as const;
export const ownerTranscriptPath = (conversationId: string) =>
  `/api/owner/conversations/${encodeURIComponent(conversationId)}/transcript`;

export const OWNER_ENDPOINTS = {
  overview: { path: "/api/owner/overview", schema: OwnerOverview },
  orders: { path: "/api/owner/orders", schema: OwnerOrdersResponse },
  bookings: { path: "/api/owner/bookings", schema: OwnerBookingsResponse },
  inventory: { path: "/api/owner/inventory", schema: OwnerInventoryResponse },
  availability: { path: "/api/owner/availability", schema: OwnerAvailabilityResponse },
  notifications: { path: "/api/owner/notifications", schema: OwnerNotificationsResponse },
  conversations: { path: "/api/owner/conversations", schema: OwnerConversationsResponse },
} as const;
export type OwnerTab = keyof typeof OWNER_ENDPOINTS;
