/** Happy-path order or booking for each of the 5 businesses (AT-10, AT-30, AT-40, AT-52). */
import { linesOf, moneyRe, sameLines, type Harness } from "../harness";
import type { EvalCase } from "../types";

/** Shared post-checkout checks: reference in reply, record exists, notifications, outcome. */
async function afterCheckout(h: Harness, reference: string, kind: "order" | "booking") {
  const ev = h.turns.at(-1)!;
  h.text(ev, new RegExp(reference), "confirmation reply contains the reference");
  const conv = await h.d.getConversation(h.conversationId!);
  h.state(`conversation outcome = ${kind}`, conv?.outcome === kind, `outcome ${conv?.outcome}`);
  const notes = await h.prisma.notification.findMany({ where: { relatedRef: reference } });
  const aud = notes.map((n) => `${n.channel}:${n.audience}`).sort();
  h.state(
    "customer email + business email + business SMS logged",
    ["email:business", "email:customer", "sms:business"].every((a) => aud.includes(a)),
    aud.join(", "),
  );
  if (kind === "order") {
    const order = await h.prisma.order.findUnique({
      where: { reference },
      include: { payment: true },
    });
    h.state(
      "order saved for this business",
      order?.businessId === h.business,
      `order ${JSON.stringify(order?.businessId)}`,
    );
    h.state(
      "payment record none/not_required",
      order?.payment?.provider === "none" && order.payment.status === "not_required",
    );
    return order;
  }
  const booking = await h.prisma.booking.findUnique({ where: { reference } });
  h.state("booking saved for this business", booking?.businessId === h.business);
  const slots = booking
    ? await h.prisma.slot.findMany({ where: { coveredByBookingId: booking.id } })
    : [];
  h.state(
    "booked slots marked booked",
    slots.length > 0 && slots.every((s) => s.status === "booked"),
    `${slots.length} slot(s)`,
  );
  return booking;
}

