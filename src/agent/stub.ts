/**
 * TEST-ONLY scripted LLM (`OASIS_LLM_STUB=1`). Lets e2e/CI drive the real chat → tool →
 * checkout form → confirm → event flow without an Anthropic key, deterministically.
 *
 * It is an `LlmClient` that reads the conversation the runner sends and answers with real
 * tool calls (executed by the real tool layer against the real DB), then a short reply
 * built only from those tool results:
 *
 *   "buy" / "order" / "checkout" (product business) → search_catalog → start_checkout for the
 *       first in-stock product (qty = first number 1–99 in the message, default 1)
 *   "book" / "schedule" / "appointment" (service business) → list_services →
 *       check_availability (first service, first tier) → start_checkout with the first open slot
 *   price / "what do you offer" / "included" (service business) → list_services → a one-line
 *       answer; the app shows the service picker card
 *   "available" / "opening" / "next" (service business) → list_services → quote_service (first
 *       service, first tier) → check_availability → quote card + open-times card
 *   "do you have" / "stock" / "carry" (product business) → search_catalog for the keywords
 *       (the whole catalog when nothing matches) → product cards
 *   a reference `OAS-XXXX-XXXX` + an email → lookup_status
 *   checkout_completed / checkout_cancelled system events → confirmation reply
 *   anything else → get_policies → a one-line grounded answer
 *
 * Safety: honored only when `env.llmStubActive` (OASIS_LLM_STUB=1 AND a localhost APP_URL),
 * logs a loud warning when first used (and at server start, see src/instrumentation.ts),
 * and reports the model as `TEST_STUB_MODEL`, which the trace panel shows as "Test mode".
 * It never calls the network and reports zero tokens / $0.
 */
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { TEST_STUB_MODEL } from "@/contracts";
import type { LlmClient } from "./runner";

type Block = Anthropic.ContentBlockParam | Anthropic.ContentBlock;

interface ToolRecord {
  name: string;
  input: Record<string, unknown>;
  output: unknown;
  isError: boolean;
}

let seq = 0;

