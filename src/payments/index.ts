/**
 * Payments public API (SPEC §4). No payment is processed yet; this module is the seam that
 * keeps checkout unchanged when one is added.
 *
 *   getPaymentProvider(env?) → PaymentProvider   (selected by PAYMENT_PROVIDER, default "none")
 *
 * Extension points (not implemented):
 * - Stripe provider (src/payments/stripe.ts): one provider covers cards AND Apple Pay — Apple
 *   Pay/Google Pay arrive through Stripe's Payment Request Button / Payment Element as an
 *   ordinary card PaymentMethod, so "apple_pay" would map to the same implementation with
 *   wallet-only UI. createIntent → PaymentIntent (amount, currency, metadata{reference,
 *   businessId, customerEmailHash}, idempotency key = reference) returning `clientSecret`.
 * - Checkout review step (src/components/checkout): would mount the Payment Element with that
 *   `clientSecret` and collect/confirm the payment method client-side; card data never
 *   touches this server.
 * - confirm: would need a pending → authorized/captured flow. The order/booking is created
 *   with Payment.status "pending" (or after authorization), and a webhook route
 *   (src/app/api/payments/webhook/route.ts, signature-verified) moves it to
 *   authorized/captured/failed. A network provider should create the intent at review time,
 *   outside the confirm DB transaction, so the transaction only verifies the intent.
 * - refund: owner-initiated cancellations; confirmCheckout already calls it best-effort to
 *   void an authorized/captured payment when the transaction then rolls back.
 */
import { getEnv } from "@/config/env";
import { NoPaymentProvider } from "./none";
import { PaymentConfigError, type PaymentProvider } from "./types";

export { NoPaymentProvider } from "./none";
export { PaymentConfigError, PaymentNotSupportedError, SETTLED_PAYMENT_STATUSES } from "./types";
export type {
  ConfirmPaymentInput,
  CreateIntentInput,
  PaymentIntentResult,
  PaymentProvider,
  PaymentProviderId,
  PaymentStatus,
  RefundPaymentInput,
  RefundResult,
} from "./types";

/** Values PAYMENT_PROVIDER may take today. Add "stripe" here once src/payments/stripe.ts exists. */
export const IMPLEMENTED_PAYMENT_PROVIDERS = ["none"] as const;

/** Error text for a PAYMENT_PROVIDER value that has no implementation. */
export function paymentProviderNotImplemented(value: string): string {
  return (
    `PAYMENT_PROVIDER="${value}" is not implemented yet. Only "none" is supported ` +
    `(no online payment); card/Apple Pay providers plug in at src/payments/index.ts.`
  );
}

const none = new NoPaymentProvider();

/**
 * The configured provider. `env` defaults to the validated app env; pass `{}` or a raw object
 * in tests. Any value other than "none" (case-insensitive, blank = "none") throws
 * PaymentConfigError.
 */
export function getPaymentProvider(env: { PAYMENT_PROVIDER?: string } = getEnv()): PaymentProvider {
  const value = (env.PAYMENT_PROVIDER ?? "").trim().toLowerCase() || "none";
  switch (value) {
    case "none":
      return none;
    // case "stripe": case "apple_pay": return new StripePaymentProvider(...);
    default:
      throw new PaymentConfigError(paymentProviderNotImplemented(value));
  }
}
