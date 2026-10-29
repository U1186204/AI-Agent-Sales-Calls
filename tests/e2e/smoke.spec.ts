import { expect, test } from "@playwright/test";
import { SCREENSHOT_DIR } from "../../playwright.config";

// Foundation smoke test; the UI module adds the full AT-01..AT-93 suite.
test("home page renders and lists the five businesses", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  for (const slug of [
    "volt-supply",
    "flowline-plumbing",
    "mountpro-tv",
    "greenstripe-lawn",
    "brightnest-cleaning",
  ]) {
    await expect(page.locator(`a[href="/chat/${slug}"]`)).toHaveCount(1);
  }
  // Opt-in like the design screenshots, so a normal run leaves no files behind.
  if (process.env.OASIS_SCREENSHOTS === "1") {
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/${testInfo.project.name}-home.png`,
      fullPage: true,
    });
  }
});
