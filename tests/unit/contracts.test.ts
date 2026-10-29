import { describe, expect, it } from "vitest";
import {
  BUSINESS_SLUGS,
  ChatRequest,
  CustomerForm,
  normalizeUsPhone,
  OwnerLogin,
  Reference,
  StartCheckoutInput,
  StatusLookup,
  TOOL_NAMES,
  TOOL_SCHEMAS,
  US_STATE_CODES,
  US_STATES,
  US_TERRITORIES,
  zipMatchesState,
  zipStateWarning,
  type CustomerFormInput,
} from "@/contracts";

const valid: CustomerFormInput = {
  firstName: "Jamie",
  lastName: "O'Neil-Smith",
  email: "  Jamie.Test@Example.COM ",
  phone: "(312) 555-0142",
  address1: "123 Example St",
  address2: "",
  city: "St. Louis",
  state: "mo",
  zip: "63101",
  instructions: "Gate code is on the door.\u0007",
};

function parse(overrides: Partial<CustomerFormInput>) {
  return CustomerForm.safeParse({ ...valid, ...overrides });
}

function errorPaths(overrides: Partial<CustomerFormInput>): string[] {
  const r = parse(overrides);
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
}

describe("CustomerForm", () => {
  it("accepts a valid form and normalizes values", () => {
    const r = CustomerForm.parse(valid);
    expect(r.email).toBe("jamie.test@example.com");
    expect(r.phone).toBe("+13125550142");
    expect(r.state).toBe("MO");
    expect(r.address2).toBeUndefined();
    expect(r.instructions).toBe("Gate code is on the door.");
  });

  describe("email", () => {
    it.each(["a@b.co", "first.last+tag@sub.example.org", "X@EXAMPLE.COM"])(
      "accepts %s",
      (email) => {
        expect(parse({ email }).success).toBe(true);
      },
    );
    it.each([
      "",
      "plainaddress",
      "a@b",
      "@example.com",
      "a b@example.com",
      "a@@example.com",
      `${"a".repeat(250)}@x.com`,
    ])("rejects %j", (email) => {
      expect(errorPaths({ email })).toContain("email");
    });
  });

  describe("phone", () => {
    it.each([
      ["3125550142", "+13125550142"],
      ["312-555-0142", "+13125550142"],
      ["(312) 555-0142", "+13125550142"],
      ["312.555.0142", "+13125550142"],
      ["1 312 555 0142", "+13125550142"],
      ["+1 (312) 555-0142", "+13125550142"],
      ["13125550142", "+13125550142"],
    ])("normalizes %s to %s", (input, e164) => {
      expect(normalizeUsPhone(input)).toBe(e164);
      expect(CustomerForm.parse({ ...valid, phone: input }).phone).toBe(e164);
    });
    it.each([
      "",
      "555-0142", // too short
      "312555014", // 9 digits
      "23125550142", // 11 digits not starting with 1
      "0125550142", // area code starts with 0
      "1125550142", // area code starts with 1
      "3120550142", // exchange starts with 0
      "3121550142", // exchange starts with 1
      "312-555-0142 ext 5", // letters
      "+44 20 7946 0958", // non-US
    ])("rejects %j", (phone) => {
      expect(normalizeUsPhone(phone)).toBeNull();
      expect(errorPaths({ phone })).toContain("phone");
    });
  });

  describe("zip", () => {
    it.each([
      ["63101", "MO"],
      ["99501", "AK"],
      ["96813", "HI"],
      ["63101-1234", "MO"],
      ["00901", "PR"],
      ["96910", "GU"],
      ["00802", "VI"],
      ["96799", "AS"],
      ["96950", "MP"],
    ])("accepts %s in %s", (zip, state) => {
      expect(parse({ zip, state }).success).toBe(true);
    });
    it("normalizes a bare 9-digit ZIP to ZIP+4 (ADV-4)", () => {
      const r = parse({ zip: "631011234" });
      expect(r.success && r.data.zip).toBe("63101-1234");
    });
    it.each(["6310", "631011", "63101-123", "63101 1234", "ABCDE", "63101-12345", ""])(
      "rejects %j",
      (zip) => {
        expect(errorPaths({ zip })).toContain("zip");
      },
    );
    it.each(["00000", "00123", "00300", "00399"])("rejects unassigned prefix %s (ADV-3)", (zip) => {
      expect(errorPaths({ zip })).toContain("zip");
    });
    it("accepts prefix 004 as New York (Holtsville IRS ZIPs, R2-8)", () => {
      expect(parse({ zip: "00401", state: "NY" }).success).toBe(true);
      expect(zipStateWarning("00501", "NY")).toBeNull();
      expect(zipStateWarning("00401", "NY")).toBeNull();
    });
    it("never rejects a ZIP/state mismatch: it is a soft review warning (R2-1)", () => {
      for (const [zip, state] of [
        ["90210", "TX"],
        ["99362", "OR"], // Walla Walla area: WA and OR
        ["83120", "ID"], // WY and ID
        ["97635", "CA"], // OR and CA
        ["42223", "TN"], // Fort Campbell: KY and TN
      ] as const) {
        expect(parse({ zip, state }).success).toBe(true);
      }
      expect(zipStateWarning("99362", "OR")).toBe(
        "ZIP 99362 is usually in Washington — double-check your state.",
      );
      expect(zipStateWarning("90210-1234", "tx")).toBe(
        "ZIP 90210 is usually in California — double-check your state.",
      );
      expect(zipStateWarning("83201", "WY")).toBeNull(); // shared prefix lists both states
      expect(zipStateWarning("99362", "WA")).toBeNull();
    });
    it("accepts prefixes that span two states and prefixes missing from the table", () => {
      expect(parse({ zip: "73301", state: "TX" }).success).toBe(true); // Austin IRS (OK range)
      expect(parse({ zip: "05501", state: "MA" }).success).toBe(true); // Andover (VT range)
      expect(zipMatchesState("34001", "NY")).toBe(true); // military AA: not in the table
      expect(zipStateWarning("34001", "NY")).toBeNull();
    });
  });

  describe("state", () => {
    it("has 50 states + DC, plus 5 territories", () => {
      expect(US_STATES).toHaveLength(51);
      expect(new Set(US_STATES).size).toBe(51);
      expect(US_STATES).toContain("DC");
      expect([...US_TERRITORIES].sort()).toEqual(["AS", "GU", "MP", "PR", "VI"]);
      expect(US_STATE_CODES).toHaveLength(56);
    });
    it.each([
      ["CA", "90001"],
      ["ny", "10001"],
      [" tx ", "78701"],
      ["DC", "20001"],
      ["AK", "99501"],
      ["HI", "96813"],
      ["PR", "00901"],
      ["GU", "96910"],
    ])("accepts %j", (state, zip) => {
      expect(parse({ state, zip }).success).toBe(true);
    });
    it.each(["XX", "California", "", "AA"])("rejects %j", (state) => {
      expect(errorPaths({ state })).toContain("state");
    });
  });

  describe("adversarial input (SEC-6, ADV-2, ADV-4)", () => {
    it.each([
      ["address1", "100 Main\nSt"],
      ["address1", "100 Main St\u0000"],
      ["address1", "100 ‮tS niaM"],
      ["address1", "100 Main​ St"],
      ["address2", "Apt 4\r\nBcc: victim@evil.example"],
      ["address2", "Suite ⁦B⁩"],
    ])("rejects control / bidi characters in %s", (field, value) => {
      expect(errorPaths({ [field]: value })).toContain(field);
    });
    it("strips control, bidi and tag characters from instructions but keeps newlines", () => {
      const r = parse({ instructions: "Ring‮ twice\nthen\u0007 wait\u{E0041}" });
      expect(r.success && r.data.instructions).toBe("Ring twice\nthen wait");
    });
    it("asks to remove a phone extension; folds fullwidth digits", () => {
      const r = parse({ phone: "512-555-0123 x123" });
      expect(r.success).toBe(false);
      if (!r.success)
        expect(r.error.issues.find((i) => i.path[0] === "phone")?.message).toMatch(
          /Remove the extension/,
        );
      const fw = parse({ phone: "５１２５５５０１２３" });
      expect(fw.success && fw.data.phone).toBe("+15125550123");
    });
    it("accepts an internationalized email domain as punycode", () => {
      const r = parse({ email: "Jane@Bücher.de" });
      expect(r.success && r.data.email).toBe("jane@xn--bcher-kva.de");
    });
  });

  describe("names, address, instructions", () => {
    it("accepts accented names", () => {
      expect(parse({ firstName: "José", lastName: "Núñez" }).success).toBe(true);
    });
    it.each(["", "J0hn", "<script>", "a".repeat(51), "-Lead"])(
      "rejects first name %j",
      (firstName) => {
        expect(errorPaths({ firstName })).toContain("firstName");
      },
    );
    it("enforces address and city lengths", () => {
      expect(errorPaths({ address1: "" })).toContain("address1");
      expect(errorPaths({ address1: "x".repeat(101) })).toContain("address1");
      expect(errorPaths({ address2: "x".repeat(101) })).toContain("address2");
      expect(errorPaths({ city: "x".repeat(61) })).toContain("city");
      expect(errorPaths({ city: "Springfield 2" })).toContain("city");
    });
    it("limits instructions to 500 chars after stripping control characters", () => {
      expect(parse({ instructions: "x".repeat(500) }).success).toBe(true);
      expect(errorPaths({ instructions: "x".repeat(501) })).toContain("instructions");
      expect(CustomerForm.parse({ ...valid, instructions: "a\u0000b\r\nc" }).instructions).toBe(
        "ab\nc",
      );
      expect(CustomerForm.parse({ ...valid, instructions: "   " }).instructions).toBeUndefined();
    });
  });
});

