/**
 * Network mocks for UI e2e tests (the API handlers are built by another module). Every
 * mocked body is parsed with the same schema the UI validates, so a fixture that drifts
 * from the contract fails loudly here instead of silently passing.
 */
import { expect, type Page, type Request, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  ChatResponse,
  CheckoutDraftView,
  CheckoutResult,
  CheckoutReview,
  DraftSelectionUpdated,
  DraftSlotsView,
  OWNER_ENDPOINTS,
  OWNER_ESCALATIONS_ENDPOINT,
  OwnerTranscript,
  StatusResponse,
  type OwnerTab,
  type ServiceConfig,
} from "../../../src/contracts";
import { SLOT_HOURS, productDraft, serviceDraft, serviceDraftUpdated, slotFor } from "./fixtures";

type Reply = { status?: number; body: unknown; headers?: Record<string, string> };
type ChatHandler = (body: Record<string, unknown>, n: number) => Reply;

export const json = (
  route: Route,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
    ...(headers ? { headers } : {}),
  });

/** Mock POST /api/chat. Returns the list of request bodies seen. */
export async function mockChat(page: Page, handler: ChatHandler | ChatResponse[]) {
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/chat", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    bodies.push(body);
    const n = bodies.length - 1;
    let reply: Reply;
    if (Array.isArray(handler)) {
      const r = handler[Math.min(n, handler.length - 1)]!;
      reply = { body: r };
    } else {
      reply = handler(body, n);
    }
    if ((reply.status ?? 200) < 300) ChatResponse.parse(reply.body);
    await json(route, reply.status ?? 200, reply.body, reply.headers);
  });
  return bodies;
}

export interface CheckoutMockOptions {
  review?: (body: Record<string, unknown>) => Reply;
  confirm?: (body: Record<string, unknown>, n: number) => Reply;
  slots?: (date: string) => Reply;
  /** PATCH /api/checkout/draft/:id/selection ("Service details"). */
  selection?: (body: Record<string, unknown>) => Reply;
}

/** Mock the checkout draft, slots, review and confirm endpoints. */
export async function mockCheckout(page: Page, opts: CheckoutMockOptions = {}) {
  const seen = {
    review: [] as Record<string, unknown>[],
    confirm: [] as Record<string, unknown>[],
    selection: [] as Record<string, unknown>[],
  };
  await page.route("**/api/checkout/draft/**", async (route) => {
    const url = new URL(route.request().url());
    const m = /\/api\/checkout\/draft\/([^/]+)(\/slots|\/selection)?$/.exec(url.pathname);
    if (!m) return json(route, 404, { error: "not_found" });
    const draftId = decodeURIComponent(m[1]!);
    if (m[2] === "/selection") {
      const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      seen.selection.push(body);
      const reply = opts.selection?.(body) ?? {
        body: serviceDraftUpdated(body.config as ServiceConfig),
      };
      if ((reply.status ?? 200) < 300) DraftSelectionUpdated.parse(reply.body);
      else CheckoutResult.parse(reply.body);
      return json(route, reply.status ?? 200, reply.body);
    }
    if (m[2]) {
      const date = url.searchParams.get("date") ?? "";
      const reply = opts.slots?.(date) ?? {
        body: { date, timezone: "America/Denver", slots: SLOT_HOURS.map((h) => slotFor(date, h)) },
      };
      if ((reply.status ?? 200) < 300) DraftSlotsView.parse(reply.body);
      return json(route, reply.status ?? 200, reply.body);
    }
    const draft = draftId.startsWith("draft_svc")
      ? serviceDraft()
      : draftId.startsWith("draft_prod")
        ? productDraft()
        : null;
    if (!draft) return json(route, 404, { error: "draft_not_found" });
    CheckoutDraftView.parse(draft);
    return json(route, 200, draft);
  });
  await page.route("**/api/checkout/review", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    seen.review.push(body);
    const reply = opts.review?.(body) ?? { status: 500, body: {} };
    if ((reply.status ?? 200) < 300) CheckoutReview.parse(reply.body);
    else if (reply.body && typeof reply.body === "object" && "ok" in reply.body)
      CheckoutResult.parse(reply.body);
    return json(route, reply.status ?? 200, reply.body);
  });
  await page.route("**/api/checkout/confirm", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    seen.confirm.push(body);
    const reply = opts.confirm?.(body, seen.confirm.length - 1) ?? { status: 500, body: {} };
    CheckoutResult.parse(reply.body);
    // Small delay so double-submit protection is actually exercised.
    await new Promise((r) => setTimeout(r, 150));
    return json(route, reply.status ?? 200, reply.body);
  });
  return seen;
}

