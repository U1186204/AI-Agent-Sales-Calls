/**
 * Full-stack checkout (AT-40..43, AT-52, AT-71) — real server, real DB, scripted assistant.
 * Runs at all three widths.
 */
import { expect, test } from "@playwright/test";
import {
  fillCustomer,
  formBlock,
  newCustomer,
  openOn,
  ownerGet,
  sendChat,
  skuOf,
  stockOf,
} from "./support/fullstack";
import { ownerPanel, showOwnerView } from "./support/mocks";
import { signInAsOwner } from "./support/owner-session";

test.describe("full stack: electrical order", () => {
  test("chat → form → review → edit → confirm → chat event → owner dashboard", async ({
    page,
    context,
    baseURL,
    request,
  }) => {
    await page.goto("/chat/volt-supply");
    const reply = await sendChat(page, "I'd like to buy 1 please");
    const block = formBlock(reply);
    expect(block.kind).toBe("product");
    const sku = skuOf(block.summary);
    expect(sku, block.summary).toBeTruthy();
    // The trace shows the real tool calls and the test-mode footer.
    expect(reply.trace.map((s) => s.tool)).toEqual(["search_catalog", "start_checkout", undefined]);
    await expect(page.locator(".trace-testmode").first()).toBeAttached();

    const stockBefore = await stockOf(request, sku!);
    const form = page.getByRole("region", { name: "Secure order form" });
    await expect(form).toBeVisible();
    await expect(form.getByText("Loading secure form")).toBeHidden();

    const c = newCustomer("order");
    await fillCustomer(form, c);
    await form.getByRole("button", { name: "Review order" }).click();

    // Review shows masked PII and the server-computed total.
    await expect(form.getByRole("button", { name: "Confirm order" })).toBeVisible();
    await expect(form.getByText("r***@example.com")).toBeVisible();
    await expect(form.getByText("Austin, TX 78701")).toBeVisible();

    // Edit → change the city → review again shows the edited value.
    await form.getByRole("button", { name: "Edit details" }).click();
    await expect(form.getByLabel("First name")).toHaveValue(c.firstName);
    await form.getByLabel("City").fill("Round Rock");
    await form.getByLabel("ZIP code").fill("");
    await form.getByLabel("ZIP code").pressSequentially("78664");
    await form.getByRole("button", { name: "Review order" }).click();
    await expect(form.getByText("Round Rock, TX 78664")).toBeVisible();

    const [confirmRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/checkout/confirm")),
      form.getByRole("button", { name: "Confirm order" }).click(),
    ]);
    expect(confirmRes.status()).toBe(200);
    const confirmed = (await confirmRes.json()) as {
      reference: string;
      notifications: Record<string, string>;
    };
    expect(confirmed.notifications).toEqual({
      customerEmail: "mocked",
      businessEmail: "mocked",
      businessSms: "mocked",
    });
    const ref = confirmed.reference;
    await expect(form.getByRole("heading", { name: "Order confirmed" })).toBeVisible();
    await expect(form.locator(".success__ref")).toHaveText(ref);

    // The chat receives the completion event; the assistant confirms with the reference.
    await expect(page.locator(".event-pill")).toHaveText(`Order ${ref} confirmed`);
    await expect(page.locator(".msg--assistant .bubble").last()).toContainText(ref);

    // WF-3: after a reload the confirmed card still shows the shipping-inclusive total.
    const total = (confirmed as unknown as { totalCents: number }).totalCents;
    const money = `$${(total / 100).toFixed(2)}`;
    await expect(form.locator(".success .checkout__fine")).toContainText(`Total ${money}`);
    await page.reload();
    const reloaded = page.getByRole("region", { name: "Secure order form" });
    await expect(reloaded.getByRole("heading", { name: "Order confirmed" })).toBeVisible();
    await expect(reloaded.locator(".success__ref")).toHaveText(ref);
    await expect(reloaded.locator(".success .checkout__fine")).toContainText(`Total ${money}`);
    await expect(page.locator(".event-pill")).toHaveCount(1);

    // Inventory decremented exactly once.
    expect(await stockOf(request, sku!)).toBe(stockBefore - 1);

    // Owner dashboard: the order and its three notification rows.
    await signInAsOwner(context, baseURL!);
    await page.goto("/owner");
    await showOwnerView(page, "Orders");
    await expect(ownerPanel(page)).toContainText(ref);
    await expect(ownerPanel(page)).toContainText("R. Tester");
    await showOwnerView(page, "Notifications");
    const rows = ownerPanel(page).locator("tr", { hasText: ref });
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: "Customer · r***@" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "Business ·" }).filter({ hasText: "Email" })).toHaveCount(
      1,
    );
    await expect(rows.filter({ hasText: "SMS" })).toHaveCount(1);
    await expect(ownerPanel(page)).not.toContainText(c.email);
    await showOwnerView(page, "Inventory");
    await expect(ownerPanel(page).locator("tr", { hasText: sku! })).toContainText(
      String(stockBefore - 1),
    );
  });

  test("client-side validation blocks bad email / phone / ZIP (no request sent)", async ({
    page,
  }) => {
    await page.goto("/chat/volt-supply");
    formBlock(await sendChat(page, "buy 1"));
    const form = page.getByRole("region", { name: "Secure order form" });
    await expect(form.getByText("Loading secure form")).toBeHidden();
    const reviews: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/checkout/review")) reviews.push(r.url());
    });
    await fillCustomer(
      form,
      newCustomer("invalid", { email: "not-an-email", phone: "55512", zip: "123" }),
    );
    await form.getByRole("button", { name: "Review order" }).click();
    await expect(form.getByText("Enter a valid email address")).toBeVisible();
    await expect(form.getByText("Enter a 10-digit US phone number")).toBeVisible();
    await expect(form.getByText("Enter a 5-digit ZIP or ZIP+4")).toBeVisible();
    await expect(form.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");
    await page.waitForTimeout(300);
    expect(reviews).toEqual([]);
  });

  test("R2-1/R2-7: a ZIP that crosses a state line is a soft review warning; confirm still works", async ({
    page,
  }) => {
    await page.goto("/chat/volt-supply");
    formBlock(await sendChat(page, "buy 1"));
    const form = page.getByRole("region", { name: "Secure order form" });
    await expect(form.getByText("Loading secure form")).toBeHidden();
    // R2-7: the form says up front that military addresses are not supported.
    await expect(
      form.getByText("Military APO/FPO/DPO addresses aren't supported in this demo."),
    ).toBeVisible();
    // Milton-Freewater, OR uses 99362 (a Walla Walla, WA ZIP): a real address.
    await fillCustomer(
      form,
      newCustomer("crossstate", { city: "Milton-Freewater", state: "OR", zip: "99362" }),
    );
    await form.getByRole("button", { name: "Review order" }).click();
    await expect(form.getByRole("heading", { name: "Review your order" })).toBeVisible();
    await expect(
      form.getByText("ZIP 99362 is usually in Washington — double-check your state."),
    ).toBeVisible();
    await expect(form.getByText("Milton-Freewater, OR 99362")).toBeVisible();
    await expect(form.getByRole("button", { name: "Edit details" })).toBeEnabled();
    await expect(form.locator('[aria-invalid="true"]')).toHaveCount(0);
    const [confirmRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/checkout/confirm")),
      form.getByRole("button", { name: "Confirm order" }).click(),
    ]);
    expect(confirmRes.status()).toBe(200);
    await expect(form.getByRole("heading", { name: "Order confirmed" })).toBeVisible();
  });
});

