/** Full-stack security headers + per-request CSP nonce + hydration (AT-83), all widths. */
import { expect, test, type ConsoleMessage } from "@playwright/test";

test.describe("full stack: security headers + CSP nonce", () => {
  test("pages carry a per-request nonce CSP, hydrate, and log no CSP violations", async ({
    page,
  }) => {
    const problems: string[] = [];
    page.on("console", (m: ConsoleMessage) => {
      if (m.type() === "error" || /Content.Security.Policy|CSP/i.test(m.text())) {
        problems.push(`${m.type()}: ${m.text()}`);
      }
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

    const nonces: string[] = [];
    for (const path of ["/", "/status", "/chat/volt-supply", "/owner/login"]) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(200);
      const h = res!.headers();
      const csp = h["content-security-policy"] ?? "";
      const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
      expect(nonce, `${path} CSP: ${csp}`).toBeTruthy();
      expect(csp).toContain("'strict-dynamic'");
      expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
      expect(csp).toContain("frame-ancestors 'none'");
      expect(h["x-content-type-options"]).toBe("nosniff");
      expect(h["x-frame-options"]).toBe("DENY");
      expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(h["x-request-id"]).toBeTruthy();
      // Next stamped the same nonce on its scripts (the DOM hides the attribute; read the property).
      const scriptNonces = await page.evaluate(() =>
        [...document.scripts].map((s) => s.nonce).filter(Boolean),
      );
      expect(scriptNonces.length).toBeGreaterThan(0);
      expect(new Set(scriptNonces)).toEqual(new Set([nonce]));
      nonces.push(nonce!);
    }
    expect(new Set(nonces).size).toBe(nonces.length); // fresh per request

    // Hydrated: client-side validation runs on /status (a static form would just submit).
    await page.goto("/status");
    await page.getByRole("button", { name: "Look up" }).click();
    await expect(page.getByLabel("Reference number")).toHaveAttribute("aria-invalid", "true");
    expect(problems).toEqual([]);
  });
});