export const happyPathCases: EvalCase[] = [
  {
    id: "happy-volt-order",
    category: "happy_path",
    business: "volt-supply",
    title: "Order 4 tamper-resistant outlets end to end",
    async run(h) {
      const before = await h.prisma.product.findFirst({
        where: { businessId: "volt-supply", sku: "EL-REC-20TR" },
      });
      const t1 = await h.say(
        "Hi! I need four of your 20 amp tamper-resistant duplex outlets (EL-REC-20TR). Are they in stock and what do they cost?",
      );
      h.tool(["get_product", "check_inventory", "search_catalog", "quote_products"], {
        turn: t1,
        label: "looked up EL-REC-20TR",
      });
      h.text(t1, moneyRe(380), "states the unit price $3.80 from the catalog");
      await h.sayUntilForm("Great, I'd like to order 4 please.");
      const sc = h.tool("start_checkout", { label: "start_checkout with the cart" });
      h.state(
        "checkout lines = 4 × EL-REC-20TR",
        sameLines(linesOf(sc), { "EL-REC-20TR": 4 }),
        JSON.stringify(sc?.input),
      );
      const { reference } = await h.completeCheckout();
      await afterCheckout(h, reference, "order");
      const after = await h.prisma.product.findFirst({
        where: { businessId: "volt-supply", sku: "EL-REC-20TR" },
      });
      h.state(
        "stock decremented by 4",
        (before?.qtyOnHand ?? 0) - (after?.qtyOnHand ?? 0) === 4,
        `${before?.qtyOnHand} → ${after?.qtyOnHand}`,
      );
    },
  },
  {
    id: "happy-flowline-order",
    category: "happy_path",
    business: "flowline-plumbing",
    title: "Quote a toilet + wax ring shipped to Texas, then order",
    async run(h) {
      const t1 = await h.say(
        "I need a two-piece elongated toilet and a wax ring, shipped to Dallas, TX 75201. What's the total with shipping?",
      );
      const q = h.tool("quote_products", {
        turn: t1,
        where: (c) => c.input.zip === "75201",
        label: "quote_products with ZIP 75201",
      });
      if (q) {
        const expected = await h.d.quoteProducts(
          "flowline-plumbing",
          q.input.lines as never,
          "75201",
        );
        const total = "quote" in expected ? expected.quote.totalCents : -1;
        h.text(
          t1,
          moneyRe(total),
          `total matches the pricing engine (${(total / 100).toFixed(2)})`,
        );
        h.state(
          "quote includes the toilet and the wax ring",
          "PL-TOI-ELON" in linesOf(q) && "PL-WAX-RING" in linesOf(q),
          JSON.stringify(q.input.lines),
        );
      }
      await h.sayUntilForm("Perfect, let's order one of each.");
      const sc = h.tool("start_checkout");
      h.state(
        "checkout lines = toilet + wax ring",
        sameLines(linesOf(sc), { "PL-TOI-ELON": 1, "PL-WAX-RING": 1 }),
        JSON.stringify(sc?.input),
      );
      const { reference } = await h.completeCheckout({ city: "Dallas", state: "TX", zip: "75201" });
      const order = await afterCheckout(h, reference, "order");
      h.state(
        "shipping charged to TX (zone 5)",
        (order as { shipZone?: number } | null)?.shipZone === 5,
      );
    },
  },
  {
    id: "happy-mountpro-booking",
    category: "happy_path",
    business: "mountpro-tv",
    title: 'Book a 55" TV mount with own bracket',
    async run(h) {
      const t1 = await h.say(
        "I'd like my 55 inch TV mounted on a drywall wall. I already have a mount. What does that cost?",
      );
      h.tool(["quote_service", "list_services"], { turn: t1 });
      h.text(t1, moneyRe(12900), "states the Medium tier price $129");
      const t2 = await h.say("What's your earliest availability?");
      h.tool("check_availability", { turn: t2 });
      await h.sayUntilForm("The earliest slot works for me — please book it.");
      const sc = h.tool("start_checkout", { where: (c) => c.input.kind === "service" });
      const sel = (sc?.input.selection ?? {}) as {
        serviceCode?: string;
        tierCode?: string;
        slotId?: string;
      };
      h.state(
        "selection tv-mounting / M with a slot",
        sel.serviceCode === "tv-mounting" && sel.tierCode?.toUpperCase() === "M" && !!sel.slotId,
        JSON.stringify(sel),
      );
      const { reference } = await h.completeCheckout({ city: "Denver", state: "CO", zip: "80202" });
      await afterCheckout(h, reference, "booking");
    },
  },
  {
    id: "happy-lawn-booking",
    category: "happy_path",
    business: "greenstripe-lawn",
    title: "Book a 1/4-acre mow with edging",
    async run(h) {
      const t1 = await h.say(
        "Can you mow my lawn? It's about a quarter acre in ZIP 60614, and I'd like edging too. How much?",
      );
      const q = h.tool("quote_service", { turn: t1 });
      if (q) {
        const r = await h.d.quoteService("greenstripe-lawn", q.input as never);
        const total = "quote" in r ? r.quote.totalCents : -1;
        h.text(t1, moneyRe(total), "price matches the pricing engine");
        const sel = q.input as { tierCode?: string; addOns?: { code: string }[] };
        h.state(
          "tier S + edging",
          sel.tierCode?.toUpperCase() === "S" && !!sel.addOns?.some((a) => a.code === "edging"),
          JSON.stringify(sel),
        );
      }
      const t2 = await h.say("When's your next opening?");
      h.tool("check_availability", { turn: t2 });
      await h.sayUntilForm("Book the first opening, please.");
      h.tool("start_checkout", { where: (c) => c.input.kind === "service" });
      const { reference } = await h.completeCheckout({
        city: "Chicago",
        state: "IL",
        zip: "60614",
      });
      await afterCheckout(h, reference, "booking");
    },
  },
  {
    id: "happy-brightnest-booking",
    category: "happy_path",
    business: "brightnest-cleaning",
    title: "Book a standard clean for a 2-bedroom",
    async run(h) {
      const t1 = await h.say(
        "I need a standard clean for my 2 bedroom, 1 bath apartment in 90012. What's the price and when can you come?",
      );
      const q = h.tool("quote_service", { turn: t1, label: "quote_service called" });
      if (q) h.text(t1, moneyRe(14000), "states $140 for a 2-bedroom standard clean");
      h.tool("check_availability", { label: "check_availability called" });
      await h.sayUntilForm("The earliest available time is fine, let's book it.");
      const sc = h.tool("start_checkout", { where: (c) => c.input.kind === "service" });
      const sel = (sc?.input.selection ?? {}) as { serviceCode?: string; tierCode?: string };
      h.state(
        "selection standard-clean / 2BR",
        sel.serviceCode === "standard-clean" && sel.tierCode?.toUpperCase() === "2BR",
        JSON.stringify(sel),
      );
      const { reference } = await h.completeCheckout({
        city: "Los Angeles",
        state: "CA",
        zip: "90012",
      });
      await afterCheckout(h, reference, "booking");
    },
  },
];
