/**
 * Agent tools: Anthropic tool definitions generated from the Zod contracts
 * (src/contracts/tools.ts) and the executor that maps each tool to src/domain.
 *
 * Isolation (SPEC §4): `businessId` and `conversationId` come from the server-side
 * conversation record passed in `ToolContext`; any such keys the model sends are stripped
 * before validation and ignored.
 */
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  LookupStatusOutput,
  EscalateToSupportOutput,
  TOOL_NAMES,
  TOOL_SCHEMAS,
  TRACE_MAX_REFS,
  type DataRef,
  type ToolName,
  type UiBlock,
} from "@/contracts";
import {
  checkAvailability,
  checkInventory,
  checkServiceArea,
  createCheckoutDraft,
  DomainError,
  getPolicies,
  getProduct,
  listServices,
  lookupStatus,
  quoteProducts,
  quoteService,
  recordEscalation,
  searchCatalog,
} from "@/domain";
import { checkStatusRateLimit, SHARED_CLIENT_KEY } from "@/guard/rate-limit";
import { sendEscalationEmail, type NotifyDeps } from "@/notify";

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  search_catalog:
    "Search this business's catalog by keywords and/or category. Returns products with price (cents), unit, weight and live stock. For service businesses returns matching services with starting prices. Use an empty query to browse.",
  get_product:
    "Get one product by exact SKU (price in cents, stock, weight). Returns notFound for SKUs not in this catalog.",
  check_inventory:
    "Check live stock for one or more SKU/quantity lines. Status per line: in_stock, partial (only `available` units), out_of_stock or not_found, with in-stock alternatives.",
  quote_products:
    "Required before stating any cart total, shipping, handling or tax. Prices a cart with the pricing engine: line totals, shipping to an optional destination ZIP (any US state or territory ZIP incl. AK, HI, PR; military APO/FPO/DPO not supported, see get_policies), heavy-item handling, tax and total, all in cents. `customerSummary` has the final figures (shipping already net of any free-shipping offer) and `totalLabel` — state that total verbatim, never add amounts up yourself. Without a ZIP the total excludes shipping (the checkout form computes it). Lines short on stock are priced at the available quantity and flagged in `issues`.",
  list_services:
    "Catalog overview of this business's services: tiers (base price, duration), add-ons, surcharges (with the customer-facing explanation of why each costs more), recurring frequencies and notes. Tier prices are starting prices only — call quote_service for any specific price; never add up these prices yourself.",
  quote_service:
    "Required before stating any service total, add-on combination, surcharge, discount (incl. recurring frequency) or duration. Prices one service configuration (serviceCode, tierCode, extraUnits, addOns, surcharges, frequency) with the pricing engine: itemized lines, tax, total (cents) plus a preformatted `totalLabel` to state verbatim, on-site duration in minutes (durationMin, pass it to check_availability), and surcharge explanations. If requiresOnSiteEstimate is true the job is longer than one appointment day: do not check availability or start checkout; explain it needs an on-site estimate and offer to connect the customer with a person.",
  check_availability:
    "Find open appointment start times. Pass serviceCode and durationMin (from quote_service) plus a single `date` or a fromDate/toDate range (YYYY-MM-DD, business-local). If the date is full, `fullyBooked` is true and `nextAvailable` lists the nearest openings. Each slot has a slotId for start_checkout.",
  check_service_area:
    "Check whether a US ZIP code is in this business's service area. Only use it when the customer gives or asks about a ZIP; never require a ZIP before quoting, checking availability or starting checkout (the secure form collects the address and the server checks the area).",
  get_policies:
    "Read this business's policies (shipping, returns, warranty, cancellation, guarantee, preparation, payment, privacy…) and support hours; for service businesses also each surcharge's explanation. Optional topic filter.",
  start_checkout:
    "Create a secure checkout and show the customer the inline form for their contact and address details (never collect those in chat). kind=product with lines [{sku, qty}], or kind=service with selection {serviceCode, tierCode, extraUnits, addOns, surcharges, frequency, slotId from check_availability}. Validates SKUs, stock and slot.",
  lookup_status:
    "Look up an order or booking by reference (OAS-XXXX-XXXX) plus the email used at checkout. A wrong pair returns a generic not-found.",
  escalate_to_support:
    "Hand the conversation to a human: records a support ticket and emails the support team a summary. category: requested_human, frustration, unresolved, complaint or other. The summary must not contain contact details (emails and phone numbers are removed automatically). One ticket per conversation: repeated calls return the same open ticket.",
};

