/**
 * Concise replies: drafts written before the last lookup are merged without what the final
 * answer repeats, lookup narration is dropped, and long replies are logged (never truncated).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createConversation } from "@/domain";
import { runTurn } from "@/agent";
import { LONG_REPLY_WORDS, mergeDrafts, stripNarration } from "@/agent/runner";
import { setLogSink } from "@/guard/logger";
import { setupTestDb, type TestDb } from "../domain/support/test-db";
import { fakeClient, message, text } from "./support/fake-llm";

let t: TestDb;
let logs: string[] = [];
beforeAll(async () => {
  t = await setupTestDb("agent-concise");
}, 120_000);
afterAll(async () => {
  await t?.cleanup();
});
beforeEach(() => {
  logs = [];
  setLogSink((l) => logs.push(l));
});
afterEach(() => setLogSink());

const lookup = (draft: string) =>
  message([
    { type: "text", text: draft },
    {
      type: "tool_use",
      name: "get_product",
      input: { reason: "Look up the breaker", sku: "EL-BRK-1P20" },
    },
  ]);

async function reply(client: ReturnType<typeof fakeClient>) {
  const c = await createConversation("volt-supply");
  return runTurn(
    { conversationId: c.id, userText: "breaker price?", reqId: "test-concise" },
    {
      client,
    },
  );
}

describe("stripNarration", () => {
  it("drops sentences that only announce a lookup, keeps real content", () => {
    expect(stripNarration("I'll check our stock for 12/2 Romex.")).toBe("");
    expect(stripNarration("Now let me get the exact price for a 3-bedroom deep clean:")).toBe("");
    expect(stripNarration("Sure, let me look. Your order OAS-2345-6789 is confirmed.")).toBe(
      "Your order OAS-2345-6789 is confirmed.",
    );
    expect(stripNarration("Yes, we carry it. Let me check the price.")).toBe("Yes, we carry it.");
    expect(stripNarration("Lettuce is not sold here.")).toBe("Lettuce is not sold here.");
  });
});

describe("mergeDrafts", () => {
  it("drops draft sentences the final answer repeats (same prices, or mostly the same words)", () => {
    // real eval transcripts that said the same thing twice
    expect(
      mergeDrafts(
        ['A 65" TV falls into our Large tier. The base mounting starts at **$169** before tax.'],
        'For a 65" TV, the base mounting is **$169.00** (about 1 hr 15 min).',
      ),
    ).toBe(
      'A 65" TV falls into our Large tier.\n\nFor a 65" TV, the base mounting is **$169.00** (about 1 hr 15 min).',
    );
    expect(
      mergeDrafts(
        ["Yes, we offer weekly service! For a quarter-acre lawn it's **$49.50** per visit."],
        "Perfect! Weekly service for your quarter-acre lawn is **$49.50** per visit.",
      ),
    ).toBe("Perfect! Weekly service for your quarter-acre lawn is **$49.50** per visit.");
  });

  it("keeps a distinct answer written before opening checkout (rule 3)", () => {
    expect(
      mergeDrafts(
        ["Our return policy allows returns of unused items within 30 days."],
        "Your secure order form is ready below.",
      ),
    ).toBe(
      "Our return policy allows returns of unused items within 30 days.\n\nYour secure order form is ready below.",
    );
  });
});

describe("reply assembly", () => {
  it("drops narration and the repeated draft, keeps the final answer", async () => {
    const r = await reply(
      fakeClient(
        lookup("Let me check that breaker. It's $9.50."),
        text("The 20 A single-pole breaker is $9.50 and in stock."),
      ),
    );
    expect(r.replyText).toBe("The 20 A single-pole breaker is $9.50 and in stock.");
  });

  it("falls back to the drafts (minus narration) when the final response has no text", async () => {
    const r = await reply(
      fakeClient(lookup("Let me check. The breaker is in stock."), message([])),
    );
    expect(r.replyText).toBe("The breaker is in stock.");
  });

  it("logs reply_long for a long pre-checkout reply but never cuts it", async () => {
    const long = Array.from({ length: LONG_REPLY_WORDS + 5 }, (_, i) => `word${i}`).join(" ");
    const r = await reply(fakeClient(text(long)));
    expect(r.replyText).toBe(long);
    expect(logs.some((l) => l.includes('"msg":"reply_long"'))).toBe(true);
    logs = [];
    await reply(fakeClient(text("The breaker is $9.50.")));
    expect(logs.some((l) => l.includes('"msg":"reply_long"'))).toBe(false);
  });
});
