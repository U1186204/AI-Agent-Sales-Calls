/**
 * Default provider: no payment is taken online (businesses collect on delivery/site).
 * No network, no state. createIntent always returns `not_required`, which checkout records as
 * Payment{provider:"none", status:"not_required"}.
 */
import {
  PaymentNotSupportedError,
  type ConfirmPaymentInput,
  type CreateIntentInput,
  type PaymentIntentResult,
  type PaymentProvider,
  type RefundPaymentInput,
  type RefundResult,
} from "./types";

export class NoPaymentProvider implements PaymentProvider {
  readonly id = "none" as const;

  async createIntent(_input: CreateIntentInput): Promise<PaymentIntentResult> {
    return { status: "not_required" };
  }

  async confirm(_input: ConfirmPaymentInput): Promise<PaymentIntentResult> {
    throw new PaymentNotSupportedError(this.id, "confirm");
  }

  async refund(_input: RefundPaymentInput): Promise<RefundResult> {
    throw new PaymentNotSupportedError(this.id, "refund");
  }
}
