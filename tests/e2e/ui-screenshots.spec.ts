/**
 * Design-review screenshots of every page and state (SPEC §10 AT-90, docs/design-log.md).
 * Opt-in: OASIS_SCREENSHOTS=1 npx playwright test ui-screenshots
 * Output: .artifacts/screenshots/<project>-<state>.png (gitignored).
 */
import { expect, test, type Page } from "@playwright/test";
import { SCREENSHOT_DIR } from "../../playwright.config";
import {
  REFERENCE,
  REPLY_CONFIRMED,
  REPLY_HUMAN,
  REPLY_PRODUCT_FORM,
  REPLY_SERVICE_FORM,
  REPLY_STOCK,
  STATUS_FOUND,
  chatText,
  productReview,
  serviceReview,
} from "./support/fixtures";
import { OWNER_DATA, TRANSCRIPT } from "./support/owner-fixtures";
import {
  mockChat,
  mockCheckout,
  mockOwnerApi,
  mockStatus,
  ownerPanel,
  showOwnerView,
} from "./support/mocks";
import { signInAsOwner } from "./support/owner-session";

test.skip(
  process.env.OASIS_SCREENSHOTS !== "1",
  "Set OASIS_SCREENSHOTS=1 to capture design screenshots",
);

async function shot(page: Page, name: string, fullPage = true) {
  await page.waitForTimeout(450); // let 200–400 ms transitions settle
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/${test.info().project.name}-${name}.png`,
    fullPage,
  });
}

test("home + 404 + status + login", async ({ page }) => {
  await page.goto("/");
  await shot(page, "01-home");
  await page.goto("/chat/nope");
  await shot(page, "02-404", false);
  await mockStatus(page, () => ({ body: STATUS_FOUND }));
  await page.goto("/status");
  await shot(page, "03-status-empty");
  await page.getByLabel("Reference number").fill(REFERENCE);
  await page.getByLabel("Email").fill("ana@example.com");
  await page.getByRole("button", { name: "Look up" }).click();
  await expect(page.locator(".timeline")).toBeVisible();
  await shot(page, "04-status-found");
  await page.goto("/owner/login");
  await page.getByRole("button", { name: "Sign in" }).click();
  await shot(page, "05-owner-login-errors", false);
});

test("chat states", async ({ page }) => {
  await mockChat(page, (body) => ({
    body: body.event ? REPLY_CONFIRMED : body.message === "form" ? REPLY_PRODUCT_FORM : REPLY_STOCK,
  }));
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
  await page.goto("/chat/volt-supply");
  await shot(page, "10-chat-empty", false);
  await page
    .getByRole("group", { name: "Suggested questions" })
    .getByRole("button")
    .first()
    .click();
  await expect(page.locator(".msg--assistant .bubble").nth(1)).toBeVisible();
  await shot(page, "11-chat-reply", false);
  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await page.getByRole("button", { name: /see how it answered/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await shot(page, "12-chat-trace-sheet", false);
    await page.keyboard.press("Escape");
  }
  const input = page.locator("#chat-input");
  await input.fill("form");
  await input.press("Enter");
  const form = page.getByRole("region", { name: /Secure order form/ });
  await expect(form.getByLabel("First name")).toBeVisible();
  await form.scrollIntoViewIfNeeded();
  await shot(page, "13-form-empty", false);
  await form.getByRole("button", { name: "Review order" }).click();
  await page.waitForTimeout(100);
  await form.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await shot(page, "14-form-errors", false);
  await form.getByLabel("First name").fill("Ana");
  await form.getByLabel("Last name").fill("Rivera");
  await form.getByLabel("Email").fill("ana@example.com");
  await form.getByLabel("Mobile phone").fill("9075550123");
  await form.getByLabel("Street address").fill("1200 W 4th Ave");
  await form.getByLabel("City").fill("Anchorage");
  await form.getByLabel("State").selectOption("AK");
  await form.getByLabel("ZIP code").fill("99501");
  await form.getByRole("button", { name: "Review order" }).click();
  await expect(form.getByRole("button", { name: "Confirm order" })).toBeVisible();
  await form.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await shot(page, "15-review", false);
  await form.getByRole("button", { name: "Confirm order" }).click();
  await expect(form.locator(".success__ref")).toBeVisible();
  await page.waitForTimeout(600);
  await form.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await shot(page, "16-success", false);
});

test("chat errors + talk to a person", async ({ page }) => {
  await mockChat(page, (body, n) => {
    if ((body.event as { type?: string } | undefined)?.type === "request_human")
      return { body: REPLY_HUMAN };
    if (n === 0)
      return {
        status: 429,
        headers: { "Retry-After": "30" },
        body: { error: { code: "rate_limited", message: "Slow down" } },
      };
    return {
      body: chatText(
        "Sorry — I'm having trouble responding right now. Please try again in a moment, or use the **Talk to a person** button to reach the team.",
        [],
        { fallback: true, offerEscalation: true },
      ),
    };
  });
  await page.goto("/chat/mountpro-tv");
  const input = page.locator("#chat-input");
  await input.fill("How much to mount a 65 inch TV?");
  await input.press("Enter");
  await expect(page.locator(".msg-error")).toBeVisible();
  await input.fill("Hello?");
  await input.press("Enter");
  await expect(page.locator(".msg-error")).toHaveCount(2);
  await shot(page, "18-chat-errors", false);
  await page.locator(".composer__talk").click();
  await expect(page.getByRole("form", { name: "Talk to a person" })).toBeVisible();
  await shot(page, "19-chat-handoff", false);
  await page.getByLabel(/Your email/).fill("ana@example.com");
  await page.getByRole("button", { name: "Send to the team" }).click();
  await expect(page.locator(".event-pill")).toBeVisible();
  await shot(page, "19b-chat-handoff-sent", false);
});

test("booking form", async ({ page }) => {
  await mockChat(page, [REPLY_SERVICE_FORM]);
  await mockCheckout(page, { review: (b) => ({ body: serviceReview(String(b.slotId)) }) });
  await page.goto("/chat/mountpro-tv");
  await page.locator("#chat-input").fill("Book a mount");
  await page.locator("#chat-input").press("Enter");
  const form = page.getByRole("region", { name: /Secure booking form/ });
  await expect(form.locator(".time input:checked")).toHaveCount(1);
  await page.waitForTimeout(500);
  await form.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await shot(page, "17-booking-form", false);
  // Service details: open, top (size + mount) and bottom (conditions + price).
  await form.locator(".spec-section__summary").click();
  await form.locator(".spec-section").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await shot(page, "17c-booking-details-open", false);
  await form.getByText("Why does this cost more?").first().click();
  await form.locator(".spec-section__price").evaluate((el) => el.scrollIntoView({ block: "end" }));
  await shot(page, "17d-booking-details-conditions", false);
  await form.getByRole("radio", { name: /In-wall cable concealment/ }).check();
  await expect(form.locator(".spec-section__price")).toContainText("$494.11");
  await form.locator(".spec-section__price").evaluate((el) => el.scrollIntoView({ block: "end" }));
  await shot(page, "17e-booking-details-updated", false);
  await form.locator(".spec-section__summary").click();
  await form.getByLabel("First name").fill("Jordan");
  await form.getByLabel("Last name").fill("Lee");
  await form.getByLabel("Email").fill("jordan@example.com");
  await form.getByLabel("Mobile phone").fill("7205550188");
  await form.getByLabel("Street address").fill("1550 Blake St");
  await form.getByLabel("City").fill("Denver");
  await form.getByLabel("State").selectOption("CO");
  await form.getByLabel("ZIP code").fill("80202");
  await form.getByRole("button", { name: "Review booking" }).click();
  await expect(form.getByRole("button", { name: "Confirm booking" })).toBeVisible();
  await form.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await shot(page, "17b-booking-review", false);
});

test("owner dashboard tabs", async ({ page, context, baseURL }) => {
  await signInAsOwner(context, baseURL!);
  await mockOwnerApi(page, OWNER_DATA);
  await page.goto("/owner");
  await expect(page.locator(".stat")).toHaveCount(6);
  await shot(page, "20-owner-overview");
  const views = [
    "Orders",
    "Bookings",
    "Escalations",
    "Conversations",
    "Inventory",
    "Availability",
    "Notifications",
  ];
  for (const [i, view] of views.entries()) {
    await showOwnerView(page, view);
    await expect(ownerPanel(page).locator(".surface-card").first()).toBeVisible();
    await shot(page, `2${i + 1}-owner-${view.toLowerCase()}`);
  }
});

test("owner transcript drawer", async ({ page, context, baseURL }) => {
  await signInAsOwner(context, baseURL!);
  await mockOwnerApi(page, { ...OWNER_DATA, transcript: TRANSCRIPT });
  await page.goto("/owner#escalations");
  await ownerPanel(page).getByRole("button", { name: "Transcript" }).first().click();
  await expect(page.getByRole("dialog", { name: "Conversation transcript" })).toBeVisible();
  await shot(page, "29-owner-transcript", false);
});