// ---------------------------------------------------------------------------
// JSON schema generation
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

/**
 * Top-level `oneOf`/`anyOf` (discriminated unions such as start_checkout) is merged into one
 * object: properties are the union, `required` is the intersection. The executor still
 * validates with the exact Zod schema.
 */
function flattenTopLevel(schema: JsonSchema): JsonSchema {
  const variants = (schema.oneOf ?? schema.anyOf) as JsonSchema[] | undefined;
  if (schema.type === "object" || !variants) return schema;
  const properties: Record<string, JsonSchema> = {};
  let required: string[] | null = null;
  for (const v of variants) {
    const props = (v.properties ?? {}) as Record<string, JsonSchema>;
    for (const [k, p] of Object.entries(props)) {
      if (k === "kind" && properties.kind) {
        const prev = properties.kind;
        const values = [
          ...((prev.enum as unknown[]) ?? [prev.const]),
          ...((p.enum as unknown[]) ?? [p.const]),
        ];
        properties.kind = { type: "string", enum: [...new Set(values)] };
      } else if (k === "kind") {
        properties.kind = { type: "string", enum: (p.enum as unknown[]) ?? [p.const] };
      } else {
        properties[k] ??= p;
      }
    }
    const req = (v.required ?? []) as string[];
    required = required === null ? req : required.filter((r) => req.includes(r));
  }
  return { type: "object", properties, required: required ?? [] };
}

export function toolInputJsonSchema(name: ToolName): JsonSchema {
  const raw = z.toJSONSchema(TOOL_SCHEMAS[name].input, {
    io: "input",
    unrepresentable: "any",
  }) as JsonSchema;
  const { $schema: _drop, ...rest } = raw;
  return flattenTopLevel(rest);
}

let cachedTools: Anthropic.Tool[] | null = null;

