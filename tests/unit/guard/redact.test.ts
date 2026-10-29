import { describe, expect, it } from "vitest";
import {
  luhnValid,
  maskAddress,
  maskDeep,
  maskEmail,
  maskName,
  maskPhone,
  maskZip,
  redactSensitive,
  shortName,
} from "@/guard/redact";

describe("luhnValid", () => {
  it.each(["4111111111111111", "5555555555554444", "378282246310005", "6011111111111117"])(
    "accepts %s",
    (n) => expect(luhnValid(n)).toBe(true),
  );
  it.each(["4111111111111112", "1234567890123", "abc"])("rejects %s", (n) =>
    expect(luhnValid(n)).toBe(false),
  );
});

describe("redactSensitive — cards", () => {
  it.each([
    ["plain", "my card is 4111111111111111 thanks"],
    ["spaced", "my card is 4111 1111 1111 1111 thanks"],
    ["dashed", "my card is 4111-1111-1111-1111 thanks"],
    ["amex 4-6-5", "card 3782 822463 10005 thanks"],
    ["mixed separators", "card 5555-5555 5555-4444 thanks"],
  ])("redacts a Luhn-valid %s card number", (_label, input) => {
    const r = redactSensitive(input);
    expect(r.text).toContain("[card number removed]");
    expect(r.text).not.toMatch(/\d{4}/);
    expect(r.text.endsWith(" thanks")).toBe(true);
    expect(r.redactions).toEqual(["card"]);
  });

  it("leaves non-Luhn digit runs alone", () => {
    const input = "order 4111 1111 1111 1112 and tracking 1234567890123";
    const r = redactSensitive(input);
    expect(r.text).toBe(input);
    expect(r.redactions).toEqual([]);
  });

  it("leaves phone numbers, ZIPs, quantities and references alone", () => {
    const input = "Call (317) 555-0199 or 317-555-0199, ZIP 46241-1234, qty 12, ref OAS-7K2M-Q9XD";
    expect(redactSensitive(input)).toEqual({ text: input, redactions: [] });
  });

  it("does not match inside a longer digit run (>19 digits)", () => {
    const input = "id 41111111111111111111111";
    expect(redactSensitive(input).text).toBe(input);
  });

  it("redacts multiple cards and keeps order", () => {
    const r = redactSensitive("a 4111111111111111 b 5555 5555 5555 4444");
    expect(r.text).toBe("a [card number removed] b [card number removed]");
    expect(r.redactions).toEqual(["card", "card"]);
  });
});

describe("redactSensitive — SSN", () => {
  it("redacts dashed and spaced SSNs", () => {
    expect(redactSensitive("ssn 123-45-6789.").text).toBe("ssn [SSN removed].");
    expect(redactSensitive("it's 123 45 6789").text).toBe("it's [SSN removed]");
  });
  it("redacts bare 9 digits only with SSN context", () => {
    expect(redactSensitive("my social security number is 123456789").text).toBe(
      "my social security number is [SSN removed]",
    );
    expect(redactSensitive("SSN: 123456789").redactions).toEqual(["ssn"]);
    expect(redactSensitive("part number 123456789").text).toBe("part number 123456789");
  });
  it("ignores invalid SSN areas", () => {
    expect(redactSensitive("000-12-3456").redactions).toEqual([]);
    expect(redactSensitive("666-12-3456").redactions).toEqual([]);
  });
});

describe("redactSensitive — passwords", () => {
  it.each([
    ["my password is hunter2", "my password is [password removed]"],
    ["password: s3cr3t!", "password: [password removed]"],
    ["pw: abc123 ok", "pw: [password removed] ok"],
    ["Password = 'two words'", "Password = [password removed]"],
  ])("%s", (input, expected) => {
    const r = redactSensitive(input);
    expect(r.text).toBe(expected);
    expect(r.redactions).toEqual(["password"]);
  });
  it("does not redact the word password used normally", () => {
    const input = "I forgot my password and need help";
    expect(redactSensitive(input).text).toBe(input);
  });
});

describe("mask helpers", () => {
  it("maskEmail", () => {
    expect(maskEmail("jane.doe@example.com")).toBe("j***@e***.com");
    expect(maskEmail("bad")).toBe("***");
  });
  it("maskPhone", () => {
    expect(maskPhone("+13175550199")).toBe("***-***-0199");
    expect(maskPhone("(317) 555-0199")).toBe("***-***-0199");
  });
  it("maskName / shortName", () => {
    expect(maskName("Jane")).toBe("J.");
    expect(maskName("jane doe")).toBe("J. D.");
    expect(shortName("Jane", "Doe")).toBe("Jane D.");
  });
  it("maskAddress / maskZip", () => {
    expect(maskAddress("123 Main St")).toBe("[address hidden]");
    expect(maskZip("46241-1234")).toBe("462**");
  });
  it("maskDeep masks known PII keys and redacts free text, without mutating input", () => {
    const input = {
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      phone: "+13175550199",
      address1: "123 Main St",
      address2: "Apt 4",
      city: "Indianapolis",
      zip: "46241",
      sku: "WIRE-14-500",
      nested: [{ contactEmail: "x@y.io", note: "card 4111 1111 1111 1111" }],
    };
    const out = maskDeep(input);
    expect(out).toEqual({
      firstName: "J.",
      lastName: "D.",
      email: "j***@e***.com",
      phone: "***-***-0199",
      address1: "[address hidden]",
      address2: "[address hidden]",
      city: "Indianapolis",
      zip: "462**",
      sku: "WIRE-14-500",
      nested: [{ contactEmail: "x***@y***.io", note: "card [card number removed]" }],
    });
    expect(input.email).toBe("jane@example.com");
  });
  it("maskDeep handles cycles", () => {
    const a: Record<string, unknown> = { email: "a@b.co" };
    a.self = a;
    expect(maskDeep(a)).toEqual({ email: "a***@b***.co", self: "[circular]" });
  });
});
