/**
 * Booking form "Service details" (guided flow, Goal A): the customer sees the configuration
 * being booked and can change it in place. The server re-prices (mocked PATCH here); the form
 * shows the new total, re-checks the chosen time, and never sends a price.
 */
import { expect, test, type Page } from "@playwright/test";
import { REPLY_SERVICE_FORM, availableDates, serviceDraftUpdated } from "./support/fixtures";
import {
  expectNoHorizontalScroll,
  expectNoSeriousA11yViolations,
  expectVisibleFocus,
  mockChat,
  mockCheckout,
} from "./support/mocks";

async function openBooking(page: Page) {
  await mockChat(page, () => ({ body: REPLY_SERVICE_FORM }));
  await page.goto("/chat/mountpro-tv");
  await page.locator("#chat-input").fill("Mount my 65 inch TV above the fireplace");
  await page.locator("#chat-input").press("Enter");
  const form = page.getByRole("region", { name: "Secure booking form" });
  await expect(form).toBeVisible();
  return form;
}

test.describe("booking form: service details", () => {
  test("shows the booked configuration and re-prices a change on the server", async ({ page }) => {
    const seen = await mockCheckout(page);
    const form = await openBooking(page);
    const details = form.locator(".spec-section");
    // Collapsed: a one-line summary of what is being booked.
    await expect(details.locator(".spec-section__line")).toHaveText(
      'Large (56"–70") · Tilting mount supplied · Above fireplace',
    );
    await details.locator(".spec-section__summary").click();
    await expect(form.getByRole("radio", { name: /Large \(56"–70"\)/ })).toBeChecked();
    await expect(form.getByRole("radio", { name: /Tilting mount supplied/ })).toBeChecked();
    await expect(form.getByRole("checkbox", { name: /Above fireplace/ })).toBeChecked();
    await expectNoSeriousA11yViolations(page, "service details open");

    // The "why" for a condition is the business's own explanation.
    await form.getByText("Why does this cost more?").first().click();
    await expect(form.getByText(/ladder at height/)).toBeVisible();

    // Add in-wall concealment (replaces "No cable management" in its group).
    await form.getByRole("radio", { name: /In-wall cable concealment/ }).check();
    const submit = form.getByRole("button", { name: "Review booking" });
    await expect(submit).toBeDisabled(); // no review while the price is being updated
    await expect(details.locator(".spec-section__price")).toContainText("$494.11");
    await expect(submit).toBeEnabled();
    await expect(form.locator(".checkout__summary")).toContainText("In-wall cable concealment");
    await expect(
      page.getByRole("status").filter({ hasText: "Price updated to $494.11" }),
    ).toHaveCount(1);

    // Codes and quantities only — never a price, label or duration.
    expect(seen.selection).toHaveLength(1);
    const body = seen.selection[0]!;
    expect(Object.keys(body).sort()).toEqual(["config", "conversationId"]);
    expect(JSON.stringify(body)).not.toMatch(/Cents|Label|duration|price/i);
    expect(body.config).toMatchObject({
      tierCode: "L",
      addOns: expect.arrayContaining([
        { code: "mount-tilt", qty: 1 },
        { code: "in-wall-concealment", qty: 1 },
      ]),
    });
  });

  test("a longer job that no longer fits clears the chosen time and moves the day", async ({
    page,
  }) => {
    await mockCheckout(page, {
      selection: (b) => ({
        body: serviceDraftUpdated(b.config as never, { fewerDates: true }),
      }),
    });
    const form = await openBooking(page);
    await expect(form.locator(".time input:checked")).toHaveCount(1);
    await form.locator(".spec-section__summary").click();
    await form.getByRole("radio", { name: /In-wall cable concealment/ }).check();
    await expect(page.getByRole("status").filter({ hasText: /pick a new time/ })).toHaveCount(1);
    await expect(form.locator(".time input:checked")).toHaveCount(0);
    await expect(form.locator(".cal__day[data-selected='true']")).toHaveAttribute(
      "data-date",
      availableDates()[1]!,
    );
  });

  test("a rejected combination shows why and keeps the priced configuration", async ({ page }) => {
    await mockCheckout(page, {
      selection: () => ({
        status: 422,
        body: {
          ok: false,
          code: "validation",
          message: "Those options can't be combined.",
          fieldErrors: { "addOns.device-shelf": ["Floating device shelf: at most 2."] },
        },
      }),
    });
    const form = await openBooking(page);
    await form.locator(".spec-section__summary").click();
    await form.getByRole("checkbox", { name: /Soundbar mount/ }).check();
    await expect(form.getByRole("alert")).toContainText("at most 2");
    // reverted to what the shown price belongs to
    await expect(form.getByRole("checkbox", { name: /Soundbar mount/ })).not.toBeChecked();
    await expect(form.locator(".spec-section__price")).toContainText("$333.93");
  });

  test("keyboard: open the section, change size with arrow keys, then reach the calendar", async ({
    page,
  }) => {
    const seen = await mockCheckout(page);
    const form = await openBooking(page);
    await expect(form.getByRole("heading", { level: 2 })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(form.locator(".spec-section__summary")).toBeFocused();
    await expectVisibleFocus(page);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await expect(form.getByRole("radio", { name: /Large \(56"–70"\)/ })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(form.getByRole("radio", { name: /Extra large/ })).toBeChecked();
    await expect.poll(() => seen.selection.length).toBe(1);
    expect(seen.selection[0]!.config).toMatchObject({ tierCode: "XL" });
    // Collapse again: the calendar is the next stop.
    await form.locator(".spec-section__summary").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await expect
      .poll(() => page.evaluate(() => Boolean(document.activeElement?.closest(".cal"))))
      .toBe(true);
  });

  test("fits a phone screen: no sideways scroll, 44px controls", async ({ page }) => {
    await mockCheckout(page);
    await page.setViewportSize({ width: 375, height: 812 });
    const form = await openBooking(page);
    await form.locator(".spec-section__summary").click();
    await expectNoHorizontalScroll(page);
    const small = await page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLElement>(
          ".spec-tile__body, .spec-choice__body, .spec-row, .stepper__btn, .spec-section__summary",
        ),
      ]
        .filter((el) => el.offsetParent !== null)
        .filter((el) => el.getBoundingClientRect().height < 44)
        .map((el) => el.className),
    );
    expect(small).toEqual([]);
  });
});