/** Deterministic tool list (stable order → prompt-cache friendly). */
export function anthropicTools(): Anthropic.Tool[] {
  if (cachedTools) return cachedTools;
  cachedTools = TOOL_NAMES.map((name, i) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    input_schema: toolInputJsonSchema(name) as Anthropic.Tool.InputSchema,
    ...(i === TOOL_NAMES.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
  return cachedTools;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export interface ToolContext {
  businessId: string;
  businessName: string;
  conversationId: string;
  /** Client address of the chat request (status-lookup limiter, SEC-10). */
  ip?: string;
  notifyDeps?: NotifyDeps;
}

export interface ToolExecution {
  name: string;
  ok: boolean;
  /** Validated input (server keys stripped), or the raw input when validation failed. */
  input: Record<string, unknown>;
  /** What the model receives (JSON-serialisable, PII-free). */
  output: unknown;
  error?: string;
  /** Inline form to render (start_checkout success). */
  form?: Extract<UiBlock, { type: "form" }>;
  /** Conversation outcome side effect, for the runner's bookkeeping. */
  escalated?: boolean;
  /** True when the model tried to pass a server-owned key (businessId…). */
  strippedKeys: string[];
}

const SERVER_KEYS = /^(business_?id|conversation_?id|tenant_?id)$/i;

/** Deep-remove server-owned keys from model input. */
export function stripServerKeys(value: unknown, stripped: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((v) => stripServerKeys(v, stripped));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      if (SERVER_KEYS.test(k)) {
        stripped.push(k);
        continue;
      }
      out[k] = stripServerKeys(v, stripped);
    }
    return out;
  }
  return value;
}

const isToolName = (n: string): n is ToolName => (TOOL_NAMES as readonly string[]).includes(n);

function issuesOf(err: z.ZodError) {
  return err.issues
    .slice(0, 8)
    .map((i) => ({ field: i.path.join(".") || "(root)", message: i.message }));
}

/** Run one tool call. Never throws: failures come back as structured errors for the model. */
export async function executeTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolExecution> {
  const strippedKeys: string[] = [];
  const cleaned = (stripServerKeys(rawInput ?? {}, strippedKeys) ?? {}) as Record<string, unknown>;
  if (!isToolName(name)) {
    return {
      name,
      ok: false,
      input: cleaned,
      output: { error: "unknown_tool", message: `There is no tool named ${name}.` },
      error: "unknown_tool",
      strippedKeys,
    };
  }
  const parsed = TOOL_SCHEMAS[name].input.safeParse(cleaned);
  if (!parsed.success) {
    return {
      name,
      ok: false,
      input: cleaned,
      output: {
        error: "invalid_input",
        message: "The tool input did not match the schema. Fix the fields below and try again.",
        issues: issuesOf(parsed.error),
      },
      error: "invalid_input",
      strippedKeys,
    };
  }
  const input = parsed.data as Record<string, unknown>;
  try {
    const result = await run(name, input, ctx);
    return { name, input, strippedKeys, ...result };
  } catch (err) {
    if (err instanceof DomainError) {
      const message =
        err.code === "wrong_business_kind"
          ? `${ctx.businessName} does not offer that (${err.message}).`
          : "That record is not available for this business.";
      return {
        name,
        ok: false,
        input,
        output: { error: err.code, message },
        error: err.code,
        strippedKeys,
      };
    }
    return {
      name,
      ok: false,
      input,
      output: {
        error: "tool_failed",
        message:
          "This system could not be reached just now. Do not guess; tell the customer and offer support.",
      },
      error: "tool_failed",
      strippedKeys,
    };
  }
}

type RunResult = Omit<ToolExecution, "name" | "input" | "strippedKeys">;

type QuoteShape = {
  lines: { kind: string; code: string; qty: number; unitCents: number; amountCents: number }[];
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  shipZip?: string;
  durationMin?: number;
};

/**
 * Model-facing, unambiguous product-quote figures: shipping is already net of any free-shipping
 * offer, heavy handling is split out, and `totalLabel` is the exact figure to state.
 */
export function productQuoteSummary(q: QuoteShape) {
  const sum = (kind: string) =>
    q.lines.filter((l) => l.kind === kind).reduce((s, l) => s + l.amountCents, 0);
  const transport = sum("shipping");
  const handling = sum("handling");
  const shipped = q.shipZip !== undefined;
  const items = q.lines
    .filter((l) => l.kind === "goods")
    .map((l) => `${l.qty} × ${l.code} at ${usd(l.unitCents)} each = ${usd(l.amountCents)}`);
  const parts = [`goods ${usd(q.subtotalCents)} (${items.join("; ")})`];
  if (shipped) {
    parts.push(`ground shipping ${usd(transport)}`);
    if (handling > 0) parts.push(`heavy-item handling ${usd(handling)}`);
  }
  parts.push(`estimated tax ${usd(q.taxCents)}`);
  return {
    goodsCents: q.subtotalCents,
    shippingCents: shipped ? transport : null,
    handlingCents: shipped ? handling : null,
    taxCents: q.taxCents,
    totalCents: q.totalCents,
    totalLabel: usd(q.totalCents),
    explanation: `${parts.join(" + ")} = total ${usd(q.totalCents)}${
      shipped ? "" : " (shipping not included: no ZIP yet; the checkout form adds it)"
    }. Shipping shown is the final charge after any free-shipping offer. State these figures exactly; do not recompute.`,
  };
}

/** Model-facing service-quote figures with the exact total to state. */
export function serviceQuoteSummary(q: QuoteShape) {
  return {
    totalLabel: usd(q.totalCents),
    explanation: `Subtotal ${usd(q.subtotalCents)}${
      q.discountCents ? ` − discount ${usd(q.discountCents)}` : ""
    } + estimated tax ${usd(q.taxCents)} = total ${usd(q.totalCents)}${
      q.durationMin ? `; about ${minutesLabel(q.durationMin)} on site` : ""
    }. State these figures exactly; do not recompute.`,
  };
}

const ok = (output: unknown, extra: Partial<RunResult> = {}): RunResult => ({
  ok: true,
  output,
  ...extra,
});

async function run(
  name: ToolName,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<RunResult> {
  const b = ctx.businessId;
  switch (name) {
    case "search_catalog": {
      const i = input as z.output<typeof TOOL_SCHEMAS.search_catalog.input>;
      return ok(await searchCatalog(b, { query: i.query, category: i.category, limit: i.limit }));
    }
    case "get_product": {
      const i = input as z.output<typeof TOOL_SCHEMAS.get_product.input>;
      return ok(await getProduct(b, i.sku));
    }
    case "check_inventory": {
      const i = input as z.output<typeof TOOL_SCHEMAS.check_inventory.input>;
      const r = await checkInventory(b, i.items);
      return ok(TOOL_SCHEMAS.check_inventory.output.parse(r));
    }
    case "quote_products": {
      const i = input as z.output<typeof TOOL_SCHEMAS.quote_products.input>;
      const r = await quoteProducts(b, i.lines, i.zip);
      if (!("quote" in r)) return ok(r);
      return ok({ ...r, customerSummary: productQuoteSummary(r.quote) });
    }
    case "list_services": {
      const r = await listServices(b);
      return ok({
        pricingNote:
          "Tier prices are starting prices. For any specific price (add-ons, extra units, surcharges, frequency discounts, tax, duration) call quote_service and state its totalLabel; never add these up yourself.",
        services: r.services.map(({ tiers, ...s }) => ({
          ...s,
          tiers: tiers.map(({ priceCents, ...t }) => ({ ...t, startingPriceCents: priceCents })),
        })),
      });
    }
    case "quote_service": {
      const { reason: _r, ...config } = input as z.output<typeof TOOL_SCHEMAS.quote_service.input>;
      const r = await quoteService(b, config);
      if ("invalid" in r) return { ok: false, output: r, error: "invalid_selection" };
      if ("notFound" in r) return { ok: false, output: r, error: "not_found" };
      return ok({ ...r, ...serviceQuoteSummary(r.quote) });
    }
    case "check_availability": {
      const i = input as z.output<typeof TOOL_SCHEMAS.check_availability.input>;
      return ok(
        await checkAvailability(b, {
          serviceCode: i.serviceCode,
          durationMin: i.durationMin,
          date: i.date,
          fromDate: i.fromDate,
          toDate: i.toDate,
          limit: i.limit,
        }),
      );
    }
    case "check_service_area": {
      const i = input as z.output<typeof TOOL_SCHEMAS.check_service_area.input>;
      return ok(await checkServiceArea(b, i.zip));
    }
    case "get_policies": {
      const i = input as z.output<typeof TOOL_SCHEMAS.get_policies.input>;
      return ok(await getPolicies(b, i.topic));
    }
    case "start_checkout": {
      const i = input as z.output<typeof TOOL_SCHEMAS.start_checkout.input>;
      const r =
        i.kind === "product"
          ? await createCheckoutDraft(b, ctx.conversationId, { kind: "product", lines: i.lines })
          : await createCheckoutDraft(b, ctx.conversationId, {
              kind: "service",
              selection: i.selection,
            });
      if ("error" in r) return { ok: false, output: r, error: r.error };
      return ok(
        {
          ...r,
          note: "The secure form is now shown to the customer. Ask them to fill it in; do not ask for these details in chat.",
        },
        { form: { type: "form", draftId: r.draftId, kind: r.kind, summary: r.summary } },
      );
    }
    case "lookup_status": {
      const i = input as z.output<typeof TOOL_SCHEMAS.lookup_status.input>;
      // SEC-10: chat lookups count against the same anti-enumeration limiter as /api/status,
      // keyed per client address AND per conversation.
      const rl = checkStatusRateLimit(ctx.ip ?? SHARED_CLIENT_KEY, ctx.conversationId);
      if (!rl.ok) {
        return {
          ok: false,
          output: {
            error: "rate_limited",
            message: `Too many status lookups. Ask the customer to wait about ${Math.ceil(rl.retryAfterSec / 60)} minutes or use the Status page.`,
          },
          error: "rate_limited",
        };
      }
      const r = await lookupStatus(b, { reference: i.reference, email: i.email });
      // Contract parse drops firstName/items/totals: no PII reaches the model.
      return ok(LookupStatusOutput.parse(r));
    }
    case "escalate_to_support": {
      const i = input as z.output<typeof TOOL_SCHEMAS.escalate_to_support.input>;
      // The domain scrubs contact details (INJ-5) and reuses a recent open ticket (INJ-2).
      const r = await recordEscalation(b, ctx.conversationId, {
        reason: i.category,
        summary: i.summary,
      });
      if (!r.deduplicated)
        await sendEscalationEmail(
          {
            businessId: r.notification.businessId,
            businessName: r.notification.businessName,
            supportEmail: r.notification.supportEmail,
            ticketRef: r.notification.ticketId,
            reason: r.notification.reason,
            summary: r.notification.summary,
            contactEmail: r.notification.contactEmail,
          },
          ctx.notifyDeps,
        );
      return ok(
        EscalateToSupportOutput.parse({
          escalated: r.escalated,
          ticketId: r.ticketId,
          supportEmail: r.supportEmail,
          responseTime: r.responseTime,
        }),
        { escalated: true },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Trace helpers: readable summaries + data refs (all PII-free, VIS-1)
// ---------------------------------------------------------------------------

const usd = (c: unknown) =>
  typeof c === "number"
    ? `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "?";

type Obj = Record<string, unknown>;
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** "1 match" / "3 matches". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** `2026-10-13` → `Tue Oct 13` (calendar date, no timezone shift). */
export function friendlyDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return iso;
  return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** A slot summary → `Tue Oct 13, 9:00 AM` (business-local). */
export function slotLabel(s: Obj): string {
  const date = str(s.localDate);
  const time = str(s.localTime);
  return date ? `${friendlyDate(date)}${time ? `, ${time}` : ""}` : time || "Opening";
}

/** `Checkout #a1B2` — the last 4 characters of a draft id, never the whole id. */
export function draftLabel(draftId: string): string {
  return `Checkout #${draftId.slice(-4)}`;
}

function minutesLabel(min: unknown): string {
  if (typeof min !== "number" || !Number.isFinite(min)) return "";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** List of up to `n` items with "and N more". */
function listSome(items: string[], n = 3): string {
  const shown = items.slice(0, n).join("; ");
  return items.length > n ? `${shown}; and ${items.length - n} more` : shown;
}

/** One-line, PII-free, human summary of a tool output for the trace panel. */
export function summarizeToolOutput(
  name: string,
  exec: Pick<ToolExecution, "ok" | "output">,
): string {
  const o = (exec.output ?? {}) as Obj;
  if (!exec.ok || o.error) {
    const msg = typeof o.message === "string" ? o.message : String(o.error ?? "failed");
    return `Error: ${msg}`.slice(0, 300);
  }
  switch (name) {
    case "search_catalog": {
      const services = arr(o.services);
      if (services.length)
        return `${plural(services.length, "service")}: ${listSome(services.map((s) => str(s.name) || str(s.code)))}`;
      const r = arr(o.results);
      const total = typeof o.total === "number" ? o.total : r.length;
      return r.length
        ? `${plural(total, "match", "matches")}: ${listSome(
            r.map((p) => `${str(p.name) || str(p.sku)} ${usd(p.priceCents)}`),
          )}`
        : "No matching products";
    }
    case "get_product": {
      const p = o.product as Obj | undefined;
      return p
        ? `${str(p.name)} (${str(p.sku)}), ${usd(p.priceCents)}, ${plural(Number(p.qtyOnHand) || 0, "unit")} in stock`
        : `Not in this catalog: ${str(o.sku)}`;
    }
    case "check_inventory":
      return arr(o.items)
        .map((i) => {
          const status = String(i.status).replace(/_/g, " ");
          return `${str(i.name) || str(i.sku)}: ${status} (${Number(i.available) || 0} of ${Number(i.requested) || 0} available)`;
        })
        .join("; ");
    case "quote_products": {
      if (o.notFound) return String(o.message);
      const q = o.quote as Obj;
      const issues = arr(o.issues);
      return `Subtotal ${usd(q.subtotalCents)}, shipping ${usd(q.shippingCents)}${q.shipZone ? ` (zone ${q.shipZone})` : ""}, tax ${usd(q.taxCents)}, total ${usd(q.totalCents)}${issues.length ? ` · ${plural(issues.length, "issue")}: ${issues.map((i) => `${str(i.sku)} ${String(i.problem).replace(/_/g, " ")}`).join(", ")}` : ""}`;
    }
    case "list_services":
      return arr(o.services)
        .map(
          (s) =>
            `${str(s.name) || str(s.code)} (${plural(arr(s.tiers).length, "option")}, ${plural(arr(s.addOns).length, "add-on")})`,
        )
        .join("; ");
    case "quote_service": {
      const q = o.quote as Obj;
      if (o.requiresOnSiteEstimate)
        return `Needs an on-site estimate: about ${minutesLabel(q.durationMin)} on site, longer than one appointment day`;
      return `Total ${usd(q.totalCents)} incl. ${usd(q.taxCents)} tax · about ${minutesLabel(q.durationMin)}`;
    }
    case "check_availability": {
      const slots = arr(o.slots);
      const next = arr(o.nextAvailable);
      const day = str(o.requestedDate) ? friendlyDate(str(o.requestedDate)) : "";
      if (o.requiresOnSiteEstimate) return "Too long for one visit: needs an on-site estimate";
      if (o.closed) {
        return `Closed on ${day}${next.length ? `; next: ${listSome(next.map(slotLabel))}` : ""}`;
      }
      if (o.fullyBooked) {
        return `${day} is fully booked${next.length ? `; next: ${listSome(next.map(slotLabel))}` : ""}`;
      }
      if (slots.length)
        return `${plural(slots.length, "opening")}: ${listSome(slots.map(slotLabel))}`;
      return String(o.message ?? "No openings");
    }
    case "check_service_area":
      return String(o.message);
    case "get_policies": {
      const p = arr(o.policies);
      return `${plural(p.length, "policy", "policies")}: ${listSome(
        p.map((x) => str(x.title)),
        4,
      )}`;
    }
    case "start_checkout":
      return `Secure form ready: ${str(o.summary)} — total ${usd((o.quote as Obj)?.totalCents)}`;
    case "lookup_status":
      return o.found ? `${str(o.reference)}: ${str(o.status)}` : "No match (generic not-found)";
    case "escalate_to_support":
      return `Ticket ${str(o.ticketId)} sent to ${str(o.supportEmail)}; reply ${str(o.responseTime)}`;
    default:
      return "Done";
  }
}

export interface TraceRefs {
  refs: DataRef[];
  /** Further refs omitted beyond TRACE_MAX_REFS. */
  moreRefs: number;
}

/**
 * Human-readable data references, most relevant first, capped at TRACE_MAX_REFS (VIS-1):
 * SKUs/service codes as-is, slots as local times, drafts as "Checkout #xxxx", policies by
 * title, ZIPs as a prefix. Raw database ids (slot, draft, conversation) never appear.
 */
export function dataRefsFor(
  name: string,
  input: Record<string, unknown>,
  output: unknown,
): TraceRefs {
  const refs: DataRef[] = [];
  const add = (type: DataRef["type"], id: unknown) => {
    if (typeof id !== "string" || !id) return;
    if (!refs.some((r) => r.type === type && r.id === id)) refs.push({ type, id });
  };
  const o = (output ?? {}) as Obj;
  // What the model asked about first, then what came back.
  for (const l of [...arr(input.items), ...arr(input.lines)]) add("sku", l.sku);
  if (typeof input.sku === "string") add("sku", input.sku);
  const sel = (input.selection ?? input) as Obj;
  add("service", sel.serviceCode);
  if (o.product) add("sku", (o.product as Obj).sku);
  for (const i of arr(o.items)) add("sku", i.sku);
  for (const p of arr(o.results)) add("sku", p.sku);
  for (const s of arr(o.services)) add("service", s.code);
  for (const s of [...arr(o.slots), ...arr(o.nextAvailable)]) add("slot", slotLabel(s));
  for (const p of arr(o.policies)) add("policy", str(p.title) || str(p.key));
  if (typeof o.draftId === "string") add("draft", draftLabel(o.draftId));
  if (name === "lookup_status" && o.found)
    add(o.kind === "service" ? "booking" : "order", o.reference);
  add("ticket", o.ticketId);
  const zip = typeof input.zip === "string" ? input.zip : undefined;
  if (zip) add("zip", `${zip.slice(0, 3)}**`);
  return {
    refs: refs.slice(0, TRACE_MAX_REFS),
    moreRefs: Math.max(0, refs.length - TRACE_MAX_REFS),
  };
}

/** Input shown in the trace: empty values dropped, ISO dates as friendly local dates. */
export function traceInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (k === "slotId") continue; // raw DB id; the start time is in the result
    if (typeof v === "string" && /^(date|fromDate|toDate)$/.test(k)) {
      out[k] = friendlyDate(v);
      continue;
    }
    if (k === "selection" && v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = traceInput(v as Record<string, unknown>);
      continue;
    }
    out[k] = v;
  }
  return out;
}
