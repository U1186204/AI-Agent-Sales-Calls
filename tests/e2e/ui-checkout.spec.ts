import { expect, test, type Page } from "@playwright/test";
import {
  CONVERSATION,
  DRAFT_PRODUCT,
  DRAFT_SERVICE,
  REFERENCE,
  REPLY_CONFIRMED,
  REPLY_PRODUCT_FORM,
  REPLY_SERVICE_FORM,
  availableDates,
  productReview,
  serviceReview,
} from "./support/fixtures";
import {
  expectNoHorizontalScroll,
  expectNoSeriousA11yViolations,
  expectVisibleFocus,
  mockChat,
  mockCheckout,
} from "./support/mocks";

async function openForm(page: Page, slug: string, prompt: string) {
  await page.goto(`/chat/${slug}`);
  const input = page.locator("#chat-input");
  await input.fill(prompt);
  await input.press("Enter");
  const form = page.getByRole("region", { name: /Secure (order|booking) form/ });
  await expect(form).toBeVisible();
  return form;
}

test.describe("checkout form (AT-40..43, AT-91)", () => {
  test("product: validation, masks, review, edit, confirm, chat event", async ({ page }) => {
    const chat = await mockChat(page, (body) => ({
      body: body.event ? REPLY_CONFIRMED : REPLY_PRODUCT_FORM,
    }));
    const seen = await mockCheckout(page, {
      review: () => ({ body: productReview() }),
      confirm: () => ({
        body: {
          ok: true,
          kind: "product",
          reference: REFERENCE,
          status: "confirmed",
          totalCents: 27948,
          replayed: false,
        },
      }),
    });
    const form = await openForm(page, "volt-supply", "Two rolls of 12/2 please");
    await expect(form.getByText("Loading secure form")).toBeHidden();
    // A form that just arrived takes focus on its heading (A11Y-14), not the composer.
    const title = form.getByRole("heading", { level: 2 });
    await expect(title).toBeFocused();
    await expect(title).toHaveText("2 × Romex 12/2 NM-B w/G, 250 ft");
    await expectNoSeriousA11yViolations(page, "checkout empty");
    await expectNoHorizontalScroll(page);

    // Submit empty: inline errors, aria-invalid, first invalid field focused.
    await form.getByRole("button", { name: "Review order" }).click();
    const first = form.getByLabel("First name");
    await expect(first).toBeFocused();
    await expect(first).toHaveAttribute("aria-invalid", "true");
    await expect(form.getByText("First name is required")).toBeVisible();
    await expect(form.getByText("Enter a 10-digit US phone number")).toBeVisible();
    await expect(form.getByText("Choose a US state or territory")).toBeVisible();
    const describedBy = await first.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`#${describedBy!.split(" ")[0]}`)).toHaveText(
      "First name is required",
    );
    await expectNoSeriousA11yViolations(page, "checkout errors");

    // Masks + blur validation.
    const phone = form.getByLabel("Mobile phone");
    await phone.pressSequentially("5555550123");
    await expect(phone).toHaveValue("(555) 555-0123");
    await phone.press("Backspace");
    await phone.press("Backspace");
    await expect(phone).toHaveValue("(555) 555-01");
    await phone.pressSequentially("23");
    const zip = form.getByLabel("ZIP code");
    await zip.pressSequentially("99501a1234");
    await expect(zip).toHaveValue("99501-1234");
    const email = form.getByLabel("Email");
    await email.fill("not-an-email");
    await email.blur();
    await expect(form.getByText("Enter a valid email address")).toBeVisible();
    await email.fill("Ana.Rivera@Example.com");
    await expect(form.getByText("Enter a valid email address")).toBeHidden();

    await first.fill("Ana");
    await form.getByLabel("Last name").fill("Rivera");
    await form.getByLabel("Street address").fill("1200 W 4th Ave");
    await form.getByLabel("City").fill("Anchorage");
    await form.getByLabel("State").selectOption("AK");
    await form.getByLabel("Delivery instructions").fill("Leave at the side door");
    await expect(form.getByText("22 / 500")).toBeVisible();
    await form.getByRole("button", { name: "Review order" }).click();

    // Review screen: focus moves to its heading (A11Y-1); items are listed once (VIS-6).
    await expect(form.getByRole("heading", { name: "Review your order" })).toBeFocused();
    await expect(form.getByRole("heading", { name: "Items" })).toHaveCount(0);
    await expect(form.getByText("a***@example.com")).toBeVisible();
    await expect(form.getByText("Anchorage, AK 99501")).toBeVisible();
    await expect(form.getByText("Free", { exact: true })).toBeVisible();
    await expect(form.getByText("$279.48")).toBeVisible();
    await expect(form.getByText(/not tax advice/)).toBeVisible();
    await expect(form.getByText(/no payment is collected in this demo/)).toBeVisible();
    expect(seen.review[0]).toMatchObject({
      kind: "product",
      draftId: DRAFT_PRODUCT,
      customer: {
        email: "ana.rivera@example.com",
        phone: "+15555550123",
        state: "AK",
        zip: "99501-1234",
      },
    });
    await expectNoSeriousA11yViolations(page, "checkout review");

    // Edit keeps values and returns focus to the form heading.
    await form.getByRole("button", { name: "Edit details" }).click();
    await expect(title).toBeFocused();
    await expect(form.getByLabel("First name")).toHaveValue("Ana");
    await expect(form.getByLabel("Mobile phone")).toHaveValue("(555) 555-0123");
    await form.getByLabel("City").fill("Anchorage ");
    await form.getByRole("button", { name: "Review order" }).click();

    // Confirm (double click → one request).
    const confirm = form.getByRole("button", { name: "Confirm order" });
    await confirm.dblclick();
    await expect(form.getByRole("heading", { name: "Order confirmed" })).toBeVisible();
    await expect(form.getByRole("heading", { name: "Order confirmed" })).toBeFocused();
    await expect(form.locator(".success__ref")).toHaveText(REFERENCE);
    expect(seen.confirm).toHaveLength(1);
    expect(seen.confirm[0]).toMatchObject({ conversationId: CONVERSATION });

    // The chat receives the completion event and the assistant confirms.
    await expect
      .poll(() => chat.find((b) => b.event)?.event)
      .toEqual({
        type: "checkout_completed",
        draftId: DRAFT_PRODUCT,
        reference: REFERENCE,
      });
    await expect(page.locator(".event-pill")).toHaveText(`Order ${REFERENCE} confirmed`);
    await expect(page.locator(".msg--assistant .bubble").last()).toContainText("You're all set");
    await expectNoSeriousA11yViolations(page, "checkout success");
    await expectNoHorizontalScroll(page);
  });

  test("service: keyboard-only booking with calendar and time list", async ({ page }) => {
    await mockChat(page, (body) => ({ body: body.event ? REPLY_CONFIRMED : REPLY_SERVICE_FORM }));
    const dates = availableDates();
    const seen = await mockCheckout(page, {
      review: (b) => ({ body: serviceReview(String(b.slotId)) }),
      confirm: () => ({
        body: {
          ok: true,
          kind: "service",
          reference: REFERENCE,
          status: "confirmed",
          totalCents: 33393,
          replayed: false,
        },
      }),
    });

    // Keyboard only from here on: type in the composer and press Enter.
    await page.goto("/chat/mountpro-tv");
    await page.locator("#chat-input").focus();
    await page.keyboard.type("Mount my 65 inch TV above the fireplace");
    await page.keyboard.press("Enter");
    const form = page.getByRole("region", { name: "Secure booking form" });
    await expect(form.locator(".time input:checked")).toHaveCount(1); // the slot chosen in chat
    // The new form's heading has focus; the subtitle adds only what's new (VIS-6).
    await expect(form.getByRole("heading", { level: 2 })).toBeFocused();
    await expect(form.getByRole("heading", { level: 2 })).toHaveText(
      'TV wall mounting · Large (56"–70")',
    );
    await expect(form.locator(".checkout__summary")).toHaveText(
      "Tilting mount supplied, Above fireplace · About 2 hr 30 min",
    );
    await expectNoSeriousA11yViolations(page, "booking form");

    // Tab forward from the heading until the calendar's active day has focus.
    const activeDay = form.locator(".cal__day[tabindex='0']");
    for (
      let i = 0;
      i < 20 && !(await activeDay.evaluate((el) => el === document.activeElement));
      i++
    ) {
      await page.keyboard.press("Tab");
    }
    await expect(activeDay).toBeFocused();
    await expectVisibleFocus(page);
    await expect(activeDay).toHaveAttribute("data-date", dates[0]!);

    // Move to the next available date with arrow keys and choose it.
    const second = dates[1]!;
    for (let i = 0; i < 10; i++) {
      const focused = await page.evaluate(
        () => (document.activeElement as HTMLElement).dataset.date,
      );
      if (focused === second) break;
      await page.keyboard.press("ArrowRight");
    }
    await page.keyboard.press("Enter");
    await expect(form.locator(`.cal__day[data-date="${second}"]`)).toHaveAttribute(
      "data-selected",
      "true",
    );
    // One selection pattern: aria-selected on the grid cell, no aria-pressed (A11Y-8).
    await expect(form.locator(`td:has(.cal__day[data-date="${second}"])`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(form.locator(".cal__day[aria-pressed]")).toHaveCount(0);
    await expect(form.locator(".time input:checked")).toHaveCount(0);

    // Tab into the time list (past the month nav), pick the second time with arrows.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      if (await page.evaluate(() => (document.activeElement as HTMLInputElement).type === "radio"))
        break;
    }
    await page.keyboard.press("ArrowRight");
    await expectVisibleFocus(page);
    await expect(form.locator(".time input:checked")).toHaveValue(`slot-${second}-10`);

    // Contact + address, Tab between fields.
    const fill = async (text: string) => {
      await page.keyboard.press("Tab");
      await expectVisibleFocus(page);
      if (text) await page.keyboard.type(text);
    };
    await fill("Jordan");
    await fill("Lee");
    await fill("jordan@example.com");
    await fill("7205550188");
    await expect(form.getByLabel("Mobile phone")).toHaveValue("(720) 555-0188");
    await fill("1550 Blake St");
    await fill(""); // apartment (optional)
    await fill("Denver");
    await fill("Colorado"); // typeahead on the focused <select>
    await expect(form.getByLabel("State")).toHaveValue("CO");
    await fill("80202");
    await fill("Gate code 4410");
    // Tab past the price disclosure to the submit button.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Tab");
      if (
        await page.evaluate(() => document.activeElement?.textContent?.includes("Review booking"))
      )
        break;
    }
    await expectVisibleFocus(page);
    await page.keyboard.press("Enter");

    await expect(form.getByRole("button", { name: "Confirm booking" })).toBeVisible();
    await expect(form.getByRole("heading", { name: "Review your booking" })).toBeFocused();
    expect(seen.review[0]).toMatchObject({
      kind: "service",
      draftId: DRAFT_SERVICE,
      slotId: `slot-${second}-10`,
    });
    await expect(form.getByText("Final price confirmed on site")).toBeVisible();
    await expect(form.getByText("with Marcus T.")).toBeVisible();
    await form.getByRole("button", { name: "Confirm booking" }).focus();
    await page.keyboard.press("Enter");
    await expect(form.getByRole("heading", { name: "You're booked" })).toBeVisible();
    await expect(form.getByRole("heading", { name: "You're booked" })).toBeFocused();
    await expectNoHorizontalScroll(page);
  });

  test("service: a slot taken at confirm sends the customer back to pick another time", async ({
    page,
  }) => {
    await mockChat(page, [REPLY_SERVICE_FORM]);
    let slotsCalls = 0;
    const dates = availableDates();
    await mockCheckout(page, {
      slots: (date) => {
        slotsCalls++;
        const hours = slotsCalls > 1 ? [13, 15] : [9, 10, 13, 15];
        return {
          body: {
            date,
            timezone: "America/Denver",
            slots: hours.map((h) => ({
              slotId: `slot-${date}-${h}`,
              startsAt: `${date}T${String(h + 6).padStart(2, "0")}:00:00Z`,
              endsAt: `${date}T${String(h + 8).padStart(2, "0")}:30:00Z`,
              localDate: date,
              localTime: `${h > 12 ? h - 12 : h}:00 ${h >= 12 ? "PM" : "AM"}`,
              timezone: "America/Denver",
              contractor: "Marcus T.",
            })),
          },
        };
      },
      review: (b) => ({ body: serviceReview(String(b.slotId)) }),
      confirm: () => ({
        status: 409,
        body: { ok: false, code: "slot_unavailable", message: "That time is no longer available." },
      }),
    });
    const form = await openForm(page, "mountpro-tv", "Book me in");
    await expect(form.locator(".time input:checked")).toHaveValue(`slot-${dates[0]}-10`);
    await form.getByLabel("First name").fill("Jordan");
    await form.getByLabel("Last name").fill("Lee");
    await form.getByLabel("Email").fill("jordan@example.com");
    await form.getByLabel("Mobile phone").fill("7205550188");
    await form.getByLabel("Street address").fill("1550 Blake St");
    await form.getByLabel("City").fill("Denver");
    await form.getByLabel("State").selectOption("CO");
    await form.getByLabel("ZIP code").fill("80202");
    await form.getByRole("button", { name: "Review booking" }).click();
    await form.getByRole("button", { name: "Confirm booking" }).click();

    await expect(form.getByText("That time was just booked by someone else")).toBeVisible();
    await expect(form.locator(".time input")).toHaveCount(2);
    await expect(form.locator(".time input:checked")).toHaveCount(0);
    await expect(form.getByLabel("First name")).toHaveValue("Jordan");
    await expectNoSeriousA11yViolations(page, "slot taken");
  });

  test("expired draft and out-of-stock show actionable messages", async ({ page }) => {
    await mockChat(page, [REPLY_PRODUCT_FORM]);
    await mockCheckout(page, {
      review: () => ({ body: productReview() }),
      confirm: () => ({
        status: 409,
        body: { ok: false, code: "out_of_stock", message: "Only 1 roll of EL-NM122-250 is left." },
      }),
    });
    const form = await openForm(page, "volt-supply", "Two rolls");
    await form.getByLabel("First name").fill("Ana");
    await form.getByLabel("Last name").fill("Rivera");
    await form.getByLabel("Email").fill("ana@example.com");
    await form.getByLabel("Mobile phone").fill("9075550123");
    await form.getByLabel("Street address").fill("1200 W 4th Ave");
    await form.getByLabel("City").fill("Anchorage");
    await form.getByLabel("State").selectOption("AK");
    await form.getByLabel("ZIP code").fill("99501");
    await form.getByRole("button", { name: "Review order" }).click();
    await form.getByRole("button", { name: "Confirm order" }).click();
    await expect(form.getByRole("alert")).toContainText("Some items just sold out");
    await expect(form.getByRole("alert")).toContainText("Only 1 roll");
    await expect(form.getByRole("button", { name: "Confirm order" })).toHaveCount(0);
  });
});

