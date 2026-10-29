/** Payment seam: provider factory + the "none" provider (no network). */
import { describe, expect, it } from "vitest";
import { parseEnv } from "@/config/env";
import {
  getPaymentProvider,
  NoPaymentProvider,
  PaymentConfigError,
  PaymentNotSupportedError,
} from "@/payments";

describe("getPaymentProvider", () => {
  it("defaults to the none provider (unset, blank, any case)", () => {
    expect(getPaymentProvider({}).id).toBe("none");
    expect(getPaymentProvider({ PAYMENT_PROVIDER: "  " }).id).toBe("none");
    expect(getPaymentProvider({ PAYMENT_PROVIDER: "NONE" })).toBeInstanceOf(NoPaymentProvider);
    expect(getPaymentProvider(parseEnv({})).id).toBe("none");
  });

  it("rejects any other provider with a clear not-implemented error", () => {
    for (const value of ["stripe", "apple_pay", "paypal"]) {
      expect(() => getPaymentProvider({ PAYMENT_PROVIDER: value })).toThrow(PaymentConfigError);
      expect(() => getPaymentProvider({ PAYMENT_PROVIDER: value })).toThrow(
        new RegExp(`PAYMENT_PROVIDER="${value}" is not implemented yet`),
      );
    }
  });

  it("env parses PAYMENT_PROVIDER with default none, normalized", () => {
    expect(parseEnv({}).PAYMENT_PROVIDER).toBe("none");
    expect(parseEnv({ PAYMENT_PROVIDER: " Stripe " }).PAYMENT_PROVIDER).toBe("stripe");
  });
});

describe("NoPaymentProvider", () => {
  const p = new NoPaymentProvider();

  it("createIntent returns not_required with no provider ref", async () => {
    await expect(
      p.createIntent({
        amountCents: 1234,
        currency: "usd",
        reference: "OAS-2222-2222",
        businessId: "volt-supply",
        customerEmailHash: "h",
      }),
    ).resolves.toEqual({ status: "not_required" });
  });

  it("confirm and refund are not supported", async () => {
    const ref = { providerRef: "x", amountCents: 1, reference: "OAS-2222-2222" };
    await expect(p.confirm(ref)).rejects.toBeInstanceOf(PaymentNotSupportedError);
    await expect(p.refund(ref)).rejects.toBeInstanceOf(PaymentNotSupportedError);
  });
});
