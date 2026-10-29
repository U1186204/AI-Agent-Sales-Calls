/**
 * Guided cards in the chat (mocked API): keyboard-only use, accessibility, what each click
 * sends (codes, quantities and ids only), stale cards, the estimate hand-off, phone layout
 * and session restore.
 */
import { expect, test, type Page } from "@playwright/test";
import type { ChatResponse } from "../../src/contracts";
import {
  REPLY_CART,
  REPLY_ESTIMATE,
  REPLY_PRODUCTS,
  REPLY_QUOTE_TIMES,
  REPLY_SERVICE_FORM,
  REPLY_SERVICE_PICKER,
} from "./support/fixtures";
import {
  expectNoHorizontalScroll,
  expectNoSeriousA11yViolations,
  expectTapTargets,
  expectVisibleFocus,
  mockChat,
  mockCheckout,
} from "./support/mocks";

type Body = Record<string, unknown> & {
  event?: { type?: string; action?: Record<string, unknown> };
};

/** Reply by card action (or by message for the first turn). */
function router(replies: Record<string, ChatResponse | (() => ChatResponse)>) {
  return (body: Body) => {
    const key = body.event?.type === "card_action" ? String(body.event.action?.action) : "message";
    const r = replies[key] ?? replies.message!;
    return { body: typeof r === "function" ? r() : r };
  };
}

const NO_PRICES = /Cents|Label|price|total|duration|name/i;

async function ask(page: Page, slug: string, text: string) {
  await page.goto(`/chat/${slug}`);
  await page.locator("#chat-input").fill(text);
  await page.locator("#chat-input").press("Enter");
}

