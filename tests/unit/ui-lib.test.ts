/** Pure UI helpers: trace link label (R2-9) and unbreakable email runs (R2-6). */
import { describe, expect, it } from "vitest";
import {
  countLookups,
  splitEmails,
  traceLinkLabel,
  traceSummaryLabel,
  usageTotals,
} from "@/ui-lib/format";

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

describe("trace summary line", () => {
  const tool = { kind: "tool", ok: true, ms: 40 };
  const model = { kind: "model", ok: true, ms: 1860 };
  const guard = { kind: "guard", ok: true, ms: 1 };

  it("counts completed steps and adds up their time", () => {
    expect(traceSummaryLabel([tool, tool, model])).toBe("3 steps completed · 1.9 s");
    expect(traceSummaryLabel([tool])).toBe("1 step completed · 40 ms");
  });
  it("says so when a step failed", () => {
    expect(traceSummaryLabel([tool, { ...tool, ok: false }, model])).toBe(
      "1 of 3 steps failed · 1.9 s",
    );
    expect(traceSummaryLabel([{ ...guard, ok: false }])).toBe("1 step failed · 1 ms");
  });
  it("never calls a guard a completed step", () => {
    expect(traceSummaryLabel([guard, model])).toBe("1 step completed · 1 safety check · 1.9 s");
    expect(traceSummaryLabel([guard])).toBe("1 safety check · 1 ms");
  });
  it("leaves out a time it doesn't have", () => {
    expect(traceSummaryLabel([{ ...tool, ms: 0 }])).toBe("1 step completed");
  });
});

describe("conversation usage totals", () => {
  const a = { model: "haiku", inputTokens: 100, outputTokens: 10, costUsd: 0.001 };
  const b = { model: "sonnet", inputTokens: 200, outputTokens: 20, costUsd: 0.002 };

  it("adds up replies and lists each model once", () => {
    const t = usageTotals([a, b, a]);
    expect(t).toMatchObject({ replies: 3, reported: 3, inputTokens: 400, outputTokens: 40 });
    expect(t?.costUsd).toBeCloseTo(0.004);
    expect(t?.models).toEqual(["haiku", "sonnet"]);
  });
  it("replies without usage add nothing but stay counted", () => {
    expect(usageTotals([a, undefined])).toMatchObject({
      replies: 2,
      reported: 1,
      inputTokens: 100,
      costUsd: 0.001,
    });
  });
  it("is null when no reply reported usage", () => {
    expect(usageTotals([])).toBeNull();
    expect(usageTotals([undefined])).toBeNull();
  });
});
