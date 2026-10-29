/**
 * Payment seam (SPEC §4 payments, §5 Payment). Checkout talks to a `PaymentProvider`, never to
 * a payment SDK, so card and Apple Pay support can be added as a new provider without
 * rewriting checkout.
 *
 * Statuses mirror the `Payment.status` column:
 *   not_required — nothing to collect (the only status today, provider "none")
 *   pending      — intent created, the customer still has to act (`nextAction`/`clientSecret`)
 *   authorized   — funds held, not yet captured
 *   captured     — money taken
 *   failed       — declined/errored; checkout must not complete
 */

export type PaymentProviderId = "none" | "stripe" | "apple_pay";

export type PaymentStatus = "not_required" | "pending" | "authorized" | "captured" | "failed";

/** Statuses that let a checkout complete (stock/slot claim + order/booking committed). */
export const SETTLED_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  "not_required",
  "authorized",
  "captured",
];

export interface CreateIntentInput {
  /** Final quote total in cents (server-computed, never from the client). */
  amountCents: number;
  currency: "usd";
  /** Order/booking reference (OAS-XXXX-XXXX); use as the provider idempotency key. */
  reference: string;
  businessId: string;
  /** HMAC of the normalized email (never the raw address) for provider-side metadata. */
  customerEmailHash: string;
}

export interface PaymentIntentResult {
  status: PaymentStatus;
  /** Provider id of the intent/charge (e.g. a Stripe PaymentIntent id). Stored on Payment. */
  providerRef?: string;
  /** Client-side secret for the payment UI (Stripe Payment Element / Payment Request). */
  clientSecret?: string;
  /** Extra customer step (3-D Secure, wallet sheet) the review screen would have to run. */
  nextAction?: { type: string; url?: string };
  /** Customer-safe reason for `failed` (no provider internals). */
  failureMessage?: string;
}

export interface ConfirmPaymentInput {
  providerRef: string;
  amountCents: number;
  reference: string;
}

export interface RefundPaymentInput {
  providerRef: string;
  amountCents: number;
  reference: string;
  reason?: string;
}

export interface RefundResult {
  status: "refunded" | "failed";
  providerRef?: string;
}

export interface PaymentProvider {
  readonly id: PaymentProviderId;
  /** Start (or, for "none", short-circuit) a payment for a checkout. */
  createIntent(input: CreateIntentInput): Promise<PaymentIntentResult>;
  /** Advance a `pending`/`authorized` intent (e.g. capture). May throw PaymentNotSupportedError. */
  confirm(input: ConfirmPaymentInput): Promise<PaymentIntentResult>;
  /** Refund/void a payment. May throw PaymentNotSupportedError. */
  refund(input: RefundPaymentInput): Promise<RefundResult>;
}

/** The provider cannot perform this operation (e.g. refund on the "none" provider). */
export class PaymentNotSupportedError extends Error {
  constructor(provider: PaymentProviderId, operation: string) {
    super(`Payment provider "${provider}" does not support ${operation}.`);
    this.name = "PaymentNotSupportedError";
  }
}

/** PAYMENT_PROVIDER names a provider that does not exist (yet). Raised at startup. */
export class PaymentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentConfigError";
  }
}
