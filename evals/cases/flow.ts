/** Mid-flow questions (AT-11), corrections / start over (AT-14), stock (AT-20/21), availability (AT-31). */
// Test correction (eval run 2): the global "never asks for personal data in chat" check no
// longer flags a ZIP question on its own (ZIP is not form-only PII). In its place, the two cases
// that got stuck on ZIP gating (midflow-fireplace-why, corrections-multiple) assert that the
// agent asks for a ZIP at most once and still reaches start_checkout.
import { linesOf, longDate, out, sameLines, testCustomer, zipAsks } from "../harness";
import type { EvalCase } from "../types";

const outputHas = (o: unknown, needle: RegExp) => needle.test(JSON.stringify(o ?? ""));

export const flowCases: EvalCase[] = [
  // ---------------------------------------------------------------- mid-flow questions
  {
    id: "midflow-fireplace-why",
    category: "mid_flow_question",
    business: "mountpro-tv",
    title: "Asks why above-fireplace costs more in the middle of booking (regression)",
    async run(h) {
      const t1 = await h.say(
        "Hi, I want my 65 inch TV mounted above my fireplace. It's drywall, and I need a tilting mount from you. How much?",
      );
      h.tool("quote_service", {
        turn: t1,
        where: (c) => JSON.stringify(c.input.surcharges ?? []).includes("above-fireplace"),
        label: "quote_service includes the above-fireplace surcharge",
      });
      const t2 = await h.say("OK. Do you have anything next week?");
      h.tool("check_availability", { turn: t2 });
      const t3 = await h.say(
        "Before I pick a time — why does mounting above the fireplace cost more?",
      );
      const grounded = h
        .calls()
        .some(
          (c) =>
            ["get_policies", "quote_service", "list_services"].includes(c.name) &&
            outputHas(c.output, /chimney/i),
        );
      h.state(
        "explanation comes from tool data (surcharge explanation seen in a tool result)",
        grounded,
      );
      h.text(t3, /\$100\b/, "mentions the $100 surcharge");
      const reasons = [
        "ladder",
        "height",
        "stud",
        "chimney",
        "heat",
        "temperature",
        "mantel",
        "cable",
        "risk",
      ].filter((w) => new RegExp(w, "i").test(t3.reply));
      h.state(
        "gives at least two concrete reasons",
        reasons.length >= 2,
        `reasons found: ${reasons.join(", ") || "none"}`,
      );
      await h.judge(
        "The final reply directly answers WHY above-fireplace mounting costs more, with concrete reasons, before (or instead of) asking the customer to pick a time. It must NOT just re-ask for a date/time or ignore the question.",
      );
      await h.sayUntilForm(
        "Thanks, that makes sense. The first available slot is fine — let's book it.",
      );
      const zips = zipAsks(h.turns.map((t) => t.reply));
      h.state("asks for a ZIP at most once", zips <= 1, `${zips} replies asked for a ZIP`);
      h.tool("start_checkout", {
        where: (c) => JSON.stringify(c.input).includes("above-fireplace"),
        label: "booking resumes with the above-fireplace selection",
      });
    },
  },
  {
    id: "midflow-returns-question",
    category: "mid_flow_question",
    business: "flowline-plumbing",
    title: "Asks about returns mid-order, then resumes",
    async run(h) {
      await h.say("I'd like 3 SharkBite 1/2 inch couplings (PL-SB-CPL12).");
      const t2 = await h.say(
        "Actually, first — what's your return policy if I end up not using them?",
      );
      h.tool("get_policies", { turn: t2 });
      h.text(t2, /30[- ]day|30 days/i, "states the 30-day return window from policy");
      await h.judge(
        "The final reply answers the return-policy question (unused items in original packaging, 30 days) and then restates the single next step for the coupling order.",
      );
    },
  },
  {
    id: "midflow-lawn-weather",
    category: "mid_flow_question",
    business: "greenstripe-lawn",
    title: "Asks what happens if it rains while getting a quote",
    async run(h) {
      const t1 = await h.say("Quote me a one-time mow for a half-acre lawn in ZIP 75001.");
      h.tool("quote_service", {
        turn: t1,
        where: (c) => String(c.input.tierCode).toUpperCase() === "M",
        label: "quote_service tier M",
      });
      const t2 = await h.say("And what happens if it rains on the day of the appointment?");
      h.tool("get_policies", { turn: t2 });
      h.text(t2, /reschedul/i, "explains weather rescheduling from policy");
      h.text(t2, /no (extra )?charge|free|at no cost/i, "says weather reschedules are free");
      await h.judge(
        "The final reply answers the rain question from the weather policy and then offers the next step toward booking.",
      );
    },
  },
  // ---------------------------------------------------------------- corrections
  {
    id: "corrections-multiple",
    category: "corrections",
    business: "volt-supply",
    title: "Changes quantities three times, fixes a ZIP in the form, confirms",
    async run(h) {
      const gfci0 = await h.prisma.product.findFirst({
        where: { businessId: "volt-supply", sku: "EL-GFCI-20" },
      });
      const brk0 = await h.prisma.product.findFirst({
        where: { businessId: "volt-supply", sku: "EL-BRK-1P20" },
      });
      await h.say("I need 4 GFCI outlets, the 20 amp self-test ones.");
      await h.say("Actually make it 6.");
      await h.say("Sorry — change that to 5, and add 2 of the 20 amp single-pole breakers.");
      await h.sayUntilForm("That's everything. Let's check out.");
      const zips = zipAsks(h.turns.map((t) => t.reply));
      h.state("asks for a ZIP at most once", zips <= 1, `${zips} replies asked for a ZIP`);
      const sc = h.tool("start_checkout");
      h.state(
        "checkout uses the latest values: 5 × EL-GFCI-20 + 2 × EL-BRK-1P20",
        sameLines(linesOf(sc), { "EL-GFCI-20": 5, "EL-BRK-1P20": 2 }),
        JSON.stringify(sc?.input.lines),
      );
      const bad = await h.review(testCustomer({ city: "Seattle", state: "WA", zip: "9810" }));
      h.state(
        "server rejects the mistyped ZIP",
        !bad.ok && bad.code === "validation" && !!bad.fieldErrors?.zip,
        JSON.stringify(bad),
      );
      const good = await h.review(testCustomer({ city: "Seattle", state: "WA", zip: "98101" }));
      h.state(
        "corrected review shows the new address",
        good.ok && good.review.customer.addressSummary.includes("98101"),
        JSON.stringify(good).slice(0, 300),
      );
      const { reference } = await h.completeCheckout({
        city: "Seattle",
        state: "WA",
        zip: "98101",
      });
      h.text(h.turns.at(-1)!, new RegExp(reference), "confirmation contains the reference");
      const order = await h.prisma.order.findUnique({ where: { reference } });
      h.state("order shipped to zone 8 (WA)", order?.shipZone === 8, `zone ${order?.shipZone}`);
      const gfci1 = await h.prisma.product.findFirst({
        where: { businessId: "volt-supply", sku: "EL-GFCI-20" },
      });
      const brk1 = await h.prisma.product.findFirst({
        where: { businessId: "volt-supply", sku: "EL-BRK-1P20" },
      });
      h.state(
        "stock decremented 5 GFCI / 2 breakers",
        gfci0!.qtyOnHand - gfci1!.qtyOnHand === 5 && brk0!.qtyOnHand - brk1!.qtyOnHand === 2,
        `GFCI ${gfci0?.qtyOnHand}→${gfci1?.qtyOnHand}, BRK ${brk0?.qtyOnHand}→${brk1?.qtyOnHand}`,
      );
    },
  },
  {
    id: "corrections-start-over",
    category: "corrections",
    business: "flowline-plumbing",
    title: '"Start over" drops the earlier cart',
    async run(h) {
      await h.say("Please add 2 wax rings and a 1-1/2 inch P-trap kit to my order.");
      await h.say("Hmm, let's start over. I just need one 12 inch toilet supply line.");
      await h.sayUntilForm("Yes, that's all — check out please.");
      const sc = h.tool("start_checkout");
      h.state(
        "checkout = 1 × PL-SUP-TOI12 only",
        sameLines(linesOf(sc), { "PL-SUP-TOI12": 1 }),
        JSON.stringify(sc?.input.lines),
      );
    },
  },
  // ---------------------------------------------------------------- stock
  {
    id: "stock-out-of-stock-breaker",
    category: "stock",
    business: "volt-supply",
    title: "Out-of-stock 30 A breaker → says so, offers alternatives",
    async run(h) {
      const t1 = await h.say("I need 2 of the 30 amp double-pole breakers, EL-BRK-2P30.");
      h.tool(["check_inventory", "get_product", "quote_products"], {
        turn: t1,
        where: (c) => JSON.stringify(c.input).includes("EL-BRK-2P30"),
        label: "stock checked for EL-BRK-2P30",
      });
      h.text(
        t1,
        /out of stock|sold out|not in stock|none (in stock|available)|0 (in stock|available)|currently unavailable/i,
        "says it is out of stock",
      );
      h.noTool("start_checkout", {
        where: (c) => JSON.stringify(c.input).includes("EL-BRK-2P30"),
        label: "never starts checkout for an out-of-stock SKU",
      });
      await h.judge(
        "The final reply says EL-BRK-2P30 is out of stock and offers at least one specific in-stock alternative product (by name or SKU).",
      );
    },
  },
  {
    id: "stock-partial-romex",
    category: "stock",
    business: "volt-supply",
    title: "Wants 5 rolls, only 2 in stock → offers 2, never over-sells",
    async run(h) {
      const t1 = await h.say("I need 5 rolls of the Romex 12/3 wire, EL-WIR-1232-250.");
      h.tool(["check_inventory", "get_product", "quote_products"], {
        turn: t1,
        where: (c) => JSON.stringify(c.input).includes("EL-WIR-1232-250"),
      });
      h.text(
        t1,
        /\b(only|just)?\s*(2|two)\b[^.]{0,40}(available|in stock|left|on hand)|(available|in stock|left|have)[^.]{0,30}\b(2|two)\b/i,
        "says only 2 are available",
      );
      await h.sayUntilForm("OK, I'll take the 2 you have.");
      const sc = h.tool("start_checkout");
      h.state(
        "checkout for exactly 2 rolls",
        sameLines(linesOf(sc), { "EL-WIR-1232-250": 2 }),
        JSON.stringify(sc?.input.lines),
      );
      h.noTool("start_checkout", {
        where: (c) => (linesOf(c)["EL-WIR-1232-250"] ?? 0) > 2 && !out(c).error,
        label: "never creates a checkout above stock",
      });
    },
  },
  {
    id: "stock-out-water-heater",
    category: "stock",
    business: "flowline-plumbing",
    title: "Out-of-stock electric water heater → alternative",
    async run(h) {
      const t1 = await h.say(
        "Do you have the 50 gallon electric water heater in stock? I need one.",
      );
      h.tool(["check_inventory", "get_product", "search_catalog"], { turn: t1 });
      h.text(
        t1,
        /out of stock|sold out|not in stock|none (in stock|available)|currently unavailable|0 (in stock|available)/i,
        "says it is out of stock",
      );
      await h.judge(
        "The final reply says the 50 gallon electric water heater is out of stock and offers a specific in-stock alternative (e.g. the 40 gallon gas model) without inventing stock or prices.",
      );
    },
  },
  // ---------------------------------------------------------------- availability
  {
    id: "availability-full-mountpro",
    category: "availability",
    business: "mountpro-tv",
    title: "Requested day fully booked → nearest openings",
    async run(h) {
      const day = h.dates.services["mountpro-tv"].fullyBooked[0]!;
      const t1 = await h.say(
        `Can you mount my 50 inch TV on ${longDate(day)}? I have my own mount.`,
      );
      const c = h.tool("check_availability", {
        where: (x) => x.input.date === day,
        label: `check_availability for ${day}`,
      });
      h.state("tool reports the date fully booked", out(c).fullyBooked === true);
      h.text(
        t1,
        /booked|no (open|avail)|not available|unavailable|full|no openings/i,
        "says the day is unavailable",
      );
      await h.judge(
        `The final reply says ${longDate(day)} has no availability and offers specific alternative date(s) and time(s).`,
      );
    },
  },
  {
    id: "availability-full-lawn",
    category: "availability",
    business: "greenstripe-lawn",
    title: "Lawn day fully booked → nearest openings",
    async run(h) {
      const day = h.dates.services["greenstripe-lawn"].fullyBooked[0]!;
      const t1 = await h.say(
        `I need a quarter-acre lawn mowed on ${longDate(day)}, ZIP 60614. Is that possible?`,
      );
      const c = h.tool("check_availability", {
        where: (x) => x.input.date === day || (x.input.fromDate as string | undefined) === day,
        label: `check_availability around ${day}`,
      });
      h.state(
        "tool reports no opening that day",
        out(c).fullyBooked === true ||
          ((out(c).slots as unknown[] | undefined)?.length ?? 0) === 0 ||
          !JSON.stringify(out(c).slots).includes(day),
      );
      h.text(
        t1,
        /booked|no (open|avail)|not available|unavailable|full|no openings/i,
        "says the day is unavailable",
      );
      await h.judge(
        `The final reply says ${longDate(day)} is not available and offers specific alternative date(s)/time(s).`,
      );
    },
  },
  {
    id: "availability-fragmented-cleaning",
    category: "availability",
    business: "brightnest-cleaning",
    title: "Long deep clean does not fit a fragmented day",
    async run(h) {
      const day = h.dates.services["brightnest-cleaning"].fragmented!;
      const t1 = await h.say(
        `Can you do a deep clean of my 3 bedroom home on ${longDate(day)}? ZIP 98101.`,
      );
      h.tool("quote_service", { label: "deep clean quoted (duration known)" });
      const c = h.tool("check_availability", {
        where: (x) => x.input.date === day,
        label: `check_availability for ${day}`,
      });
      h.state(
        "tool reports no long-enough opening",
        out(c).fullyBooked === true,
        JSON.stringify(out(c)).slice(0, 200),
      );
      h.text(
        t1,
        /booked|no (open|avail)|not available|unavailable|full|no openings|doesn't fit|not enough|isn't (enough|available)/i,
        "says that day doesn't work",
      );
      await h.judge(
        `The final reply says a deep clean can't be booked on ${longDate(day)} and offers specific alternative date(s)/time(s).`,
      );
    },
  },
];