describe("other contracts", () => {
  it("Reference upper-cases and validates OAS-XXXX-XXXX", () => {
    expect(Reference.parse(" oas-abcd-2345 ")).toBe("OAS-ABCD-2345");
    expect(Reference.safeParse("OAS-ABCD-0000").success).toBe(false); // 0 not in alphabet
    expect(Reference.safeParse("OAS-ABC-2345").success).toBe(false);
  });

  it("StatusLookup normalizes reference + email", () => {
    expect(StatusLookup.parse({ reference: "oas-wxyz-2345", email: "A@B.CO" })).toEqual({
      reference: "OAS-WXYZ-2345",
      email: "a@b.co",
    });
  });

  it("OwnerLogin requires both fields", () => {
    expect(OwnerLogin.safeParse({ username: "owner", password: "" }).success).toBe(false);
    expect(OwnerLogin.safeParse({ username: "owner", password: "x" }).success).toBe(true);
  });

  it("ChatRequest needs a message or an event and a known business", () => {
    expect(ChatRequest.safeParse({ businessId: "volt-supply", message: "hi" }).success).toBe(true);
    expect(ChatRequest.safeParse({ businessId: "volt-supply", message: "  " }).success).toBe(false);
    expect(ChatRequest.safeParse({ businessId: "acme", message: "hi" }).success).toBe(false);
    expect(
      ChatRequest.safeParse({
        businessId: "mountpro-tv",
        conversationId: "c1",
        event: { type: "checkout_completed", draftId: "d1", reference: "OAS-ABCD-2345" },
      }).success,
    ).toBe(true);
  });

  it("every tool has input/output schemas and requires a reason", () => {
    expect(Object.keys(TOOL_SCHEMAS).sort()).toEqual([...TOOL_NAMES].sort());
    const minimal: Record<string, unknown> = {
      search_catalog: {},
      get_product: { sku: "EL-GFCI-20" },
      check_inventory: { items: [{ sku: "EL-GFCI-20", qty: 1 }] },
      quote_products: { lines: [{ sku: "EL-GFCI-20", qty: 1 }] },
      list_services: {},
      quote_service: { serviceCode: "tv-mounting", tierCode: "L" },
      check_availability: { serviceCode: "tv-mounting" },
      check_service_area: { zip: "80202" },
      get_policies: {},
      start_checkout: { kind: "product", lines: [{ sku: "EL-GFCI-20", qty: 1 }] },
      lookup_status: { reference: "OAS-ABCD-2345", email: "a@b.co" },
      escalate_to_support: { category: "requested_human", summary: "Customer wants a person." },
    };
    for (const name of TOOL_NAMES) {
      const schema = TOOL_SCHEMAS[name].input;
      expect(schema.safeParse(minimal[name]).success, `${name} without reason`).toBe(false);
      expect(
        schema.safeParse({ ...(minimal[name] as object), reason: "Customer asked." }).success,
        `${name} with reason`,
      ).toBe(true);
    }
  });

  it("start_checkout never accepts PII fields", () => {
    const r = StartCheckoutInput.parse({
      reason: "Ready to buy",
      kind: "product",
      lines: [{ sku: "el-gfci-20", qty: 2 }],
      email: "a@b.co",
    } as unknown);
    expect(r).not.toHaveProperty("email");
    if (r.kind === "product") expect(r.lines[0]?.sku).toBe("EL-GFCI-20");
  });

  it("contract business slugs list all five businesses", () => {
    expect(BUSINESS_SLUGS).toHaveLength(5);
  });
});
