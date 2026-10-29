/** Shipping (AT-22), quotes (AT-30), escalation (AT-51), resilience (AT-81, AT-82). */
import { getPrisma } from "@/db";
import { moneyRe, out, type Harness } from "../harness";
import type { EvalCase } from "../types";

/** Ask for shipping to each ZIP; check zone + amount against the pricing engine. */
async function shippingTo(
  h: Harness,
  item: { sku: string; label: string },
  zips: { zip: string; state: string; zone: number }[],
) {
  for (const z of zips) {
    const t = await h.say(
      `What would shipping cost for 2 of ${item.label} (${item.sku}) to ZIP ${z.zip}?`,
    );
    const q = h.tool("quote_products", {
      turn: t,
      where: (c) => c.input.zip === z.zip,
      label: `quote_products to ${z.state} ${z.zip}`,
    });
    if (!q) continue;
    const quote = out(q).quote as { shippingCents?: number; shipZone?: number } | undefined;
    h.state(`${z.state}: zone ${z.zone}`, quote?.shipZone === z.zone, `zone ${quote?.shipZone}`);
    const expected = await h.d.quoteProducts(h.business, q.input.lines as never, z.zip);
    const ship = "quote" in expected ? expected.quote.shippingCents : -1;
    h.text(
      t,
      moneyRe(ship),
      `${z.state}: states the engine's shipping amount $${(ship / 100).toFixed(2)}`,
    );
    h.notText(t, /(don'?t|do not|can'?t|cannot|unable to) ship/i, `${z.state}: no region lock`);
  }
}

async function engineServiceCheck(h: Harness, turn: Awaited<ReturnType<Harness["say"]>>) {
  const q = h
    .calls(turn)
    .filter((c) => c.name === "quote_service" && !out(c).error && !out(c).invalid)
    .at(-1);
  h.check(
    "tool",
    "quote_service priced the selection",
    !!q,
    `tools: ${h
      .calls(turn)
      .map((c) => c.name)
      .join(", ")}`,
  );
  if (!q) return null;
  const r = await h.d.quoteService(h.business, q.input as never);
  if (!("quote" in r)) {
    h.state("engine re-quote succeeded", false, JSON.stringify(r));
    return null;
  }
  const ok =
    moneyRe(r.quote.totalCents).test(turn.reply) || moneyRe(r.quote.subtotalCents).test(turn.reply);
  h.state(
    `reply states the engine price exactly (total $${(r.quote.totalCents / 100).toFixed(2)} or subtotal $${(r.quote.subtotalCents / 100).toFixed(2)})`,
    ok,
    turn.reply.slice(0, 300),
  );
  return q.input as {
    tierCode?: string;
    addOns?: { code: string; qty?: number }[];
    surcharges?: { code: string }[];
    frequency?: string;
  };
}

