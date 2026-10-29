/** Full-stack status lookup (AT-50) and owner auth (AT-70) — all three widths. */
import { expect, test } from "@playwright/test";
import { apiOrder } from "./support/fullstack";

test.describe("full stack: status lookup", () => {
  test("valid reference + email shows the status; wrong email → generic not-found", async ({
    page,
    request,
  }) => {
    const order = await apiOrder(request, "status");
    await page.goto("/status");
    await page.getByLabel("Reference number").fill(order.reference.toLowerCase());
    await page.getByLabel("Email").fill(order.email.toUpperCase());
    await page.getByRole("button", { name: "Look up" }).click();
    await expect(page.getByRole("heading", { name: order.reference })).toBeVisible();
    await expect(page.locator(".timeline__item[data-state='current']")).toContainText(
      "Order confirmed",
    );

    await page.getByLabel("Email").fill("someone.else@example.com");
    await page.getByRole("button", { name: "Look up" }).click();
    await expect(page.getByText(/could(n't| not) find an order or booking/)).toBeVisible();
    await expect(page.getByRole("heading", { name: order.reference })).toBeHidden();
  });
});

test.describe("full stack: owner auth", () => {
  test("redirects when signed out, generic error on a bad password, login + logout", async ({
    page,
  }) => {
    await page.goto("/owner");
    await expect(page).toHaveURL(/\/owner\/login$/);

    await page.getByLabel("Username").fill("owner");
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("#login-error")).toHaveText(
      "That username and password don't match.",
    );

    await page.getByLabel("Password").fill("oasis-demo-2026");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/owner$/);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText("Demo credentials in use.")).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/owner\/login/);
    await page.goto("/owner");
    await expect(page).toHaveURL(/\/owner\/login$/);
  });
});
