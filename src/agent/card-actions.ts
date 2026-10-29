/**
 * Card clicks (`card_action` chat events), handled WITHOUT the LLM.
 *
 * The payload is codes, quantities and ids only (src/contracts/cards.ts CardAction). It is
 * schema-validated by the route, checked against this business's kind here, and then run
 * through the SAME tool layer the model uses (`executeTool`), so pricing, stock, slot and
 * service-area rules are identical and every step shows in the trace with a server-written
 * reason. The reply is one or two short templated sentences built from tool output only, and
 * the next card. Nothing the client sent is echoed into text the model later reads: the
 * stored app event names options by their config names, never by the submitted strings.
 */
import "server-only";
import { CardAction, type ServiceConfig, type TraceStep, type UiBlock } from "@/contracts";
import { formatUsd, getServiceDefinition } from "@/config/pricing";
import { appendMessage, getProduct } from "@/domain";
import { randomId } from "@/guard/crypto";
import type { Logger } from "@/guard/logger";
import { addDays, localDateString } from "@/lib/tz";
import type { NotifyDeps } from "@/notify";
import { formatDuration } from "@/ui-lib/format";
import { cartCard, estimateCard, quoteCard, servicePickerCard, slotCard } from "./cards";
import { executeTool, type ToolExecution } from "./tools";
import { clip, elapsedMs, guardStep, toolStep } from "./trace";

/** Days of open times a card lists from (business-local today or the "more" date). */
const SLOT_WINDOW_DAYS = 14;
const STORED_RESULT_MAX = 3000;

export interface CardActionContext {
  conversationId: string;
  businessId: string;
  businessName: string;
  kind: "product" | "service";
  timezone: string;
  ip?: string;
  notifyDeps?: NotifyDeps;
  now: Date;
  log: Logger;
}

export interface CardActionResult {
  text: string;
  blocks: UiBlock[];
  trace: TraceStep[];
  toolCalls: { name: string; input: Record<string, unknown>; output: unknown; ok: boolean }[];
  offerEscalation: boolean;
  /** Set when the action did not apply to this business (wrong kind). */
  rejected: boolean;
}

interface StoredRound {
  calls: { id: string; name: string; input: unknown }[];
  results: { id: string; content: string; isError: boolean }[];
}

const SERVICE_ACTIONS = new Set(["get_quote", "pick_slot", "more_times"]);

// ---------------------------------------------------------------------------
// Event text (config names only)
// ---------------------------------------------------------------------------

/** "Large (56"–70") TV wall mounting with Tilting mount supplied; Above fireplace; Weekly". */
export function describeConfig(businessId: string, config: ServiceConfig): string {
  const def = getServiceDefinition(businessId, config.serviceCode);
  if (!def) return "an unknown service";
  const tier = def.tiers.find((t) => t.code.toLowerCase() === config.tierCode.toLowerCase());
  const named = (
    list: readonly { code: string; name: string }[],
    picks: { code: string; qty: number }[],
  ) =>
    picks.map((p) => {
      const hit = list.find((x) => x.code === p.code);
      return hit ? (p.qty > 1 ? `${hit.name} × ${p.qty}` : hit.name) : "an unknown option";
    });
  const parts = [...named(def.addOns, config.addOns), ...named(def.surcharges, config.surcharges)];
  const freq = def.frequencies?.find((f) => f.code === config.frequency);
  const extra =
    tier?.extraUnit && config.extraUnits > 0
      ? ` + ${config.extraUnits} × ${tier.extraUnit.name}`
      : "";
  return (
    `${def.name}, ${tier?.name ?? "an unknown size"}${extra}` +
    (parts.length ? ` with ${parts.join("; ")}` : "") +
    (freq && freq.code !== "one_time" ? `, ${freq.name}` : "")
  );
}

/** True when every service code / SKU in the action exists in this business's catalog. */
async function knownCodes(businessId: string, action: CardAction): Promise<boolean> {
  if ("config" in action) {
    const c = action.config;
    const def = getServiceDefinition(businessId, c.serviceCode);
    if (!def) return false;
    const has = (list: readonly { code: string }[], code: string) =>
      list.some((x) => x.code === code);
    return (
      def.tiers.some((t) => t.code.toLowerCase() === c.tierCode.toLowerCase()) &&
      c.addOns.every((a) => has(def.addOns, a.code)) &&
      c.surcharges.every((s) => has(def.surcharges, s.code))
    );
  }
  for (const line of action.lines) {
    if (!("product" in (await getProduct(businessId, line.sku)))) return false;
  }
  return true;
}