function message(
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; name: string; input: Record<string, unknown> }
  >,
): Anthropic.Message {
  const blocks = content.map((b) =>
    b.type === "text"
      ? { type: "text" as const, text: b.text, citations: null }
      : { type: "tool_use" as const, id: `toolu_stub_${++seq}`, name: b.name, input: b.input },
  );
  return {
    id: `msg_stub_${++seq}`,
    type: "message",
    role: "assistant",
    model: TEST_STUB_MODEL,
    content: blocks,
    stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as unknown as Anthropic.Message;
}

const say = (text: string) => message([{ type: "text", text }]);
const call = (name: string, input: Record<string, unknown>) =>
  message([{ type: "tool_use", name, input }]);

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function textOf(content: string | readonly object[]): string {
  if (typeof content === "string") return content;
  return content.map((b) => ("text" in b && typeof b.text === "string" ? b.text : "")).join("\n");
}

/** The current turn's opener (last plain-text user message) and the tool calls made since. */
function currentTurn(messages: Anthropic.MessageParam[]): { opener: string; tools: ToolRecord[] } {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user" && typeof m.content === "string") {
      start = i;
      break;
    }
  }
  const opener = start >= 0 ? (messages[start]!.content as string) : "";
  const tools: ToolRecord[] = [];
  const pending = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (const m of messages.slice(start + 1)) {
    if (typeof m.content === "string") continue;
    for (const b of m.content as Block[]) {
      if (b.type === "tool_use") {
        pending.set(b.id, { name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
      } else if (b.type === "tool_result") {
        const p = pending.get(b.tool_use_id);
        if (!p) continue;
        let output: unknown = null;
        try {
          output = JSON.parse(typeof b.content === "string" ? b.content : textOf(b.content ?? []));
        } catch {
          output = null;
        }
        tools.push({ ...p, output, isError: Boolean(b.is_error) });
      }
    }
  }
  return { opener, tools };
}

const unwrap = (s: string) => s.replace(/<\/?(customer_message|system_event)>/g, "").trim();

const last = (tools: ToolRecord[], name: string) =>
  [...tools].reverse().find((t) => t.name === name);

function errorReply(t: ToolRecord): Anthropic.Message {
  const o = t.output as { message?: unknown } | null;
  const msg = typeof o?.message === "string" ? o.message : "That didn't work.";
  return say(`Sorry — ${msg} Would you like to try something else, or talk to our support team?`);
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

function productPurchase(text: string, tools: ToolRecord[]): Anthropic.Message {
  const qty = Math.min(99, Math.max(1, Number(/\b([1-9]\d?)\b/.exec(text)?.[1] ?? 1)));
  const search = last(tools, "search_catalog");
  if (!search) {
    return call("search_catalog", {
      reason: "Find an in-stock product for this order.",
      query: "",
      limit: 25,
    });
  }
  const start = last(tools, "start_checkout");
  if (!start) {
    const results = ((search.output as { results?: unknown[] } | null)?.results ?? []) as {
      sku: string;
      qtyOnHand: number;
      inStock: boolean;
    }[];
    const pick = results.find((r) => r.inStock && r.qtyOnHand >= qty);
    if (!pick) return say("Sorry — nothing in the catalog has enough stock for that right now.");
    return call("start_checkout", {
      reason: "The customer is ready to buy, so prepare the secure checkout form.",
      kind: "product",
      lines: [{ sku: pick.sku, qty }],
    });
  }
  if (start.isError) return errorReply(start);
  const o = start.output as { summary: string; quote: { totalCents: number } };
  return say(
    `I've prepared a secure checkout for ${o.summary}. The total is ${usd(o.quote.totalCents)} including tax; shipping is added in the form once you enter your ZIP. Enter your details in the form below — no need to type them in chat.`,
  );
}

function serviceBooking(tools: ToolRecord[]): Anthropic.Message {
  const list = last(tools, "list_services");
  if (!list) return call("list_services", { reason: "See which services and tiers are offered." });
  const services = ((list.output as { services?: unknown[] } | null)?.services ?? []) as {
    code: string;
    name: string;
    tiers: { code: string; name: string; durationMin: number }[];
  }[];
  const svc = services[0];
  const tier = svc?.tiers[0];
  if (!svc || !tier) return say("Sorry — no services are available to book right now.");
  const avail = last(tools, "check_availability");
  if (!avail) {
    return call("check_availability", {
      reason: "Find the earliest open time long enough for this job.",
      serviceCode: svc.code,
      durationMin: Math.max(15, tier.durationMin),
      limit: 6,
    });
  }
  const start = last(tools, "start_checkout");
  if (!start) {
    const slots = ((avail.output as { slots?: unknown[] } | null)?.slots ?? []) as {
      slotId: string;
    }[];
    const slot = slots[0];
    if (!slot) return say("Sorry — there are no open times in the booking window right now.");
    return call("start_checkout", {
      reason: "The customer wants to book, so prepare the secure booking form.",
      kind: "service",
      selection: { serviceCode: svc.code, tierCode: tier.code, slotId: slot.slotId },
    });
  }
  if (start.isError) return errorReply(start);
  const o = start.output as { summary: string; quote: { totalCents: number } };
  return say(
    `I've prepared a secure booking for ${o.summary} at ${usd(o.quote.totalCents)}. I picked the earliest open time; you can choose another date and time in the form below.`,
  );
}

/** One line; the picker card (built by the app from list_services) carries the options. */
function serviceOptions(tools: ToolRecord[]): Anthropic.Message {
  const list = last(tools, "list_services");
  if (!list) return call("list_services", { reason: "Show the services and their options." });
  if (list.isError) return errorReply(list);
  return say("Here are our options. Pick what fits and I'll price it with the next open times.");
}

/** First service, first tier: price it and list the next open times (two cards). */
function nextOpening(tools: ToolRecord[]): Anthropic.Message {
  const list = last(tools, "list_services");
  if (!list) return call("list_services", { reason: "See which services and tiers are offered." });
  const svc = ((list.output as { services?: unknown[] } | null)?.services ?? [])[0] as
    { code: string; tiers: { code: string }[] } | undefined;
  const tier = svc?.tiers[0];
  if (!svc || !tier) return say("Sorry — no services are available to book right now.");
  const quote = last(tools, "quote_service");
  if (!quote) {
    return call("quote_service", {
      reason: "Price the basic visit so the open times match its length.",
      serviceCode: svc.code,
      tierCode: tier.code,
    });
  }
  if (quote.isError) return errorReply(quote);
  const q = quote.output as { totalLabel?: string; quote?: { durationMin?: number } };
  const avail = last(tools, "check_availability");
  if (!avail) {
    return call("check_availability", {
      reason: "Find the next open times long enough for this visit.",
      serviceCode: svc.code,
      durationMin: Math.max(15, q.quote?.durationMin ?? 60),
      limit: 6,
    });
  }
  return say(`A basic visit is ${q.totalLabel ?? "priced below"}. Here are the next open times.`);
}

const STOP_WORDS = new Set(
  "a an and any are as at be by can carry carries do does for from have i in inch is it me of on or please sell sells stock the to what which with you your".split(
    " ",
  ),
);

/** Search for the keywords; with no match, browse the catalog. The app shows product cards. */
function productSearch(text: string, tools: ToolRecord[]): Anthropic.Message {
  const query = text
    .toLowerCase()
    .replace(/[^a-z0-9/\s-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w))
    .slice(0, 4)
    .join(" ");
  const searches = tools.filter((t) => t.name === "search_catalog");
  const found = (t?: ToolRecord) =>
    ((t?.output as { results?: unknown[] } | null)?.results ?? []).length;
  if (searches.length === 0) {
    return call("search_catalog", { reason: "Find matching products with live stock.", query });
  }
  const latest = searches[searches.length - 1];
  if (found(latest) === 0 && searches.length === 1) {
    return call("search_catalog", {
      reason: "Nothing matched those words, so browse the catalog.",
      query: "",
      limit: 6,
    });
  }
  return found(latest) > 0
    ? say("Here's what we have in stock. Choose quantities to get your order total.")
    : say("Sorry — I couldn't find that in our catalog.");
}

function statusLookup(text: string, tools: ToolRecord[]): Anthropic.Message | null {
  const ref = /OAS-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/i.exec(text)?.[0];
  const email = /[^\s<>@]+@[^\s<>@]+\.[a-z]{2,}/i.exec(text)?.[0];
  if (!ref || !email) return null;
  const r = last(tools, "lookup_status");
  if (!r) {
    return call("lookup_status", {
      reason: "Look up the order with the reference and email provided.",
      reference: ref,
      email,
    });
  }
  const o = r.output as { found?: boolean; status?: string; reference?: string; message?: string };
  return say(
    o.found
      ? `${o.reference} is currently **${o.status}**.`
      : (o.message ?? "I couldn't find that order."),
  );
}

function generalAnswer(tools: ToolRecord[]): Anthropic.Message {
  const p = last(tools, "get_policies");
  if (!p) return call("get_policies", { reason: "Answer from the store's published policies." });
  const o = p.output as { businessName?: string; policies?: { title: string }[] } | null;
  const titles = (o?.policies ?? []).map((x) => x.title).slice(0, 4);
  return say(
    `I can help with ${o?.businessName ?? "this business"}: prices, availability, orders and bookings.` +
      (titles.length ? ` Policies I can explain: ${titles.join(", ")}.` : "") +
      ` Say "buy" or "book" to start a checkout.`,
  );
}

function systemEvent(text: string): Anthropic.Message {
  const ref = /Reference (OAS-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4})/.exec(text)?.[1];
  if (text.startsWith("checkout_completed") && ref) {
    const kind = /completed the secure (order|booking)/.exec(text)?.[1] ?? "order";
    return say(
      `Thank you — your ${kind} is confirmed. Your reference number is ${ref}. A confirmation email is on its way; you can check the status any time on the Status page.`,
    );
  }
  return say("No problem — the checkout form is closed. Would you like to change anything?");
}

/** The scripted client. Pure function of the request: same conversation → same reply. */
export function createStubLlmClient(): LlmClient {
  return {
    modelLabel: TEST_STUB_MODEL,
    async createMessage(params) {
      const system = Array.isArray(params.system)
        ? params.system.map((b) => b.text).join("\n")
        : (params.system ?? "");
      const isService = system.includes("on-site service appointments");
      const { opener, tools } = currentTurn(params.messages);
      const forceText = params.tool_choice?.type === "none";

      if (opener.startsWith("<system_event>")) return systemEvent(unwrap(opener));
      const text = unwrap(opener);
      const lower = text.toLowerCase();
      if (forceText) return say("Sorry — I couldn't finish that. Could you rephrase?");

      const status = statusLookup(text, tools);
      if (status) return status;
      const wantsBuy = /\b(buy|order|purchase|checkout)\b/.test(lower);
      const wantsBook = /\b(book|booking|schedule|appointment)\b/.test(lower);
      if (wantsBuy || wantsBook) {
        return isService ? serviceBooking(tools) : productPurchase(text, tools);
      }
      if (isService && /\b(available|availability|opening|openings|next)\b/.test(lower)) {
        return nextOpening(tools);
      }
      if (
        isService &&
        /\b(how much|price|prices|cost|costs|offer|options|include|included|quote)\b/.test(lower)
      ) {
        return serviceOptions(tools);
      }
      if (!isService && /\b(have|stock|carry|sell|sells|looking for)\b/.test(lower)) {
        return productSearch(text, tools);
      }
      return generalAnswer(tools);
    },
  };
}