test.describe("full stack: TV mounting booking", () => {
  test("date picker + time list → confirm → owner bookings + availability decreased", async ({
    page,
    context,
    baseURL,
    request,
  }) => {
    await page.goto("/chat/mountpro-tv");
    const reply = await sendChat(page, "Can I book a TV mounting appointment?");
    expect(formBlock(reply).kind).toBe("service");
    const form = page.getByRole("region", { name: "Secure booking form" });
    await expect(form.locator(".time input:checked")).toHaveCount(1); // slot chosen in chat

    // Pick a different available day in the calendar, then a time from the list.
    const day = form
      .locator('.cal__day:not([aria-disabled="true"])[data-selected="false"]')
      .first();
    const date = (await day.getAttribute("data-date"))!;
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const openBefore = await openOn(request, "mountpro-tv", date);
    await day.click();
    await expect(form.locator(`.cal__day[data-date="${date}"]`)).toHaveAttribute(
      "data-selected",
      "true",
    );
    const times = form.locator(".time input[type=radio]");
    await expect(times.first()).toBeVisible();
    await times.nth((await times.count()) > 1 ? 1 : 0).check();
    await expect(form.locator(".time input:checked")).toHaveCount(1);

    await fillCustomer(
      form,
      newCustomer("booking", { city: "Denver", state: "CO", zip: "80202", phone: "7205550188" }),
    );
    await form.getByRole("button", { name: "Review booking" }).click();
    await expect(form.getByRole("button", { name: "Confirm booking" })).toBeVisible();
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/checkout/confirm")),
      form.getByRole("button", { name: "Confirm booking" }).click(),
    ]);
    expect(res.status()).toBe(200);
    const ref = ((await res.json()) as { reference: string }).reference;
    await expect(form.getByRole("heading", { name: "You're booked" })).toBeVisible();
    await expect(page.locator(".event-pill")).toHaveText(`Booking ${ref} confirmed`);

    // Availability for that day dropped by the slots the job occupies.
    expect(await openOn(request, "mountpro-tv", date)).toBeLessThan(openBefore);
    const bookings = await ownerGet(request, "bookings");
    expect(bookings.items.find((b) => b.reference === ref)).toMatchObject({
      businessId: "mountpro-tv",
      customerName: "R. Tester",
    });

    await signInAsOwner(context, baseURL!);
    await page.goto("/owner");
    await showOwnerView(page, "Bookings");
    await expect(ownerPanel(page)).toContainText(ref);
    await showOwnerView(page, "Availability");
    await expect(ownerPanel(page)).toContainText("MountPro TV Installation");
  });
});
