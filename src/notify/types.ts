/**
 * Notify module types. Route handlers map the domain's confirmCheckout notification payload
 * into `CheckoutNotificationPayload` (all money in integer cents, phone in E.164).
 */
import { z } from "zod";

const cents = z.number().int().min(0);

export const NotificationLine = z.object({
  /** Human label, e.g. "14 AWG THHN wire, 500 ft" or "TV mounting — Standard (up to 65\")". */
  label: z.string().min(1).max(200),
  qty: z.number().int().min(1).optional(),
  /** Line total in cents. */
  amountCents: z.number().int(),
});
export type NotificationLine = z.infer<typeof NotificationLine>;

export const CheckoutNotificationPayload = z.object({
  kind: z.enum(["order", "booking"]),
  businessId: z.string().min(1),
  businessName: z.string().min(1),
  /** `OAS-XXXX-XXXX`. */
  reference: z.string().min(1),
  customer: z.object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    email: z.string().min(3),
    phoneE164: z.string().min(4),
  }),
  business: z.object({
    notifyEmail: z.string().min(3),
    /** E.164; empty/absent → business SMS skipped. */
    notifyPhone: z.string().optional().nullable(),
    supportEmail: z.string().min(3),
  }),
  lines: z.array(NotificationLine).min(1),
  subtotalCents: cents,
  /** Optional; shown when > 0. */
  discountCents: cents.optional(),
  shippingCents: cents,
  taxCents: cents,
  totalCents: cents,
  /** Bookings: label already formatted in the business timezone, e.g. "Tue, Oct 7, 9:00 AM EDT". */
  appointment: z
    .object({ localDateTimeLabel: z.string().min(1), durationMin: z.number().int().min(1) })
    .optional(),
  /** One-line address ("123 Main St, Apt 4, Springfield, IL 62704"). Never sent by SMS. */
  addressLabel: z.string().optional(),
  instructions: z.string().optional(),
});
export type CheckoutNotificationPayload = z.infer<typeof CheckoutNotificationPayload>;

export const EscalationEmailInput = z.object({
  businessId: z.string().min(1),
  businessName: z.string().min(1),
  supportEmail: z.string().min(3),
  ticketRef: z.string().min(1),
  reason: z.string().min(1),
  summary: z.string(),
  /** Customer-provided email for replies; when present it is shown in full and used as Reply-To. */
  contactEmail: z.string().optional(),
});
export type EscalationEmailInput = z.infer<typeof EscalationEmailInput>;

export type Channel = "email" | "sms";
export type Audience = "customer" | "business" | "support";
export type ProviderName = "resend" | "twilio" | "mock";
export type NotificationStatus = "sent" | "failed" | "mocked";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
}

export interface SmsMessage {
  to: string;
  body: string;
}

export interface ProviderResult {
  ok: boolean;
  /** Provider message id (Resend id, Twilio SID, or mock file name). */
  id?: string;
  error?: string;
}

export interface EmailProvider {
  readonly name: "resend" | "mock";
  send(message: EmailMessage, meta: MessageMeta): Promise<ProviderResult>;
}

export interface SmsProvider {
  readonly name: "twilio" | "mock";
  send(message: SmsMessage, meta: MessageMeta): Promise<ProviderResult>;
}

/** Context passed to providers (mock uses it to name/label outbox files). */
export interface MessageMeta {
  businessId: string;
  audience: Audience;
  relatedRef?: string;
}

/** Result of one channel. Never thrown — always returned. */
export interface ChannelResult {
  channel: Channel;
  audience: Audience;
  provider: ProviderName;
  /** `skipped` = no recipient configured (no Notification row written). */
  status: NotificationStatus | "skipped";
  toMasked: string;
  providerMessageId?: string;
  error?: string;
  /** Notification row id, when the log write succeeded. */
  notificationId?: string;
}

export interface CheckoutNotificationResults {
  customerEmail: ChannelResult;
  businessEmail: ChannelResult;
  businessSms: ChannelResult;
}

/** Row written to the Notification table (no PII: masked recipient only, no body). */
export interface NotificationRecord {
  businessId: string;
  channel: Channel;
  audience: Audience;
  provider: ProviderName;
  status: NotificationStatus;
  toMasked: string;
  subject?: string | null;
  relatedRef?: string | null;
  error?: string | null;
}

export interface NotificationStore {
  record(row: NotificationRecord): Promise<{ id: string }>;
}
