import { describe, expect, it } from "vitest";
import { enforceReferences, knownReferences } from "@/agent/runner";

describe("reference hallucination guard", () => {
  const confirmed = { kind: "order" as const, reference: "OAS-8HGW-LGR4" };

  it("corrects a mistyped reference after a confirmed checkout", () => {
    const known = knownReferences("checkout_completed ... Reference OAS-8HGW-LGR4.", confirmed);
    const out = enforceReferences("Order reference: **OAS-8HGW-LGW4**", known, confirmed);
    expect(out).toContain("OAS-8HGW-LGR4");
    expect(out).not.toContain("OAS-8HGW-LGW4");
  });

  it("prepends the real reference when the model left it out", () => {
    const known = knownReferences("", confirmed);
    const out = enforceReferences("Here's what to expect: ships tomorrow.", known, confirmed);
    expect(out.startsWith("Your order is confirmed. Reference: OAS-8HGW-LGR4.")).toBe(true);
  });

  it("keeps references the model saw (history, tool results, customer text)", () => {
    const known = knownReferences('{"reference":"OAS-AAAA-2222"} customer typed OAS-ZZZZ-9999');
    const out = enforceReferences("OAS-AAAA-2222 is confirmed; OAS-ZZZZ-9999 not found.", known);
    expect(out).toBe("OAS-AAAA-2222 is confirmed; OAS-ZZZZ-9999 not found.");
  });

  it("removes an invented reference when several are known", () => {
    const known = knownReferences("OAS-AAAA-2222 OAS-BBBB-3333");
    const out = enforceReferences("Your order OAS-CCCC-4444 shipped.", known);
    expect(out).toBe("Your order your reference number shipped.");
  });

  it("leaves replies without references untouched", () => {
    expect(enforceReferences("We ship anywhere in the US.", new Set())).toBe(
      "We ship anywhere in the US.",
    );
  });
});
