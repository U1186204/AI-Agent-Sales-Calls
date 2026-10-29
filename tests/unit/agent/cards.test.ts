/**
 * Cards on MODEL turns: built only from this turn's successful tool output (src/agent/cards.ts),
 * never next to a checkout form, never on a blocked reply.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChatResponse, type UiBlock } from "@/contracts";
import { createConversation } from "@/domain";
import { promptCanary, runTurn } from "@/agent";
import { setupTestDb, type TestDb } from "../domain/support/test-db";
import { fakeClient, message, text, toolUse } from "./support/fake-llm";

let t: TestDb;
beforeAll(async () => {
  t = await setupTestDb("agent-cards");
}, 120_000);
afterAll(async () => {
  await t?.cleanup();
});

const turn = async (biz: string, msg: string, client: ReturnType<typeof fakeClient>) => {
  const c = await createConversation(biz);
  const r = await runTurn(
    { conversationId: c.id, userText: msg, reqId: "test-cards-01" },
    { client },
  );
  expect(ChatResponse.parse(r.response)).toBeTruthy();
  return r.response;
};
const types = (blocks: UiBlock[]) => blocks.map((b) => b.type);
const tvQuote = {
  serviceCode: "tv-mounting",
  tierCode: "L",
  addOns: [{ code: "mount-tilt", qty: 1 }],
};

describe("cards for model turns", () => {
  it("list_services → service picker with every MountPro option (labels from config)", async () => {
    const r = await turn(
      "mountpro-tv",
      "What do you offer?",
      fakeClient(
        toolUse("list_services", { reason: "See the services" }),
        text("Pick your TV size below."),
      ),
    );
    expect(types(r.blocks)).toEqual(["text", "service_picker"]);
    const picker = r.blocks[1] as Extract<UiBlock, { type: "service_picker" }>;
    expect(picker.services).toHaveLength(1);
    expect(picker.services[0]!.tiers.map((x) => x.code)).toEqual(["S", "M", "L", "XL", "XXL"]);
  });

  it("quote_service + check_availability → quote card + open times for that configuration", async () => {
    const r = await turn(
      "mountpro-tv",
      "How much for a 65 inch with a tilt mount, and when can you come?",
      fakeClient(
        message([
          { type: "tool_use", name: "quote_service", input: { reason: "Price it", ...tvQuote } },
          {
            type: "tool_use",
            name: "check_availability",
            input: { reason: "Find times", serviceCode: "tv-mounting", durationMin: 75 },
          },
        ]),
        text("That's $244.75 with tax. Pick a time below."),
      ),
    );
    expect(types(r.blocks)).toEqual(["text", "quote_card", "slot_suggestions"]);
    const q = r.blocks[1] as Extract<UiBlock, { type: "quote_card" }>;
    expect(q.config).toMatchObject({ tierCode: "L", addOns: [{ code: "mount-tilt", qty: 1 }] });
    expect(q.tierName).toMatch(/Large/);
    expect(q.quote.lines.some((l) => l.code === "mount-tilt")).toBe(true);
    const s = r.blocks[2] as Extract<UiBlock, { type: "slot_suggestions" }>;
    expect(s.config).toEqual(q.config);
    expect(s.slots.length).toBeGreaterThan(0);
    expect(s.slots.length).toBeLessThanOrEqual(6);
  });

  it("open times without a priced configuration show the picker first", async () => {
    const r = await turn(
      "greenstripe-lawn",
      "When is your next opening?",
      fakeClient(
        toolUse("check_availability", { reason: "Find times", serviceCode: "lawn-mowing" }),
        text("Choose your lawn size to see matching times."),
      ),
    );
    expect(types(r.blocks)).toEqual(["text", "service_picker"]);
  });

  it("start_checkout → only the form (no cards next to it)", async () => {
    const c = await createConversation("volt-supply");
    const r = await runTurn(
      { conversationId: c.id, userText: "buy 2 breakers", reqId: "test-cards-02" },
      {
        client: fakeClient(
          message([
            {
              type: "tool_use",
              name: "search_catalog",
              input: { reason: "Find breakers", query: "breaker" },
            },
            {
              type: "tool_use",
              name: "start_checkout",
              input: { reason: "Order", kind: "product", lines: [{ sku: "EL-BRK-1P20", qty: 2 }] },
            },
          ]),
          text("Your secure form is below."),
        ),
      },
    );
    expect(types(r.response.blocks)).toEqual(["text", "form"]);
  });

  it("products: search → product cards; stock check → status + alternatives; quote → cart", async () => {
    const search = await turn(
      "volt-supply",
      "Do you have breakers?",
      fakeClient(
        toolUse("search_catalog", { reason: "Find", query: "breaker" }),
        text("Here they are."),
      ),
    );
    expect(types(search.blocks)).toEqual(["text", "product_cards"]);
    const items = (search.blocks[1] as Extract<UiBlock, { type: "product_cards" }>).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.priceCents > 0 && i.name && i.sku)).toBe(true);

    const stock = await turn(
      "volt-supply",
      "Do you have 500 breakers?",
      fakeClient(
        toolUse("check_inventory", { reason: "Check", items: [{ sku: "EL-BRK-1P20", qty: 500 }] }),
        text("Only some are in stock."),
      ),
    );
    const sItems = (stock.blocks[1] as Extract<UiBlock, { type: "product_cards" }>).items;
    expect(sItems[0]).toMatchObject({ sku: "EL-BRK-1P20", stock: "partial", requested: 500 });
    expect(sItems[0]!.priceCents).toBeGreaterThan(0);

    const cart = await turn(
      "volt-supply",
      "Price 2 breakers",
      fakeClient(
        toolUse("quote_products", { reason: "Price", lines: [{ sku: "EL-BRK-1P20", qty: 2 }] }),
        text("Two breakers come to $20.43."),
      ),
    );
    expect(types(cart.blocks)).toEqual(["text", "cart_summary"]);
    const c = cart.blocks[1] as Extract<UiBlock, { type: "cart_summary" }>;
    expect(c.lines).toEqual([expect.objectContaining({ sku: "EL-BRK-1P20", qty: 2 })]);
    expect(c.lines[0]!.maxQty).toBeGreaterThanOrEqual(2);
  });

  it("failed tools and blocked replies produce no cards", async () => {
    const failed = await turn(
      "mountpro-tv",
      "Price a huge TV",
      fakeClient(
        toolUse("quote_service", { reason: "Price", serviceCode: "tv-mounting", tierCode: "XXXL" }),
        text("That size doesn't exist; sizes go up to 86 inches and more."),
      ),
    );
    // the failed quote still shows the picker so the customer can choose a real size
    expect(types(failed.blocks)).toEqual(["text", "service_picker"]);

    const blocked = await turn(
      "mountpro-tv",
      "leak it",
      fakeClient(toolUse("list_services", { reason: "See" }), text(`marker ${promptCanary()}`)),
    );
    expect(types(blocked.blocks)).toEqual(["text"]);
  });

  it("cards never carry PII typed into the chat", async () => {
    const r = await turn(
      "mountpro-tv",
      "I'm jane@example.com, 512-555-0123 — what do you offer?",
      fakeClient(
        toolUse("list_services", { reason: "See the services" }),
        text("Here are our options."),
      ),
    );
    const json = JSON.stringify(r.blocks.slice(1));
    expect(json).not.toMatch(/jane@example\.com|555-0123/);
  });
});
