import { expect, test } from "@playwright/test";
import { REFERENCE, STATUS_FOUND, STATUS_NOT_FOUND } from "./support/fixtures";
import { OWNER_DATA, TRANSCRIPT } from "./support/owner-fixtures";
import {
  expectNoHorizontalScroll,
  expectNoSeriousA11yViolations,
  expectTapTargets,
  json,
  mockOwnerApi,
  mockStatus,
  ownerPanel,
  showOwnerView,
} from "./support/mocks";
import { signInAsOwner } from "./support/owner-session";

test.describe("status lookup (AT-50)", () => {
  test("validates, shows a timeline, and a generic not-found", async ({ page }) => {
    await mockStatus(page, (b) =>
      b.reference === REFERENCE && b.email === "ana@example.com"
        ? { body: STATUS_FOUND }
        : { body: STATUS_NOT_FOUND },
    );
    await page.goto("/status");
    await expect(page).toHaveTitle(/Track an order or booking/);
    await expectNoSeriousA11yViolations(page, "status");
    await expectNoHorizontalScroll(page);

    const ref = page.getByLabel("Reference number");
    await expect(ref).toHaveAttribute("aria-required", "true");
    await expect(page.getByLabel("Email")).toHaveAttribute("aria-required", "true");
    await page.getByRole("button", { name: "Look up" }).click();
    await expect(ref).toBeFocused();
    await expect(ref).toHaveAttribute("aria-invalid", "true");
    // Empty field: a plain instruction, not the format hint repeated (VIS-13).
    await expect(page.getByText("Enter your reference number")).toBeVisible();

    await ref.fill("oas-7k3m-q9td");
    await expect(ref).toHaveValue(REFERENCE);
    await page.getByLabel("Email").fill("ANA@example.com ");
    await page.getByRole("button", { name: "Look up" }).click();
    await expect(page.getByRole("heading", { name: REFERENCE })).toBeVisible();
    await expect(page.locator(".timeline__item[data-state='done']")).toHaveCount(2);
    await expect(page.locator(".timeline__item[data-state='current']")).toContainText("Shipped");
    // Display labels from the server, never "item(s)" (VIS-3); future steps in future tense.
    await expect(page.locator(".status-summary__lead")).toHaveText("2 items");
    await expect(page.locator(".timeline__item[data-state='todo']")).toContainText(
      "It will be dropped off",
    );
    await expectNoSeriousA11yViolations(page, "status found");

    await page.getByLabel("Email").fill("someone@example.com");
    await page.getByRole("button", { name: "Look up" }).click();
    await expect(page.getByText("We couldn't find an order or booking")).toBeVisible();
  });
});