function describeAction(businessId: string, action: CardAction): string {
  switch (action.action) {
    case "get_quote":
      return `asked for the price of: ${describeConfig(businessId, action.config)}`;
    case "pick_slot":
      return `picked an appointment time to book: ${describeConfig(businessId, action.config)}`;
    case "more_times":
      return `asked for more appointment times for: ${describeConfig(businessId, action.config)}`;
    case "quote_cart":
      return `asked for the price of a cart of ${action.lines.length} item line(s)${action.zip ? " with a shipping ZIP" : ""}`;
    case "checkout_cart":
      return `chose to check out a cart of ${action.lines.length} item line(s)`;
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runCardAction(
  rawAction: unknown,
  ctx: CardActionContext,
): Promise<CardActionResult> {
  const t0 = performance.now();
  const trace: TraceStep[] = [];
  const toolCalls: CardActionResult["toolCalls"] = [];
  const round: StoredRound = { calls: [], results: [] };
  const blocks: UiBlock[] = [];
  let offerEscalation = false;

  // Defense in depth: the route already parsed it; re-parse so defaults and limits hold
  // for every caller.
  const parsed = CardAction.safeParse(rawAction);
  const action = parsed.success ? parsed.data : null;
  const wantsService = action ? SERVICE_ACTIONS.has(action.action) : false;
  if (!action || wantsService !== (ctx.kind === "service")) {
    trace.push(
      guardStep(
        "guard-1",
        "Ignored an option from another kind of business",
        "The card action does not apply to this business, so nothing was run.",
        action ? `Rejected: ${action.action}` : "Rejected: malformed card action",
        false,
        "invalid_request",
        elapsedMs(t0),
      ),
    );
    ctx.log.warn("card_action_rejected", { action: action?.action ?? "malformed", kind: ctx.kind });
    const text = `That option isn't available here. How can I help with ${ctx.businessName}?`;
    await persist(ctx, null, round, text, trace);
    return { text, blocks: [], trace, toolCalls, offerEscalation: false, rejected: true };
  }

  // Every code must exist in THIS business's catalog before any tool runs, so a string the
  // client made up never reaches a stored tool round (and with it, the model's history).
  if (!(await knownCodes(ctx.businessId, action))) {
    trace.push(
      guardStep(
        "guard-1",
        "Ignored unknown options",
        "The card sent an option this business does not offer, so nothing was priced.",
        `Rejected: ${action.action}`,
        false,
        "invalid_request",
        elapsedMs(t0),
      ),
    );
    ctx.log.warn("card_action_unknown_codes", { action: action.action });
    const picker = wantsService ? servicePickerCard(ctx.businessId) : null;
    if (picker) blocks.push(picker);
    const text = wantsService
      ? "Some of those options aren't available. Please choose again below."
      : "Some of those items aren't in our catalog. Ask me about a product and I'll show what's in stock.";
    await persist(ctx, null, round, text, trace);
    return { text, blocks, trace, toolCalls, offerEscalation: false, rejected: false };
  }

  const call = async (name: string, input: Record<string, unknown>): Promise<ToolExecution> => {
    const started = performance.now();
    const exec = await executeTool(name, input, {
      businessId: ctx.businessId,
      businessName: ctx.businessName,
      conversationId: ctx.conversationId,
      ip: ctx.ip,
      notifyDeps: ctx.notifyDeps,
    });
    const id = `toolu_card_${randomId()}`;
    const content = JSON.stringify(exec.output);
    round.calls.push({ id, name, input: exec.input });
    round.results.push({ id, content: clip(content, STORED_RESULT_MAX), isError: !exec.ok });
    toolCalls.push({ name, input: exec.input, output: exec.output, ok: exec.ok });
    trace.push(toolStep(id, name, exec, elapsedMs(started)));
    return exec;
  };

  const today = localDateString(ctx.now, ctx.timezone);

  /** quote_service → quote card (or estimate card). Returns the quote details when bookable. */
  const quote = async (config: ServiceConfig) => {
    const q = await call("quote_service", { ...config, reason: "Price the options you picked" });
    const out = q.output as Record<string, unknown> & { quote?: unknown };
    if (!q.ok || !out.quote) return { ok: false as const };
    const card = quoteCard(ctx.businessId, config, out as Parameters<typeof quoteCard>[2]);
    if (!card) return { ok: false as const };
    return {
      ok: true as const,
      card,
      totalLabel: String(out.totalLabel ?? ""),
      durationMin: card.type === "quote_card" ? card.durationMin : 0,
    };
  };

  /** check_availability over SLOT_WINDOW_DAYS from `from` → slot card or null. */
  const times = async (config: ServiceConfig, durationMin: number, from: string) => {
    const a = await call("check_availability", {
      reason: "Find open times for this visit",
      serviceCode: config.serviceCode,
      durationMin: Math.min(720, Math.max(15, durationMin)),
      fromDate: from,
      toDate: addDays(from, SLOT_WINDOW_DAYS - 1),
      limit: 6,
    });
    if (!a.ok) return null;
    return slotCard(
      ctx.businessId,
      config,
      durationMin,
      a.output as Parameters<typeof slotCard>[3],
    );
  };

  const optionsTrouble = () => {
    const picker = servicePickerCard(ctx.businessId);
    if (picker) blocks.push(picker);
    return "Some of those options can't be combined. Please adjust them below and try again.";
  };

  let text: string;
  switch (action.action) {
    case "get_quote": {
      const q = await quote(action.config);
      if (!q.ok) {
        text = optionsTrouble();
        break;
      }
      blocks.push(q.card);
      if (q.card.type === "estimate_card") {
        offerEscalation = true;
        text =
          "That job is longer than one visit, so it needs an on-site estimate. A person from our team can set that up.";
        break;
      }
      const slots = await times(q.card.config, q.durationMin, today);
      if (slots) blocks.push(slots);
      text =
        `That comes to ${q.totalLabel} with estimated tax, about ${formatDuration(q.durationMin)} on site.` +
        (slots
          ? " Pick a time below to book it."
          : " I don't see open times in the next two weeks; ask me about a later date or talk to a person.");
      break;
    }
    case "more_times": {
      const q = await quote(action.config);
      if (!q.ok || q.card.type !== "quote_card") {
        text = optionsTrouble();
        break;
      }
      const from = action.fromDate < today ? today : action.fromDate;
      const slots = await times(q.card.config, q.durationMin, from);
      if (slots) blocks.push(slots);
      text = slots
        ? "Here are more open times."
        : "I don't see more open times in the two weeks after that. Ask me about another date or talk to a person.";
      break;
    }
    case "pick_slot": {
      const s = await call("start_checkout", {
        reason: "Open the secure booking form for this time",
        kind: "service",
        selection: { ...action.config, slotId: action.slotId },
      });
      if (s.ok && s.form) {
        blocks.push(s.form);
        text =
          "Your secure booking form is ready below. Check the details, then add your contact info and address.";
        break;
      }
      const error = (s.output as { error?: string }).error;
      if (error === "slot_unavailable") {
        const q = await quote(action.config);
        const slots =
          q.ok && q.card.type === "quote_card"
            ? await times(q.card.config, q.durationMin, today)
            : null;
        if (slots) blocks.push(slots);
        text = slots
          ? "That time was just taken. Here are the nearest open times."
          : "That time was just taken, and I don't see other openings in the next two weeks. Talk to a person and we'll find one.";
        if (!slots) offerEscalation = true;
      } else if (error === "requires_on_site_estimate") {
        const def = getServiceDefinition(ctx.businessId, action.config.serviceCode);
        blocks.push(estimateCard(def?.name ?? "This job"));
        offerEscalation = true;
        text =
          "That job is longer than one visit, so it needs an on-site estimate. A person from our team can set that up.";
      } else {
        text = optionsTrouble();
      }
      break;
    }
    case "quote_cart": {
      const q = await call("quote_products", {
        reason: "Price your order",
        lines: action.lines,
        ...(action.zip ? { zip: action.zip } : {}),
      });
      const out = q.output as { quote?: unknown; customerSummary?: { totalLabel?: string } };
      const card =
        q.ok && out.quote
          ? await cartCard(ctx.businessId, out as Parameters<typeof cartCard>[1])
          : null;
      if (!card) {
        text = "I couldn't price that order. Please check the items and try again.";
        break;
      }
      blocks.push(card);
      const total = out.customerSummary?.totalLabel ?? formatUsd(card.quote.totalCents);
      text =
        `Your order comes to ${total}` +
        (card.quote.shipZip
          ? " with shipping and estimated tax."
          : " with estimated tax, before shipping. Add a ZIP for a shipping estimate, or check out and the form adds it.") +
        (card.issues.length ? " Some quantities changed to what's in stock." : "");
      break;
    }
    case "checkout_cart": {
      const s = await call("start_checkout", {
        reason: "Open the secure order form for this cart",
        kind: "product",
        lines: action.lines,
      });
      if (s.ok && s.form) {
        blocks.push(s.form);
        text = "Your secure order form is ready below. Add your contact info and shipping address.";
        break;
      }
      const q = await call("quote_products", { reason: "Re-check your cart", lines: action.lines });
      const out = q.output as { quote?: unknown };
      const card =
        q.ok && out.quote
          ? await cartCard(ctx.businessId, out as Parameters<typeof cartCard>[1])
          : null;
      if (card) blocks.push(card);
      text = "Some items changed in stock since you added them. Please check the cart below.";
      break;
    }
  }

  await persist(ctx, action, round, text, trace);
  ctx.log.info("card_action", {
    conversationId: ctx.conversationId,
    action: action.action,
    tools: toolCalls.map((t) => t.name),
    cards: blocks.map((b) => b.type),
    ms: elapsedMs(t0),
  });
  return { text, blocks, trace, toolCalls, offerEscalation, rejected: false };
}

/** Store the turn like a model turn: app event (opener) → tool round → assistant reply. */
async function persist(
  ctx: CardActionContext,
  action: CardAction | null,
  round: StoredRound,
  text: string,
  trace: TraceStep[],
) {
  await appendMessage(
    ctx.conversationId,
    "system",
    action
      ? `card_action: The customer used an in-chat card and ${describeAction(ctx.businessId, action)}. The app ran the tools itself and showed the result as a card; continue from it.`
      : "card_action: The customer used an in-chat card option that does not apply to this business; nothing was run.",
  );
  if (round.calls.length) {
    await appendMessage(ctx.conversationId, "tool", JSON.stringify({ rounds: [round] }));
  }
  await appendMessage(ctx.conversationId, "assistant", text, trace);
}
