import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations } from "./support/mocks";

const SLUGS = [
  "volt-supply",
  "flowline-plumbing",
  "mountpro-tv",
  "greenstripe-lawn",
  "brightnest-cleaning",
];

test.describe("home (AT-01, AT-90, AT-92)", () => {
  test("lists five businesses in two groups with working links", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Oasis/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const cards = page.locator(".biz-card");
    await expect(cards).toHaveCount(5);
    for (const slug of SLUGS)
      await expect(page.locator(`a.biz-card[href="/chat/${slug}"]`)).toHaveCount(1);
    // The group headings carry the kind; cards don't repeat it (VIS-9).
    await expect(page.locator(".group").first().locator(".biz-card")).toHaveCount(2);
    await expect(page.locator(".group").last().locator(".biz-card")).toHaveCount(3);
    await expect(page.locator(".biz-card .badge")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Owner sign in" })).toHaveAttribute(
      "href",
      "/owner/login",
    );
    await expect(
      page.getByRole("link", { name: /Track an order or booking/ }).first(),
    ).toHaveAttribute("href", "/status");

    await page.locator('a.biz-card[href="/chat/mountpro-tv"]').click();
    await expect(page).toHaveURL(/\/chat\/mountpro-tv$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "MountPro TV Installation" }),
    ).toBeVisible();
  });

  test("skip link moves focus to main content", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main$/);
  });

  test("is accessible and never scrolls sideways", async ({ page }) => {
    await page.goto("/");
    await expectNoHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page, "home");
  });

  test("unknown business slug returns the 404 page", async ({ page }) => {
    const res = await page.goto("/chat/not-a-business");
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: /couldn.t find that page/i })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "404");
  });
});