export async function mockStatus(page: Page, reply: (body: Record<string, unknown>) => Reply) {
  await page.route("**/api/status", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    const r = reply(body);
    if ((r.status ?? 200) < 300) StatusResponse.parse(r.body);
    return json(route, r.status ?? 200, r.body);
  });
}

export async function mockOwnerApi(
  page: Page,
  data: { [K in OwnerTab | "escalations"]?: unknown } & { transcript?: unknown },
  status = 200,
) {
  const endpoints = { ...OWNER_ENDPOINTS, escalations: OWNER_ESCALATIONS_ENDPOINT };
  for (const [key, ep] of Object.entries(endpoints) as [
    keyof typeof endpoints,
    (typeof endpoints)[keyof typeof endpoints],
  ][]) {
    await page.route(`**${ep.path}`, async (route) => {
      const body = data[key];
      if (status < 300) ep.schema.parse(body);
      return json(route, status, body ?? {});
    });
  }
  await page.route("**/api/owner/conversations/*/transcript", async (route) => {
    const body = data.transcript;
    if (!body) return json(route, 404, { error: { code: "not_found", message: "Not found" } });
    if (status < 300) OwnerTranscript.parse(body);
    return json(route, status, body);
  });
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/** axe-core: zero serious/critical WCAG 2.1 A/AA violations. */
export async function expectNoSeriousA11yViolations(page: Page, label: string) {
  // Let entrance transitions finish: mid-fade colors make axe report false contrast failures.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const summary = bad.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
  );
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

export async function expectNoHorizontalScroll(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, "page must not scroll horizontally").toBeLessThanOrEqual(innerWidth);
}

/** The focused element shows a visible focus indicator (outline or ring). */
export async function expectVisibleFocus(page: Page) {
  const style = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    // Custom radio "pills" draw the ring on the label.
    const target = el.matches("input[type=radio]") ? (el.nextElementSibling as HTMLElement) : el;
    const cs = getComputedStyle(target);
    return { outline: cs.outlineStyle, width: cs.outlineWidth, shadow: cs.boxShadow };
  });
  expect(style, "an element must be focused").not.toBeNull();
  const visible = (style!.outline !== "none" && style!.width !== "0px") || style!.shadow !== "none";
  expect(visible, `focus indicator visible (${JSON.stringify(style)})`).toBe(true);
}

export const postBody = (req: Request) =>
  JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Owner dashboard navigation (tabs from 1024px, a "View" <select> below; VIS-5)
// ---------------------------------------------------------------------------

/** Show a dashboard view by its label, whichever control the viewport renders. */
export async function showOwnerView(page: Page, label: string) {
  const picker = page.locator("#view-select");
  if (await picker.isVisible()) {
    await picker.selectOption({ label });
    await expect(picker).toHaveValue(/.+/);
  } else {
    await page.getByRole("tab", { name: label, exact: true }).click();
    await expect(page.getByRole("tab", { name: label, exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  }
}

/** The visible dashboard panel (a tabpanel on wide screens, a labelled region otherwise). */
export const ownerPanel = (page: Page) => page.locator(".tabpanel");

/** Every listed control is at least 44×44 CSS px (A11Y-5). */
export async function expectTapTargets(page: Page, selector: string, label: string) {
  const small = await page.evaluate((sel) => {
    return [...document.querySelectorAll<HTMLElement>(sel)]
      .filter((el) => el.offsetParent !== null || getComputedStyle(el).position === "fixed")
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          what: `${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? "").trim().slice(0, 30)}"`,
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      })
      .filter((t) => t.w > 0 && (t.w < 44 || t.h < 44));
  }, selector);
  expect(small, `tap targets under 44px on ${label}`).toEqual([]);
}