test.describe("guided cards", () => {
  test("service flow, keyboard only: picker → price + times → booking form", async ({ page }) => {
    const bodies = await mockChat(
      page,
      router({
        message: REPLY_SERVICE_PICKER,
        get_quote: REPLY_QUOTE_TIMES,
        pick_slot: REPLY_SERVICE_FORM,
      }),
    );
    await mockCheckout(page);
    await page.goto("/chat/mountpro-tv");
    await page.locator("#chat-input").focus();
    await page.keyboard.type("How much to mount a TV?");
    await page.keyboard.press("Enter");

    const picker = page.getByRole("region", { name: "TV wall mounting options" });
    await expect(picker).toBeVisible();
    await expectNoSeriousA11yViolations(page, "service picker card");

    // Reach the size group from the composer with Tab, choose with arrow keys.
    const small = picker.getByRole("radio", { name: /Small \(up to 42"\)/ });
    for (let i = 0; i < 25 && !(await small.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press("Shift+Tab");
    }
    await expect(small).toBeFocused();
    await expectVisibleFocus(page);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(picker.getByRole("radio", { name: /Large \(56"–70"\)/ })).toBeChecked();
    // Tab to the mount group and pick "Tilting" with arrows.
    await page.keyboard.press("Tab");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(picker.getByRole("radio", { name: /Tilting mount supplied/ })).toBeChecked();
    // Check "Above fireplace" with Space, then submit with Enter on the button.
    const fire = picker.getByRole("checkbox", { name: /Above fireplace/ });
    await fire.focus();
    await page.keyboard.press("Space");
    await expect(fire).toBeChecked();
    await picker.getByRole("button", { name: "See price and times" }).focus();
    await page.keyboard.press("Enter");

    // The click is an event with codes only, shown as the customer's choice.
    await expect.poll(() => bodies.length).toBe(2);
    const ev = bodies[1]!.event as { type: string; action: Record<string, unknown> };
    expect(ev.type).toBe("card_action");
    expect(ev.action).toMatchObject({
      action: "get_quote",
      config: {
        serviceCode: "tv-mounting",
        tierCode: "L",
        addOns: [{ code: "mount-tilt", qty: 1 }],
        surcharges: [{ code: "above-fireplace", qty: 1 }],
      },
    });
    expect(bodies[1]).not.toHaveProperty("message");
    expect(JSON.stringify(Object.keys(ev.action.config as object))).not.toMatch(NO_PRICES);
    await expect(page.locator(".event-pill").last()).toContainText("Price for TV wall mounting");

    // Focus moves to the new card; the old picker is read-only now.
    const quote = page.getByRole("region", { name: "Price for TV wall mounting" });
    await expect(quote.getByRole("heading", { level: 2 })).toBeFocused();
    await expect(picker.getByRole("button", { name: "See price and times" })).toBeDisabled();
    await expect(picker.getByRole("radio", { name: /Large/ })).toBeDisabled();
    await expectNoSeriousA11yViolations(page, "quote + times cards");

    // Tab from the quote heading to the first time and press Enter.
    const times = page.getByRole("region", { name: "Open times for TV wall mounting" });
    const first = times.locator(".time-btn").first();
    for (let i = 0; i < 10 && !(await first.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press("Tab");
    }
    await expect(first).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => bodies.length).toBe(3);
    const pick = (bodies[2]!.event as { action: Record<string, unknown> }).action;
    expect(pick).toMatchObject({ action: "pick_slot", config: { tierCode: "L" } });
    expect(String(pick.slotId)).toMatch(/^slot-/);
    await expect(page.getByRole("region", { name: "Secure booking form" })).toBeVisible();
  });

  test("quote card: change options in place sends a new quote request", async ({ page }) => {
    const bodies = await mockChat(page, router({ message: REPLY_QUOTE_TIMES }));
    await ask(page, "mountpro-tv", "Price for a 65 inch with a tilt mount above the fireplace");
    const quote = page.getByRole("region", { name: "Price for TV wall mounting" });
    await quote.getByRole("button", { name: "Change options" }).click();
    await quote.getByRole("radio", { name: /Full-motion mount supplied/ }).check();
    await quote.getByRole("button", { name: "Update price" }).click();
    await expect.poll(() => bodies.length).toBe(2);
    expect((bodies[1]!.event as { action: Record<string, unknown> }).action).toMatchObject({
      action: "get_quote",
      config: { addOns: [{ code: "mount-full-motion", qty: 1 }] },
    });
  });

  test("more times asks from the next day on", async ({ page }) => {
    const bodies = await mockChat(page, router({ message: REPLY_QUOTE_TIMES }));
    await ask(page, "mountpro-tv", "When can you come?");
    const times = page.getByRole("region", { name: "Open times for TV wall mounting" });
    await times.getByRole("button", { name: "More times" }).click();
    await expect.poll(() => bodies.length).toBe(2);
    expect((bodies[1]!.event as { action: Record<string, unknown> }).action).toMatchObject({
      action: "more_times",
      fromDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });

  test("estimate card offers a person and opens the hand-off prompt", async ({ page }) => {
    await mockChat(page, router({ message: REPLY_ESTIMATE }));
    await ask(page, "brightnest-cleaning", "Book a 5 bedroom move-out clean with everything");
    const card = page.getByRole("region", { name: /On-site estimate/ });
    await expect(card).toContainText("longer than our longest working day");
    await expect(card.locator(".time-btn")).toHaveCount(0);
    await card.getByRole("button", { name: "Talk to a person" }).click();
    await expect(page.getByRole("form", { name: "Talk to a person" })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "estimate card + hand-off");
  });

  test("products: steppers respect stock, sold-out items can't be added, total sends codes", async ({
    page,
  }) => {
    const bodies = await mockChat(
      page,
      router({ message: REPLY_PRODUCTS, quote_cart: REPLY_CART }),
    );
    await ask(page, "volt-supply", "Do you have 5 rolls of 12/2 Romex?");
    const card = page.getByRole("region", { name: "Products" });
    await expect(card).toContainText("Only 3 in stock (you asked for 5)");
    await expect(card).toContainText("In-stock alternatives");
    // the asked-for item starts at what's available; its + stops at stock
    const asked = card.locator(".product-tile").first();
    await expect(asked.locator(".stepper__value")).toHaveText("3");
    await expect(asked.getByRole("button", { name: /^More:/ })).toBeDisabled();
    // the sold-out alternative has no stepper
    const soldOut = card.locator(".product-tile[data-stock='out_of_stock']");
    await expect(soldOut.locator(".stepper")).toHaveCount(0);
    await expectNoSeriousA11yViolations(page, "product cards");

    await card.getByRole("button", { name: "Get order total" }).click();
    await expect.poll(() => bodies.length).toBe(2);
    expect((bodies[1]!.event as { action: Record<string, unknown> }).action).toEqual({
      action: "quote_cart",
      lines: [{ sku: "EL-WIR-1222-250", qty: 3 }],
    });
  });

  test("cart: a changed quantity must be re-priced; ZIP is validated before it is sent", async ({
    page,
  }) => {
    const bodies = await mockChat(page, router({ message: REPLY_CART }));
    await ask(page, "volt-supply", "Price 2 rolls");
    const cart = page.getByRole("region", { name: "Your order" });
    await expect(cart.getByRole("button", { name: "Check out" })).toBeVisible();
    await cart.getByRole("button", { name: /^More:/ }).click();
    await expect(cart.getByRole("button", { name: "Check out" })).toHaveCount(0);
    await expect(cart.getByRole("button", { name: "Update total" })).toBeVisible();

    await cart.getByLabel(/ZIP code/).fill("123");
    await cart.getByRole("button", { name: "Estimate shipping" }).click();
    await expect(cart.getByText("Enter a 5-digit US ZIP code")).toBeVisible();
    expect(bodies).toHaveLength(1);
    await cart.getByLabel(/ZIP code/).fill("85004");
    await cart.getByRole("button", { name: "Estimate shipping" }).click();
    await expect.poll(() => bodies.length).toBe(2);
    expect((bodies[1]!.event as { action: Record<string, unknown> }).action).toEqual({
      action: "quote_cart",
      lines: [{ sku: "EL-WIR-1222-250", qty: 3 }],
      zip: "85004",
    });
  });

  test("cards survive a reload; only the newest reply's cards take clicks", async ({ page }) => {
    await mockChat(page, router({ message: REPLY_SERVICE_PICKER, get_quote: REPLY_QUOTE_TIMES }));
    await ask(page, "mountpro-tv", "How much?");
    const picker = page.getByRole("region", { name: "TV wall mounting options" });
    await picker.getByRole("button", { name: "See price and times" }).click();
    await expect(page.getByRole("region", { name: "Price for TV wall mounting" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("region", { name: "TV wall mounting options" })).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "TV wall mounting options" })
        .getByRole("button", { name: "See price and times" }),
    ).toBeDisabled();
    await expect(
      page
        .getByRole("region", { name: "Open times for TV wall mounting" })
        .locator(".time-btn")
        .first(),
    ).toBeEnabled();
  });

  test("phone: 44px targets and no sideways scroll on every card", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await mockChat(page, router({ message: REPLY_SERVICE_PICKER, get_quote: REPLY_QUOTE_TIMES }));
    await ask(page, "mountpro-tv", "How much?");
    await expectNoHorizontalScroll(page);
    await expectTapTargets(
      page,
      ".chat-card .spec-tile__body, .chat-card .spec-choice__body, .chat-card .spec-row, .chat-card .stepper__btn, .chat-card .btn",
      "service picker",
    );
    await page.getByRole("button", { name: "See price and times" }).click();
    await expect(
      page.getByRole("region", { name: "Open times for TV wall mounting" }),
    ).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectTapTargets(page, ".chat-card .time-btn, .chat-card .btn", "quote + times");
  });
});
