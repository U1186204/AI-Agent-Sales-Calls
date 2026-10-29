/**
 * Notify public API (SPEC §2 AT-51/AT-52).
 *
 *   dispatchCheckoutNotifications(payload)  → { customerEmail, businessEmail, businessSms }
 *   sendEscalationEmail(input)              → ChannelResult
 *
 * Every attempt (real or mock) writes one `Notification` row: masked recipient, provider,
 * status sent|failed|mocked, subject, relatedRef, error — never the full address/number or
 * the message body. Nothing here throws to the caller; each channel returns a result.
 * Route handlers map the domain's confirmCheckout payload into `CheckoutNotificationPayload`.
 */
import { getEnv } from "@/config/env";
import { logger } from "@/guard/logger";
import { maskEmail, maskPhone } from "@/guard/redact";
import { defaultEmailProvider, defaultSmsProvider, safeError } from "./providers";
import {
  businessNewCheckoutEmail,
  businessSms,
  customerConfirmationEmail,
  escalationEmail,
} from "./templates";
import { CheckoutNotificationPayload, EscalationEmailInput } from "./types";
import type {
  Audience,
  ChannelResult,
  CheckoutNotificationResults,
  EmailMessage,
  EmailProvider,
  NotificationRecord,
  NotificationStore,
  SmsProvider,
} from "./types";

export * from "./types";
export { escapeHtml, formatCents } from "./templates";

export interface NotifyDeps {
  email?: EmailProvider;
  sms?: SmsProvider;
  store?: NotificationStore;
  appUrl?: string;
}

/** Writes through `getPrisma()` so the unit-test DB override applies here too. */
export const prismaNotificationStore: NotificationStore = {
  async record(row) {
    const { getPrisma } = await import("@/db");
    const created = await getPrisma().notification.create({
      data: {
        businessId: row.businessId,
        channel: row.channel,
        audience: row.audience,
        provider: row.provider,
        status: row.status,
        toMasked: row.toMasked,
        subject: row.subject ?? null,
        relatedRef: row.relatedRef ?? null,
        error: row.error ?? null,
      },
      select: { id: true },
    });
    return created;
  },
};

async function logRow(
  store: NotificationStore,
  row: NotificationRecord,
): Promise<string | undefined> {
  try {
    return (await store.record(row)).id;
  } catch (err) {
    logger.error("notification_log_failed", {
      channel: row.channel,
      audience: row.audience,
      relatedRef: row.relatedRef,
      error: safeError(err),
    });
    return undefined;
  }
}

async function sendEmail(
  provider: EmailProvider,
  store: NotificationStore,
  businessId: string,
  audience: Audience,
  relatedRef: string,
  message: EmailMessage,
): Promise<ChannelResult> {
  const toMasked = maskEmail(message.to);
  let status: ChannelResult["status"];
  let error: string | undefined;
  let id: string | undefined;
  try {
    const r = await provider.send(message, { businessId, audience, relatedRef });
    status = r.ok ? (provider.name === "mock" ? "mocked" : "sent") : "failed";
    error = r.ok ? undefined : r.error;
    id = r.id;
  } catch (err) {
    status = "failed";
    error = safeError(err);
  }
  const notificationId = await logRow(store, {
    businessId,
    channel: "email",
    audience,
    provider: provider.name,
    status,
    toMasked,
    subject: message.subject,
    relatedRef,
    error,
  });
  if (status === "failed")
    logger.warn("notify_failed", { channel: "email", audience, relatedRef, error });
  return {
    channel: "email",
    audience,
    provider: provider.name,
    status,
    toMasked,
    providerMessageId: id,
    error,
    notificationId,
  };
}

async function sendSms(
  provider: SmsProvider,
  store: NotificationStore,
  businessId: string,
  audience: Audience,
  relatedRef: string,
  to: string | null | undefined,
  body: string,
): Promise<ChannelResult> {
  if (!to || !to.trim()) {
    return { channel: "sms", audience, provider: provider.name, status: "skipped", toMasked: "" };
  }
  const toMasked = maskPhone(to);
  let status: ChannelResult["status"];
  let error: string | undefined;
  let id: string | undefined;
  try {
    const r = await provider.send({ to, body }, { businessId, audience, relatedRef });
    status = r.ok ? (provider.name === "mock" ? "mocked" : "sent") : "failed";
    error = r.ok ? undefined : r.error;
    id = r.id;
  } catch (err) {
    status = "failed";
    error = safeError(err);
  }
  const notificationId = await logRow(store, {
    businessId,
    channel: "sms",
    audience,
    provider: provider.name,
    status,
    toMasked,
    subject: null,
    relatedRef,
    error,
  });
  if (status === "failed")
    logger.warn("notify_failed", { channel: "sms", audience, relatedRef, error });
  return {
    channel: "sms",
    audience,
    provider: provider.name,
    status,
    toMasked,
    providerMessageId: id,
    error,
    notificationId,
  };
}

function failedResult(channel: "email" | "sms", audience: Audience, error: string): ChannelResult {
  return { channel, audience, provider: "mock", status: "failed", toMasked: "", error };
}

/** Customer confirmation email + business email + business SMS, sent in parallel. */
export async function dispatchCheckoutNotifications(
  payload: CheckoutNotificationPayload,
  deps: NotifyDeps = {},
): Promise<CheckoutNotificationResults> {
  try {
    const pl = CheckoutNotificationPayload.parse(payload);
    const email = deps.email ?? defaultEmailProvider();
    const sms = deps.sms ?? defaultSmsProvider();
    const store = deps.store ?? prismaNotificationStore;
    const appUrl = deps.appUrl ?? getEnv().APP_URL;
    const ref = pl.reference;

    const [customerEmail, businessEmail, businessSmsRes] = await Promise.all([
      sendEmail(email, store, pl.businessId, "customer", ref, {
        to: pl.customer.email,
        ...customerConfirmationEmail(pl, appUrl),
      }),
      sendEmail(email, store, pl.businessId, "business", ref, {
        to: pl.business.notifyEmail,
        ...businessNewCheckoutEmail(pl),
      }),
      sendSms(sms, store, pl.businessId, "business", ref, pl.business.notifyPhone, businessSms(pl)),
    ]);
    return { customerEmail, businessEmail, businessSms: businessSmsRes };
  } catch (err) {
    const error = safeError(err);
    logger.error("notify_dispatch_failed", { error });
    return {
      customerEmail: failedResult("email", "customer", error),
      businessEmail: failedResult("email", "business", error),
      businessSms: failedResult("sms", "business", error),
    };
  }
}

/** Support escalation email to the business's support address. */
export async function sendEscalationEmail(
  input: EscalationEmailInput,
  deps: NotifyDeps = {},
): Promise<ChannelResult> {
  try {
    const data = EscalationEmailInput.parse(input);
    const email = deps.email ?? defaultEmailProvider();
    const store = deps.store ?? prismaNotificationStore;
    return await sendEmail(email, store, data.businessId, "support", data.ticketRef, {
      to: data.supportEmail,
      ...escalationEmail(data),
    });
  } catch (err) {
    const error = safeError(err);
    logger.error("notify_escalation_failed", { error });
    return failedResult("email", "support", error);
  }
}