export const opsCases: EvalCase[] = [
  {
    id: "shipping-ak-hi-pr",
    category: "shipping",
    business: "volt-supply",
    title: "Ships to Alaska, Hawaii, Puerto Rico",
    run: (h) =>
      shippingTo(h, { sku: "EL-BRK-1P20", label: "the 20 amp breakers" }, [
        { zip: "99501", state: "AK", zone: 8 },
        { zip: "96813", state: "HI", zone: 8 },
        { zip: "00901", state: "PR", zone: 8 },
      ]),
  },
  {
    id: "shipping-me-fl-ny",
    category: "shipping",
    business: "flowline-plumbing",
    title: "Ships to Maine, Florida, New York",
    run: (h) =>
      shippingTo(h, { sku: "PL-SB-CAP12", label: "the SharkBite 1/2 inch end caps" }, [
        { zip: "04101", state: "ME", zone: 5 },
        { zip: "33101", state: "FL", zone: 5 },
        { zip: "10001", state: "NY", zone: 4 },
      ]),
  },
  {
    id: "shipping-tx-ca-wa",
    category: "shipping",
    business: "volt-supply",
    title: "Ships to Texas, California, Washington",
    run: (h) =>
      shippingTo(h, { sku: "EL-GFCI-20", label: "the 20 amp GFCI outlets" }, [
        { zip: "75201", state: "TX", zone: 5 },
        { zip: "94103", state: "CA", zone: 8 },
        { zip: "98101", state: "WA", zone: 8 },
      ]),
  },
  {
    id: "quote-tv-addons-surcharges",
    category: "quote",
    business: "mountpro-tv",
    title: '65" over a brick fireplace with full-motion mount + in-wall cables',
    async run(h) {
      const t = await h.say(
        "65 inch TV going above a brick fireplace. I want a full-motion mount from you and the cables hidden in the wall. What's the total price?",
      );
      const sel = await engineServiceCheck(h, t);
      if (sel) {
        const codes = [...(sel.addOns ?? []), ...(sel.surcharges ?? [])].map((x) => x.code);
        h.state("tier L", sel.tierCode?.toUpperCase() === "L", sel.tierCode);
        h.state(
          "above-fireplace surcharge + full-motion mount selected",
          codes.includes("above-fireplace") && codes.includes("mount-full-motion"),
          codes.join(", "),
        );
      }
    },
  },
  {
    id: "quote-multi-fact-cleaning",
    category: "quote",
    business: "brightnest-cleaning",
    title: "Several facts in one message (deep clean, 3BR, 2 baths, oven)",
    async run(h) {
      const t = await h.say(
        "Deep clean please: 3 bedrooms, 2 full bathrooms, and inside the oven too. ZIP 98101. What would it cost?",
      );
      const sel = await engineServiceCheck(h, t);
      if (sel) {
        h.state("tier 3BR", sel.tierCode?.toUpperCase() === "3BR", sel.tierCode);
        h.state(
          "extra-bathroom ×1 + inside-oven",
          !!sel.addOns?.some((a) => a.code === "extra-bathroom" && (a.qty ?? 1) === 1) &&
            !!sel.addOns?.some((a) => a.code === "inside-oven"),
          JSON.stringify(sel.addOns),
        );
      }
      h.tool("quote_service", {
        where: (c) => c.input.serviceCode === "deep-clean",
        label: "quote_service deep-clean",
      });
    },
  },
  {
    id: "quote-recurring-lawn",
    category: "quote",
    business: "greenstripe-lawn",
    title: "Weekly mowing discount applied by the engine",
    async run(h) {
      const t = await h.say(
        "Weekly mowing for a quarter-acre lawn with edging — what's the price per visit?",
      );
      const sel = await engineServiceCheck(h, t);
      if (sel) h.state("frequency weekly", sel.frequency === "weekly", sel.frequency);
    },
  },
  {
    id: "escalation-requested",
    category: "escalation",
    business: "brightnest-cleaning",
    title: '"I want a human" → ticket, support email, response time',
    async run(h) {
      let t = await h.say("I want to talk to a real person, please.");
      if (!h.calls().some((c) => c.name === "escalate_to_support")) {
        h.notes.push("needed one clarifying turn before escalating");
        t = await h.say(
          "It's about rescheduling my cleaning. Please just connect me with someone.",
        );
      }
      const c = h.tool("escalate_to_support", { label: "escalate_to_support called" });
      const ticket = String(out(c).ticketId ?? "");
      h.state(
        "escalation row recorded for this conversation",
        (await h.prisma.escalation.count({
          where: { id: ticket, conversationId: h.conversationId! },
        })) === 1,
      );
      h.state(
        "support email logged",
        (await h.prisma.notification.count({
          where: { relatedRef: ticket, audience: "support" },
        })) === 1,
      );
      h.state(
        "conversation marked escalated",
        (await h.d.getConversation(h.conversationId!))?.escalated === true,
      );
      h.text(t, new RegExp(ticket.replace(/-/g, "\\-")), "reply gives the ticket number");
      h.text(t, /4 business hours/i, "reply gives the expected response time");
    },
  },
  {
    id: "escalation-frustration",
    category: "escalation",
    business: "flowline-plumbing",
    title: "Angry customer with a damaged delivery → escalates",
    async run(h) {
      const t = await h.say(
        "My water heater arrived dented and nobody has answered my emails for a week. This is ridiculous and I'm done waiting!",
      );
      const c = h.tool("escalate_to_support", { turn: t, label: "escalate_to_support called" });
      h.state(
        "category frustration/complaint",
        ["frustration", "complaint"].includes(String(c?.input.category)),
        String(c?.input.category),
      );
      h.text(t, /ESC-[A-Z0-9]{4}-[A-Z0-9]{4}/, "reply gives the ticket number");
      // Test correction (eval run 2): Flowline's warranty policy really does promise a free
      // replacement for items reported damaged within 7 days, so the judge is given that policy;
      // a reply that relays it is allowed, promising anything beyond it is not.
      await h.judge(
        "The final reply acknowledges the customer's frustration with empathy, confirms a human support ticket was created, and says when to expect a response — without promising a refund, credit or other outcome that policy does not state. Context: the business's warranty policy says items reported damaged or defective within 7 days are replaced at no cost, so relaying that policy is allowed.",
      );
    },
  },
  {
    id: "fault-llm-timeout",
    category: "resilience",
    business: "mountpro-tv",
    expectFallback: true,
    title: "LLM timeout → friendly fallback + escalation offer, then recovers",
    async run(h) {
      const t1 = await h.say("Hi, how much is it to mount a 32 inch TV?", { fault: "llm_timeout" });
      h.state("fallback flagged", t1.response.fallback === true);
      h.state("escalation offered", t1.response.offerEscalation === true);
      h.state("error code llm_unavailable", t1.response.error?.code === "llm_unavailable");
      h.state("no model call made", t1.modelCalls === 0);
      const t2 = await h.say("Trying again — how much to mount a 32 inch TV? I have a mount.");
      h.state("next turn recovers (no fallback)", !t2.response.fallback);
      h.text(t2, /\$99\b/, "recovered reply quotes the Small tier ($99)");
    },
  },
  {
    id: "fault-llm-error",
    category: "resilience",
    business: "greenstripe-lawn",
    expectFallback: true,
    title: "LLM API error → friendly fallback, no crash",
    async run(h) {
      const t1 = await h.say("Do you do leaf cleanup?", { fault: "llm_error" });
      h.state(
        "fallback flagged + escalation offered",
        t1.response.fallback && t1.response.offerEscalation,
      );
      h.state("error code llm_unavailable", t1.response.error?.code === "llm_unavailable");
      h.text(t1, /human|support|try again/i, "fallback copy points to support / retry");
      const stored = await h.d.getConversation(h.conversationId!, { withMessages: true });
      h.state(
        "user + fallback messages stored",
        stored?.messages?.map((m) => m.role).join(",") === "user,assistant",
      );
    },
  },
  {
    id: "budget-exceeded",
    category: "resilience",
    business: "volt-supply",
    expectFallback: true,
    title: "Session budget exhausted → fallback without an LLM call",
    async run(h) {
      const id = await h.ensureConversation();
      // Exhaust only THIS conversation's session budget. addUsage would also add the fake
      // $1.00 to the shared daily total and trip the daily cap for every case after this one.
      await getPrisma().conversation.update({ where: { id }, data: { costMicros: 1_000_000 } });
      const t = await h.say("What breakers do you have?");
      h.state("error code budget_exceeded", t.response.error?.code === "budget_exceeded");
      h.state("no model call made", t.modelCalls === 0 && !t.response.usage);
      h.state("escalation offered", t.response.offerEscalation === true);
    },
  },
];
