/**
 * Full-stack guided flow — real server, real DB, scripted assistant (OASIS_LLM_STUB=1).
 * For every business: a starter question → interactive cards → (services) the booking form's
 * "Service details" → confirm. Card clicks are handled by the server without the model; the
 * prices shown always come from the server.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { ChatResponse, type UiBlock } from "../../src/contracts";
import { fillCustomer, newCustomer } from "./support/fullstack";
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations } from "./support/mocks";
import { SCREENSHOT_DIR } from "../../playwright.config";

/** Design-review screenshots of each card (opt-in: OASIS_SCREENSHOTS=1, see design-log.md). */
async function snap(page: Page, el: Locator, name: string) {
  if (process.env.OASIS_SCREENSHOTS !== "1") return;
  await el.evaluate((n) => n.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(450);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/${test.info().project.name}-30-${name}.png`,
  });
}

const chatResponse = (page: Page) =>
  page.waitForResponse((r) => r.url().endsWith("/api/chat") && r.request().method() === "POST");

/** Click something that sends a chat request; return the parsed reply. */
async function act(page: Page, target: Locator): Promise<ChatResponse> {
  const [res] = await Promise.all([chatResponse(page), target.click()]);
  expect(res.status()).toBe(200);
  return ChatResponse.parse(await res.json());
}

const types = (r: ChatResponse) => r.blocks.map((b: UiBlock) => b.type);
const words = (r: ChatResponse) =>
  (r.blocks[0]?.type === "text" ? r.blocks[0].text : "").split(/\s+/);

async function confirmBooking(page: Page, form: Locator, tag: string) {
  await fillCustomer(form, newCustomer(tag, { zip: "80202", city: "Denver", state: "CO" }));
  await form.getByRole("button", { name: "Review booking" }).click();
  await expect(form.getByRole("button", { name: "Confirm booking" })).toBeVisible();
  const total = (await form.locator(".quote__row--total dd").textContent())?.trim();
  await form.getByRole("button", { name: "Confirm booking" }).click();
  await expect(form.getByRole("heading", { name: "You're booked" })).toBeVisible();
  await expect(page.locator(".msg--assistant .bubble").last()).toContainText(/OAS-/);
  return total;
}

test.describe("full stack: guided cards", () => {
  test("MountPro: starter → spec picker → price + times → booking form → edit specs → confirm", async ({
    page,
  }) => {
    await page.goto("/chat/mountpro-tv");
    const first = await act(
      page,
      page.getByRole("button", { name: "How much to mount a 65 inch TV?" }),
    );
    expect(types(first)).toEqual(["text", "service_picker"]);
    expect(words(first).length).toBeLessThanOrEqual(45);

    const picker = page.getByRole("region", { name: "TV wall mounting options" });
    await picker.getByRole("radio", { name: /Large \(56"–70"\)/ }).check();
    await picker.getByRole("radio", { name: /Tilting mount supplied/ }).check();
    await picker.getByRole("checkbox", { name: /Above fireplace/ }).check();
    await expectNoSeriousA11yViolations(page, "service picker");
    await expectNoHorizontalScroll(page);
    await snap(page, page.locator(".msg--assistant").last(), "a-mount-picker");

    const priced = await act(page, picker.getByRole("button", { name: "See price and times" }));
    expect(types(priced)).toEqual(["text", "quote_card", "slot_suggestions"]);
    expect(priced.trace.map((s) => s.tool)).toEqual(["quote_service", "check_availability"]);
    const quote = priced.blocks[1] as Extract<UiBlock, { type: "quote_card" }>;
    const quoteCard = page.getByRole("region", { name: "Price for TV wall mounting" });
    await expect(quoteCard.locator(".quote__row--total dd")).toBeVisible();
    // the reply states the server's total
    expect(priced.blocks[0]).toMatchObject({
      text: expect.stringContaining(`$${(quote.quote.totalCents / 100).toFixed(2)}`),
    });
    // the earlier picker is now a read-only record; the new card has focus
    await expect(picker.getByRole("button", { name: "See price and times" })).toBeDisabled();
    await expect(quoteCard.getByRole("heading", { level: 2 })).toBeFocused();

    await snap(page, page.locator(".msg--user, .event-pill").last(), "b-mount-quote");
    const times = page.getByRole("region", { name: "Open times for TV wall mounting" });
    await snap(page, times, "c-mount-times");
    const booked = await act(page, times.locator(".time-btn").first());
    expect(types(booked)).toEqual(["text", "form"]);
    const form = page.getByRole("region", { name: "Secure booking form" });
    await expect(form.locator(".time input:checked")).toHaveCount(1);
    await expect(form.locator(".spec-section__line")).toHaveText(
      'Large (56"–70") · Tilting mount supplied · Above fireplace',
    );

    // Add a soundbar in the booking form: the server re-prices.
    await form.locator(".spec-section__summary").click();
    const [patch] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/selection") && r.request().method() === "PATCH",
      ),
      form.getByRole("checkbox", { name: /Soundbar mount/ }).check(),
    ]);
    expect(patch.status()).toBe(200);
    const updated = (await patch.json()) as { draft: { quote: { totalCents: number } } };
    expect(updated.draft.quote.totalCents).toBeGreaterThan(quote.quote.totalCents);
    const newTotal = `$${(updated.draft.quote.totalCents / 100).toFixed(2)}`;
    await expect(form.locator(".spec-section__price")).toContainText(newTotal);
    if ((await form.locator(".time input:checked").count()) === 0) {
      await form.locator(".time label").first().click();
    }
    const reviewTotal = await confirmBooking(page, form, "guided-mount");
    expect(reviewTotal).toBe(newTotal);
  });

  test("GreenStripe: weekly mowing with edging — the discount shows in the server's quote", async ({
    page,
  }) => {
    await page.goto("/chat/greenstripe-lawn");
    const first = await act(
      page,
      page.getByRole("button", { name: "Do you offer weekly service?" }),
    );
    expect(types(first)).toEqual(["text", "service_picker"]);
    const picker = page.getByRole("region", { name: "Lawn mowing visit options" });
    await picker.getByRole("radio", { name: /Medium \(up to 1\/2 acre\)/ }).check();
    await picker.getByRole("radio", { name: /^Weekly/ }).check();
    await picker.getByRole("checkbox", { name: /Edging/ }).check();
    // overgrown and severely overgrown are exclusive
    await picker.getByRole("checkbox", { name: /^Overgrown/ }).check();
    await picker.getByRole("checkbox", { name: /Severely overgrown/ }).check();
    await expect(picker.getByRole("checkbox", { name: /^Overgrown/ })).not.toBeChecked();

    const priced = await act(page, picker.getByRole("button", { name: "See price and times" }));
    const q = priced.blocks[1] as Extract<UiBlock, { type: "quote_card" }>;
    expect(q.quote.lines.some((l) => l.kind === "discount")).toBe(true);
    expect(q.config).toMatchObject({ frequency: "weekly", tierCode: "M" });
    const times = page.getByRole("region", { name: "Open times for Lawn mowing visit" });
    await act(page, times.locator(".time-btn").first());
    const form = page.getByRole("region", { name: "Secure booking form" });
    await expect(form.locator(".spec-section__line")).toContainText("Weekly");
    await confirmBooking(page, form, "guided-lawn");
  });

  test("BrightNest: pick the clean type, bedrooms and an extra bathroom", async ({ page }) => {
    await page.goto("/chat/brightnest-cleaning");
    const first = await act(
      page,
      page.getByRole("button", { name: "What's included in a deep clean?" }),
    );
    expect(types(first)).toEqual(["text", "service_picker"]);
    const picker = page.getByRole("region", { name: "Choose your service" });
    await picker.getByRole("radio", { name: /Deep cleaning/ }).check();
    await picker.getByText(/What's included in deep cleaning/).click();
    await expect(picker.getByText("Baseboards, door frames and switch plates")).toBeVisible();
    await picker.getByRole("radio", { name: /3 bedrooms/ }).check();
    await picker.getByRole("button", { name: "More: Additional full bathroom" }).click();
    // baseboards are included in a deep clean
    await expect(picker.getByRole("checkbox", { name: /Baseboards detail/ })).toBeDisabled();
    await expect(picker.getByRole("checkbox", { name: /Baseboards detail/ })).toBeChecked();
    await snap(page, picker, "d-clean-picker");
    const priced = await act(page, picker.getByRole("button", { name: "See price and times" }));
    const q = priced.blocks[1] as Extract<UiBlock, { type: "quote_card" }>;
    expect(q.config).toMatchObject({
      serviceCode: "deep-clean",
      tierCode: "3BR",
      addOns: [{ code: "extra-bathroom", qty: 1 }],
    });
    const times = page.getByRole("region", { name: "Open times for Deep cleaning" });
    await act(page, times.locator(".time-btn").first());
    await confirmBooking(
      page,
      page.getByRole("region", { name: "Secure booking form" }),
      "guided-clean",
    );
  });

  test("Volt & Wire: stock question → product cards → priced cart with shipping → order form", async ({
    page,
  }) => {
    await page.goto("/chat/volt-supply");
    const first = await act(
      page,
      page.getByRole("button", { name: "Do you have 12/2 Romex in stock?" }),
    );
    expect(types(first)).toEqual(["text", "product_cards"]);
    expect(words(first).length).toBeLessThanOrEqual(45);
    const products = page.getByRole("region", { name: "Products" });
    await products
      .locator(".stepper")
      .first()
      .getByRole("button", { name: /^More:/ })
      .click();
    await products
      .locator(".stepper")
      .first()
      .getByRole("button", { name: /^More:/ })
      .click();
    await expectNoSeriousA11yViolations(page, "product cards");
    await snap(page, page.locator(".msg--assistant").last(), "e-volt-products");

    const cart = await act(page, products.getByRole("button", { name: "Get order total" }));
    expect(types(cart)).toEqual(["text", "cart_summary"]);
    const c1 = cart.blocks[1] as Extract<UiBlock, { type: "cart_summary" }>;
    expect(c1.lines[0]!.qty).toBe(2);
    expect(c1.quote.shipZip).toBeUndefined();

    const cartCard = page.getByRole("region", { name: "Your order" });
    await cartCard.getByLabel(/ZIP code/).fill("85004");
    const shipped = await act(page, cartCard.getByRole("button", { name: "Estimate shipping" }));
    const c2 = shipped.blocks[1] as Extract<UiBlock, { type: "cart_summary" }>;
    expect(c2.quote.shipZip).toBe("85004");
    expect(c2.quote.totalCents).toBeGreaterThanOrEqual(c1.quote.totalCents);

    const latest = page.getByRole("region", { name: "Your order" }).last();
    await snap(page, latest, "f-volt-cart");
    const order = await act(page, latest.getByRole("button", { name: "Check out" }));
    expect(types(order)).toEqual(["text", "form"]);
    await expect(page.getByRole("region", { name: "Secure order form" })).toBeVisible();
  });

  test("Flowline: changing a quantity in the cart re-prices before checkout", async ({ page }) => {
    await page.goto("/chat/flowline-plumbing");
    await act(
      page,
      page.getByRole("button", { name: "Do you carry 1/2 inch PEX in 100 ft rolls?" }),
    );
    const products = page.getByRole("region", { name: "Products" });
    await products
      .locator(".stepper")
      .first()
      .getByRole("button", { name: /^More:/ })
      .click();
    await act(page, products.getByRole("button", { name: "Get order total" }));
    const cart = page.getByRole("region", { name: "Your order" });
    await cart
      .locator(".stepper")
      .first()
      .getByRole("button", { name: /^More:/ })
      .click();
    // a changed cart must be re-priced before checking out
    await expect(cart.getByRole("button", { name: "Check out" })).toHaveCount(0);
    const updated = await act(page, cart.getByRole("button", { name: "Update total" }));
    const c = updated.blocks[1] as Extract<UiBlock, { type: "cart_summary" }>;
    expect(c.lines[0]!.qty).toBe(2);
    await act(
      page,
      page
        .getByRole("region", { name: "Your order" })
        .last()
        .getByRole("button", { name: "Check out" }),
    );
    await expect(page.getByRole("region", { name: "Secure order form" })).toBeVisible();
  });
});