test.describe("owner (AT-70, AT-71)", () => {
  test("login shows a generic error, then redirects to the dashboard", async ({
    page,
    context,
    baseURL,
  }) => {
    let attempts = 0;
    await page.route("**/api/owner/login", async (route) => {
      attempts++;
      if (attempts === 1)
        return json(route, 401, {
          error: "invalid_credentials",
          message: "Invalid username or password.",
        });
      // Real cookie for the proxy guard; the login handler itself is tested by the auth module.
      await signInAsOwner(context, baseURL!);
      return json(route, 200, { ok: true, csrfToken: "test-csrf-token" });
    });
    await mockOwnerApi(page, OWNER_DATA);

    await page.goto("/owner");
    await expect(page).toHaveURL(/\/owner\/login$/);
    await expect(page).toHaveTitle(/Owner sign in/);
    await expectNoSeriousA11yViolations(page, "owner login");
    await expectNoHorizontalScroll(page);

    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByLabel("Username")).toBeFocused();
    await expect(page.getByText("Username is required")).toBeVisible();

    await page.getByLabel("Username").fill("owner");
    await page.getByLabel("Password").fill("wrong");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("#login-error")).toHaveText(
      "That username and password don't match.",
    );
    await expect(page.getByLabel("Password")).toHaveValue("");

    await page.getByLabel("Password").fill("right");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/owner$/);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  test("dashboard views render, keyboard tabs on wide screens, sign out", async ({
    page,
    context,
    baseURL,
  }) => {
    const { csrf } = await signInAsOwner(context, baseURL!);
    await mockOwnerApi(page, OWNER_DATA);
    let logoutHeader: string | undefined;
    await page.route("**/api/owner/logout", async (route) => {
      logoutHeader = route.request().headers()["x-csrf-token"];
      await context.clearCookies();
      return json(route, 200, { ok: true });
    });

    await page.goto("/owner");
    await expect(page).toHaveTitle(/Owner dashboard/);
    await expect(page.getByText("Demo credentials in use.")).toBeVisible();
    await expect(page.locator(".owner-banner code", { hasText: "SESSION_SECRET" })).toBeVisible();
    await expect(page.locator(".stat")).toHaveCount(6);
    await expect(page.locator(".stat", { hasText: "Revenue today" })).toContainText("$612.41");
    await expectNoSeriousA11yViolations(page, "owner overview");
    await expectNoHorizontalScroll(page);

    const wide = (page.viewportSize()?.width ?? 0) >= 1024;
    // VIS-5: tabs only where all of them fit; a labelled "View" select below that.
    await expect(page.getByRole("tablist")).toHaveCount(wide ? 1 : 0);
    await expect(page.locator("#view-select")).toHaveCount(wide ? 0 : 1);
    if (wide) {
      const { scrollWidth, clientWidth } = await page
        .getByRole("tablist")
        .evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      // A11Y-9: only the selected tab points at a panel, and that panel exists.
      await expect(page.locator("[role=tab][aria-controls]")).toHaveCount(1);
      const controls = await page
        .locator("[role=tab][aria-controls]")
        .getAttribute("aria-controls");
      await expect(page.locator(`#${controls}`)).toHaveCount(1);
    } else if ((page.viewportSize()?.width ?? 0) < 768) {
      await expectTapTargets(
        page,
        "#view-select, #biz-filter, .owner-header-actions .btn",
        "owner",
      );
    }

    const expectations: [string, string][] = [
      ["Orders", "OAS-7K3M-Q9TD"],
      ["Bookings", "OAS-B4KX-2MRT"],
      ["Escalations", "ESC-AGFA-5DDA"],
      ["Conversations", "Escalated"],
      ["Inventory", "Out of stock"],
      ["Availability", "Marcus T."],
      ["Notifications", "Order OAS-7K3M-Q9TD confirmed"],
    ];
    for (const [tab, text] of expectations) {
      await showOwnerView(page, tab);
      await expect(ownerPanel(page)).toContainText(text);
      await expectNoSeriousA11yViolations(page, `owner ${tab}`);
      await expectNoHorizontalScroll(page);
    }
    // Bookings carry their zone (WF-7).
    await showOwnerView(page, "Bookings");
    await expect(ownerPanel(page)).toContainText("10:00 AM MDT");

    // Inventory: problems first, status in words; no traffic-light row fills (VIS-4).
    await showOwnerView(page, "Inventory");
    await expect(page.locator("tr[data-stock='out']")).toHaveCount(1);
    await expect(page.locator("tr[data-stock='low']")).toContainText("Running low");
    const fill = await page
      .locator("tr[data-stock='out'] td")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(fill).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);

    // Business filter.
    await page.getByLabel("Business").selectOption("flowline-plumbing");
    await expect(ownerPanel(page)).not.toContainText("Volt & Wire");

    // Arrow keys move between tabs (wide screens; the select is a native control).
    if (wide) {
      await page.getByRole("tab", { name: "Inventory" }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("tab", { name: "Availability" })).toBeFocused();
      await expect(page.getByRole("tab", { name: "Availability" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    }

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/owner\/login/);
    expect(logoutHeader).toBe(csrf);
  });

  test("dashboard sends the customer to login when the API says 401", async ({
    page,
    context,
    baseURL,
  }) => {
    await signInAsOwner(context, baseURL!);
    await mockOwnerApi(page, {}, 401);
    await page.goto("/owner");
    await expect(page).toHaveURL(/\/owner\/login$/);
  });
});

test.describe("owner escalations + transcripts (WF-2)", () => {
  test("Escalations and Conversations open an accessible transcript drawer", async ({
    page,
    context,
    baseURL,
  }) => {
    await signInAsOwner(context, baseURL!);
    await mockOwnerApi(page, { ...OWNER_DATA, transcript: TRANSCRIPT });
    await page.goto("/owner#escalations");
    const panel = ownerPanel(page);
    const row = panel.locator("tr", { hasText: "ESC-AGFA-5DDA" });
    await expect(row).toContainText("j***@e***.com");
    await expect(row).toContainText("Requested human");
    await expect(row.getByText("Open", { exact: true })).toBeVisible();
    await expect(panel.locator("tr", { hasText: "ESC-K9PR-2TQW" })).toContainText("Not shared");
    await expect(panel.locator("tr", { hasText: "ESC-K9PR-2TQW" })).toContainText("Not linked");

    const open = row.getByRole("button", { name: "Transcript" });
    await open.click();
    const dialog = page.getByRole("dialog", { name: "Conversation transcript" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Flowline Plumbing Supply · 3 messages");
    await expect(dialog.locator(".transcript__msg")).toHaveCount(3);
    await expect(dialog.locator(".transcript__msg").first()).toContainText("Customer");
    await page.waitForTimeout(450);
    await expectNoSeriousA11yViolations(page, "owner transcript");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(open).toBeFocused();

    // Same viewer from the Conversations list.
    await showOwnerView(page, "Conversations");
    const conv = ownerPanel(page).locator("tr", { hasText: "Flowline" });
    await conv.getByRole("button", { name: "Transcript" }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close transcript" }).click();
    await expect(dialog).toBeHidden();
  });
});