test.describe("checkout persistence (EDGE-6)", () => {
  test("typed details survive a reload in this tab and are forgotten after confirm", async ({
    page,
  }) => {
    await mockChat(page, (body) => ({ body: body.event ? REPLY_CONFIRMED : REPLY_PRODUCT_FORM }));
    await mockCheckout(page, {
      review: () => ({ body: productReview() }),
      confirm: () => ({
        body: {
          ok: true,
          kind: "product",
          reference: REFERENCE,
          status: "confirmed",
          totalCents: 27948,
          replayed: false,
        },
      }),
    });
    let form = await openForm(page, "volt-supply", "Two rolls");
    await form.getByLabel("First name").fill("Ana");
    await form.getByLabel("Email").fill("ana@example.com");
    await form.getByLabel("State").selectOption("PR");
    await page.reload();
    form = page.getByRole("region", { name: "Secure order form" });
    await expect(form.getByLabel("First name")).toHaveValue("Ana");
    await expect(form.getByLabel("Email")).toHaveValue("ana@example.com");
    await expect(form.getByLabel("State")).toHaveValue("PR");
    // Territories are grouped separately in the state list.
    await expect(form.locator('optgroup[label="U.S. territories"] option')).toHaveCount(5);

    await form.getByLabel("Last name").fill("Rivera");
    await form.getByLabel("Mobile phone").fill("7875550123");
    await form.getByLabel("Street address").fill("1 Calle Sol");
    await form.getByLabel("City").fill("San Juan");
    await form.getByLabel("ZIP code").pressSequentially("009011234");
    await expect(form.getByLabel("ZIP code")).toHaveValue("00901-1234");
    await form.getByRole("button", { name: "Review order" }).click();
    await form.getByRole("button", { name: "Confirm order" }).click();
    await expect(form.getByRole("heading", { name: "Order confirmed" })).toBeVisible();
    const saved = await page.evaluate(() =>
      Object.keys(sessionStorage)
        .filter((k) => k.startsWith("oasis:checkout:"))
        .map((k) => sessionStorage.getItem(k) ?? ""),
    );
    expect(saved.join("")).not.toContain("ana@example.com");
    expect(saved.join("")).toContain("27948");
  });
});
