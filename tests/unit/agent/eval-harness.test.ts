/**
 * Smoke test of the eval harness plumbing (no real LLM): a scripted fake model drives the
 * happy-path Volt order case through form simulation, confirm, notifications and the
 * checkout_completed event, so `npm run eval` failures point at the model, not the harness.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Harness, asksForPii, moneyRe, zipAsks, type Shared } from "../../../evals/harness";
import { happyPathCases } from "../../../evals/cases/happy-path";
import { ALL_CASES } from "../../../evals/cases";
import { hardeningCases } from "../../../evals/cases/hardening";
import { setupTestDb, type TestDb } from "../domain/support/test-db";
import { fakeClient, fakeNotify, text, toolUse } from "./support/fake-llm";

let t: TestDb;
beforeAll(async () => {
  t = await setupTestDb("eval-harness");
}, 120_000);
afterAll(async () => {
  await t?.cleanup();
});

function lastCustomerText(params: Anthropic.MessageCreateParamsNonStreaming): string {
  for (let i = params.messages.length - 1; i >= 0; i--) {
    const m = params.messages[i]!;
    if (m.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}

describe("eval harness", () => {
  it("has ≥30 uniquely named cases covering every SPEC §10 category", () => {
    expect(ALL_CASES.length).toBeGreaterThanOrEqual(53);
    for (const id of [
      "inject-fake-system-event-tags",
      "inject-surfaces-after-11-turns",
      "inject-tool-result-description",
      "escalation-spam",
      "checkout-no-pii-no-foreign-sku",
      "cost-inflation-long-message",
      "inject-canary-spelled-out",
      "request-human-event",
      "onsite-estimate-long-job",
      "territory-order-pr",
    ]) {
      expect(ALL_CASES.some((c) => c.id === id)).toBe(true);
    }
    const cats = new Set(ALL_CASES.map((c) => c.category));
    for (const c of [
      "happy_path",
      "mid_flow_question",
      "stock",
      "availability",
      "form_validation",
      "pii",
      "corrections",
      "status_lookup",
      "injection",
      "off_topic",
      "shipping",
      "escalation",
      "resilience",
      "isolation",
    ]) {
      expect(cats.has(c as never)).toBe(true);
    }
    const happyBiz = new Set(
      ALL_CASES.filter((c) => c.category === "happy_path").map((c) => c.business),
    );
    expect(happyBiz.size).toBe(5);
    expect(ALL_CASES.some((c) => c.id === "midflow-fireplace-why")).toBe(true);
  });

  it("runs the happy-volt-order case end to end with a scripted model", async () => {
    const llm = fakeClient((params) => {
      const lastMsg = params.messages.at(-1)!;
      const afterTool = Array.isArray(lastMsg.content);
      const said = lastCustomerText(params);
      if (said.includes("checkout_completed")) {
        const ref = said.match(/OAS-[A-Z0-9]{4}-[A-Z0-9]{4}/)?.[0] ?? "?";
        return text(
          `Your order ${ref} is confirmed. Orders placed by 2 pm Eastern ship the same day.`,
        );
      }
      if (said.includes("order 4")) {
        return afterTool
          ? text("Your secure checkout form is ready below.")
          : toolUse("start_checkout", {
              reason: "Open the secure form",
              kind: "product",
              lines: [{ sku: "EL-REC-20TR", qty: 4 }],
            });
      }
      return afterTool
        ? text("The EL-REC-20TR outlet is $3.80 each and in stock.")
        : toolUse("get_product", { reason: "Check price and stock", sku: "EL-REC-20TR" });
    });
    // Fake providers, but log rows into the test DB (the case asserts on the Notification table).
    const notify = fakeNotify();
    const record = notify.store!.record.bind(notify.store);
    notify.store = {
      async record(row) {
        await record(row);
        return t.prisma.notification.create({ data: row, select: { id: true } });
      },
    };
    const shared: Shared = {
      prisma: t.prisma,
      dates: t.dates,
      judgeClient: null as never,
      model: "claude-haiku-4-5",
      llm,
      notifyDeps: notify,
    };
    const c = happyPathCases.find((x) => x.id === "happy-volt-order")!;
    const h = new Harness(c, shared);
    await c.run(h);
    h.finalizeAutoChecks();
    const failed = h.results.filter((r) => !r.pass);
    expect(failed).toEqual([]);
    expect(h.results.length).toBeGreaterThan(8);
    expect(notify.rows.map((r) => `${r.channel}:${r.audience}`).sort()).toEqual([
      "email:business",
      "email:customer",
      "sms:business",
    ]);
  });

  it("runs the LLM-free request-human-event case end to end (no model call)", async () => {
    const notify = fakeNotify();
    notify.store = {
      async record(row) {
        return t.prisma.notification.create({ data: row, select: { id: true } });
      },
    };
    const shared: Shared = {
      prisma: t.prisma,
      dates: t.dates,
      judgeClient: null as never,
      model: "claude-haiku-4-5",
      llm: fakeClient(new Error("the model must not be called")),
      notifyDeps: notify,
    };
    const c = hardeningCases.find((x) => x.id === "request-human-event")!;
    const h = new Harness(c, shared);
    await c.run(h);
    h.finalizeAutoChecks();
    expect(h.results.filter((r) => !r.pass)).toEqual([]);
  });

  it("helpers: money regex and PII-ask detector", () => {
    expect(moneyRe(65785).test("Total: $657.85")).toBe(true);
    expect(moneyRe(123456).test("$1,234.56")).toBe(true);
    expect(moneyRe(12900).test("It's $129 before tax")).toBe(true);
    expect(moneyRe(12900).test("$1290")).toBe(false);
    expect(asksForPii("What's your email address?", false)).toBeTruthy();
    expect(asksForPii("Please share your phone number so we can call.", false)).toBeTruthy();
    expect(asksForPii("You'll enter your address in the secure form below.", false)).toBeNull();
    expect(
      asksForPii("I'll need your email used at checkout and the order reference.", true),
    ).toBeNull();
    expect(asksForPii("What's your ZIP code so I can quote shipping?", false)).toBeNull();
    expect(zipAsks(["What's your ZIP?", "Thanks. Ready to check out?", "And your ZIP code?"])).toBe(
      2,
    );
    expect(zipAsks(["Shipping to ZIP 75201 is $11.40."])).toBe(0);
  });
});
