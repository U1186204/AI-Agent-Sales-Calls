/** Pure UI helpers: trace link label (R2-9) and unbreakable email runs (R2-6). */
import { describe, expect, it } from "vitest";
import { countLookups, splitEmails, traceLinkLabel } from "@/ui-lib/format";

describe("trace link label (R2-9)", () => {
  it("counts only tool calls as lookups", () => {
    expect(countLookups([{ kind: "model" }])).toBe(0);
    expect(countLookups([{ kind: "guard" }, { kind: "tool" }, { kind: "tool" }])).toBe(2);
  });
  it("a failed turn (no tool call) never reads '1 lookup'", () => {
    expect(traceLinkLabel(countLookups([{ kind: "model" }]))).toBe("See how it answered");
    expect(traceLinkLabel(1)).toBe("1 lookup: see how it answered");
    expect(traceLinkLabel(2)).toBe("2 lookups: see how it answered");
  });
});

describe("splitEmails (R2-6)", () => {
  it("isolates every email address as one run", () => {
    expect(
      splitEmails("You can also email support@volt-supply.example.com and mention the ticket."),
    ).toEqual([
      { text: "You can also email ", email: false },
      { text: "support@volt-supply.example.com", email: true },
      { text: " and mention the ticket.", email: false },
    ]);
    expect(splitEmails("a@b.co or c.d+e@sub.example.org")).toEqual([
      { text: "a@b.co", email: true },
      { text: " or ", email: false },
      { text: "c.d+e@sub.example.org", email: true },
    ]);
  });
  it("leaves text without addresses (and masked ones) alone", () => {
    expect(splitEmails("No email here.")).toEqual([{ text: "No email here.", email: false }]);
    expect(splitEmails("[email removed]")).toEqual([{ text: "[email removed]", email: false }]);
  });
});
