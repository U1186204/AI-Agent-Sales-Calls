/**
 * Helpers for the full-stack e2e specs (`fullstack-*.spec.ts`). These talk to the REAL server
 * (no page.route mocks): real route handlers, real SQLite (.data/e2e/oasis.db), mock email/SMS
 * outbox, and the TEST-ONLY scripted assistant (OASIS_LLM_STUB=1).
 */
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  ChatResponse,
  CheckoutResult,
  OWNER_ENDPOINTS,
  type OwnerTab,
} from "../../../src/contracts";
import type { z } from "zod";
import { E2E_BASE_URL } from "./e2e-env";
import { ownerCookieHeader } from "./owner-session";

export const ORIGIN = { origin: E2E_BASE_URL };

export interface Customer {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address1: string;
  city: string;
  state: string;
  zip: string;
}

/** Fictional customer (example.com, 555-01xx) with a unique email per test. */
export function newCustomer(tag: string, overrides: Partial<Customer> = {}): Customer {
  const id = `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return {
    firstName: "Robin",
    lastName: "Tester",
    email: `robin.${id}@example.com`,
    phone: "5125550123",
    address1: "100 Congress Ave",
    city: "Austin",
    state: "TX",
    zip: "78701",
    ...overrides,
  };
}

/** Send a chat message from the composer and return the real /api/chat response. */
export async function sendChat(page: Page, text: string): Promise<ChatResponse> {
  const input = page.locator("#chat-input");
  await input.fill(text);
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/chat") && r.request().method() === "POST"),
    input.press("Enter"),
  ]);
  expect(res.status()).toBe(200);
  return ChatResponse.parse(await res.json());
}

export function formBlock(r: ChatResponse) {
  const f = r.blocks.find((b) => b.type === "form");
  if (!f || f.type !== "form") throw new Error(`no form block in ${JSON.stringify(r.blocks)}`);
  return f;
}

/** SKU from a product form summary like "1 × Name (EL-XYZ)". */
export const skuOf = (summary: string) => /\(([A-Z0-9-]+)\)\s*$/.exec(summary.split(";")[0]!)?.[1];

export async function fillCustomer(form: Locator, c: Customer): Promise<void> {
  await form.getByLabel("First name").fill(c.firstName);
  await form.getByLabel("Last name").fill(c.lastName);
  await form.getByLabel("Email").fill(c.email);
  await form.getByLabel("Mobile phone").fill("");
  await form.getByLabel("Mobile phone").pressSequentially(c.phone);
  await form.getByLabel("Street address").fill(c.address1);
  await form.getByLabel("City").fill(c.city);
  await form.getByLabel("State").selectOption(c.state);
  await form.getByLabel("ZIP code").fill("");
  await form.getByLabel("ZIP code").pressSequentially(c.zip);
}

// ---------------------------------------------------------------------------
// API shortcuts (same endpoints the browser uses)
// ---------------------------------------------------------------------------

export async function apiChat(
  request: APIRequestContext,
  businessId: string,
  message: string,
): Promise<ChatResponse> {
  const res = await request.post("/api/chat", { headers: ORIGIN, data: { businessId, message } });
  expect(res.status()).toBe(200);
  return ChatResponse.parse(await res.json());
}

export async function apiConfirm(
  request: APIRequestContext,
  body: Record<string, unknown>,
): Promise<{ status: number; result: CheckoutResult; raw: Record<string, unknown> }> {
  const res = await request.post("/api/checkout/confirm", { headers: ORIGIN, data: body });
  const raw = (await res.json()) as Record<string, unknown>;
  return { status: res.status(), result: CheckoutResult.parse(raw), raw };
}

/** A confirmed electrical order made through the API. Returns its reference + email. */
export async function apiOrder(request: APIRequestContext, tag: string) {
  const chat = await apiChat(request, "volt-supply", "I want to buy 1");
  const form = formBlock(chat);
  const c = newCustomer(tag);
  const { result } = await apiConfirm(request, {
    kind: "product",
    draftId: form.draftId,
    conversationId: chat.conversationId,
    customer: c,
  });
  if (!result.ok) throw new Error(`confirm failed: ${result.code}`);
  return { reference: result.reference, email: c.email, draftId: form.draftId };
}

type OwnerData = { [K in OwnerTab]: z.output<(typeof OWNER_ENDPOINTS)[K]["schema"]> };

/** Owner dashboard JSON, validated with the dashboard's own schema. */
export async function ownerGet<K extends OwnerTab>(
  request: APIRequestContext,
  tab: K,
): Promise<OwnerData[K]> {
  const ep = OWNER_ENDPOINTS[tab];
  const res = await request.get(ep.path, { headers: { cookie: await ownerCookieHeader() } });
  expect(res.status(), tab).toBe(200);
  return ep.schema.parse(await res.json()) as OwnerData[K];
}

export async function stockOf(request: APIRequestContext, sku: string): Promise<number> {
  const inv = await ownerGet(request, "inventory");
  const row = inv.items.find((i) => i.sku === sku);
  if (!row) throw new Error(`SKU ${sku} not in inventory`);
  return row.qtyOnHand;
}

/** Open slot count for a business on one local date (all contractors). */
export async function openOn(request: APIRequestContext, businessId: string, date: string) {
  const av = await ownerGet(request, "availability");
  return av.items
    .filter((r) => r.businessId === businessId)
    .reduce((n, r) => n + (r.days.find((d) => d.date === date)?.open ?? 0), 0);
}
