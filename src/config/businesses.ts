/**
 * Business profiles (SPEC §1, §6). Fictional companies; example.com addresses and
 * 555-01xx phone numbers reserved for fiction. Seeded into the `Business` table by
 * prisma/seed; policies and hours are served to the agent from here.
 */

export type BusinessKind = "product" | "service";

export type ServiceArea = { mode: "any" } | { mode: "zipPrefixes"; prefixes: readonly string[] };

/** 0 = Sunday … 6 = Saturday. Times are local "HH:MM" in the business timezone. */
export interface DayHours {
  day: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  open: string;
  close: string;
}

export interface Policy {
  key: string;
  title: string;
  text: string;
}

export interface BusinessProfile {
  id: string;
  name: string;
  shortName: string;
  kind: BusinessKind;
  timezone: string;
  tagline: string;
  description: string;
  supportEmail: string;
  notifyEmail: string;
  /** E.164, fictional. */
  notifyPhone: string;
  serviceArea: ServiceArea;
  /** Customer-support hours (chat answers about "when are you open"). */
  supportHours: readonly DayHours[];
  /**
   * Service businesses: appointment start windows used to generate Slots (SLOT_MINUTES each,
   * last slot starts at `close - 60 min`). Empty for product businesses.
   */
  bookingHours: readonly DayHours[];
  /**
   * Minimum booking lead time (EDGE-4): appointment starts sooner than this many minutes from
   * now are never offered or confirmed. 0 for product businesses.
   */
  minLeadMinutes: number;
  /** Customer-facing support response time used in escalation replies. */
  escalationResponse: string;
  policies: readonly Policy[];
}

const WEEKDAYS = [1, 2, 3, 4, 5] as const;

/** Default booking lead time for service businesses (minutes). */
export const DEFAULT_MIN_LEAD_MINUTES = 120;

function hours(days: readonly DayHours["day"][], open: string, close: string): DayHours[] {
  return days.map((day) => ({ day, open, close }));
}

const PRODUCT_POLICIES = (name: string): Policy[] => [
  {
    key: "shipping",
    title: "Shipping and delivery",
    text: `${name} ships from our Indianapolis, IN warehouse to any ZIP code in the 50 states, DC and US territories (Puerto Rico, Guam, US Virgin Islands, American Samoa, Northern Mariana Islands). Military APO/FPO/DPO addresses (AA, AE, AP) are not supported in this demo. Orders placed by 2 pm Eastern on a business day ship the same day; otherwise the next business day. Ground transit is 1–2 business days nearby up to 5–7 days for the West Coast, Alaska, Hawaii and territories. Ground shipping is free on goods subtotals of $249 or more, except items over 50 lb, which pay their weight share plus a $25 handling fee each.`,
  },
  {
    key: "returns",
    title: "Returns",
    text: "Unused items in original packaging can be returned within 30 days of delivery for a full refund of the item price. Opened wire and cable cut from a spool, special orders, and items that were installed are not returnable. Water heaters and toilets carry a 15% restocking fee unless defective. Return shipping is free for defective or wrong items; otherwise the customer pays return shipping.",
  },
  {
    key: "warranty",
    title: "Warranty",
    text: "All products carry the manufacturer's warranty (for example, 6 years on tank water heaters). If an item arrives damaged or defective, tell us within 7 days and we will send a replacement at no cost.",
  },
  {
    key: "cancellation",
    title: "Order changes and cancellation",
    text: "Orders can be changed or cancelled free of charge until they ship. After shipping, use the returns policy.",
  },
  {
    key: "payment",
    title: "Payment",
    text: "This is a demo: no payment is collected and no card details are ever requested in chat. Orders are confirmed without charge.",
  },
  {
    key: "privacy",
    title: "Privacy",
    text: "Contact and address details are entered only in the secure checkout form, never in chat, and are stored encrypted. We use them only to fulfil and update you on your order.",
  },
];

const SERVICE_POLICIES = (opts: {
  name: string;
  guarantee: string;
  prep: string;
  weather?: string;
}): Policy[] => [
  {
    key: "cancellation",
    title: "Cancellation and rescheduling",
    text: "Reschedule or cancel free of charge up to 24 hours before your appointment. Cancellations within 24 hours or a missed appointment (no access to the home) incur a $40 fee in a real deployment; in this demo no fees are charged.",
  },
  { key: "guarantee", title: "Satisfaction guarantee", text: opts.guarantee },
  { key: "preparation", title: "Before your appointment", text: opts.prep },
  ...(opts.weather ? [{ key: "weather", title: "Weather", text: opts.weather }] : []),
  {
    key: "arrival",
    title: "Arrival window",
    text: "Your technician arrives within 30 minutes of the booked start time and texts when on the way. Duration estimates include add-ons and surcharges.",
  },
  {
    key: "payment",
    title: "Payment",
    text: "This is a demo: no payment is collected and no card details are ever requested in chat. Bookings are confirmed without charge.",
  },
  {
    key: "insurance",
    title: "Insurance",
    text: `${opts.name} technicians are background-checked and the company carries general liability insurance (demo statement).`,
  },
  {
    key: "privacy",
    title: "Privacy",
    text: "Contact and address details are entered only in the secure booking form, never in chat, and are stored encrypted. We use them only to deliver and update you on your appointment.",
  },
];

export const BUSINESSES: readonly BusinessProfile[] = [
  {
    id: "volt-supply",
    name: "Volt & Wire Electrical Supply",
    shortName: "Volt & Wire",
    kind: "product",
    timezone: "America/Indiana/Indianapolis",
    tagline: "Wire, breakers and devices shipped to your job site.",
    description:
      "Electrical supply house for contractors and serious DIYers: wire and cable, breakers and panels, devices, boxes, conduit, connectors and lighting.",
    supportEmail: "support@volt-supply.example.com",
    notifyEmail: "orders@volt-supply.example.com",
    notifyPhone: "+13175550101",
    serviceArea: { mode: "any" },
    supportHours: [...hours(WEEKDAYS, "07:00", "18:00"), { day: 6, open: "08:00", close: "13:00" }],
    bookingHours: [],
    minLeadMinutes: 0,
    escalationResponse: "within 1 business day",
    policies: PRODUCT_POLICIES("Volt & Wire"),
  },
  {
    id: "flowline-plumbing",
    name: "Flowline Plumbing Supply",
    shortName: "Flowline",
    kind: "product",
    timezone: "America/Indiana/Indianapolis",
    tagline: "Pipe, fittings, fixtures and water heaters, delivered.",
    description:
      "Plumbing supply for pros and homeowners: PEX, copper and PVC pipe, fittings and push-fit, valves, supply lines, drainage, fixtures, water heaters, pumps and tools.",
    supportEmail: "support@flowline-plumbing.example.com",
    notifyEmail: "orders@flowline-plumbing.example.com",
    notifyPhone: "+13175550102",
    serviceArea: { mode: "any" },
    supportHours: [...hours(WEEKDAYS, "07:30", "17:30"), { day: 6, open: "08:00", close: "12:00" }],
    bookingHours: [],
    minLeadMinutes: 0,
    escalationResponse: "within 1 business day",
    policies: PRODUCT_POLICIES("Flowline"),
  },
  {
    id: "mountpro-tv",
    name: "MountPro TV Installation",
    shortName: "MountPro",
    kind: "service",
    timezone: "America/Denver",
    tagline: "Your TV on the wall, level and tidy, in about an hour.",
    description:
      "In-home TV wall mounting with optional mounts, cable concealment, soundbars and shelves.",
    supportEmail: "support@mountpro-tv.example.com",
    notifyEmail: "jobs@mountpro-tv.example.com",
    notifyPhone: "+17205550103",
    serviceArea: { mode: "any" },
    supportHours: hours([1, 2, 3, 4, 5, 6], "08:00", "19:00"),
    bookingHours: hours([1, 2, 3, 4, 5, 6], "09:00", "18:00"),
    minLeadMinutes: DEFAULT_MIN_LEAD_MINUTES,
    escalationResponse: "within 4 business hours",
    policies: [
      ...SERVICE_POLICIES({
        name: "MountPro",
        guarantee:
          "Workmanship is guaranteed for 1 year: if a mount we installed loosens or sags, we fix it free. Mounts we supply carry the manufacturer's warranty.",
        prep: "Have the TV, its stand screws and remote on site, clear about 6 ft in front of the wall, and know where you want the TV centered. If you supply the mount, confirm it fits your TV's VESA pattern and weight.",
      }),
      {
        key: "electrical",
        title: "Electrical work",
        text: "New outlets behind the TV are installed by a licensed electrician. We do not modify gas fireplaces or hard-wire TVs.",
      },
    ],
  },
  {
    id: "greenstripe-lawn",
    name: "GreenStripe Lawn Care",
    shortName: "GreenStripe",
    kind: "service",
    timezone: "America/Chicago",
    tagline: "Clean cuts and crisp edges, one-time or all season.",
    description: "Residential lawn mowing with edging, cleanup and recurring plans.",
    supportEmail: "support@greenstripe-lawn.example.com",
    notifyEmail: "crew@greenstripe-lawn.example.com",
    notifyPhone: "+13125550104",
    serviceArea: { mode: "any" },
    supportHours: hours([1, 2, 3, 4, 5, 6], "07:00", "18:00"),
    bookingHours: hours([1, 2, 3, 4, 5, 6], "08:00", "17:00"),
    minLeadMinutes: DEFAULT_MIN_LEAD_MINUTES,
    escalationResponse: "within 1 business day",
    policies: SERVICE_POLICIES({
      name: "GreenStripe",
      guarantee:
        "If you are not happy with a cut, tell us within 48 hours and we will come back to touch it up free.",
      prep: "Unlock gates, put pets inside, and pick up toys, hoses and large debris. Tell us about sprinkler heads or invisible pet fences.",
      weather:
        "We do not mow in heavy rain or lightning. Weather cancellations are rescheduled to the next open day at no charge, and we text you before the visit.",
    }),
  },
  {
    id: "brightnest-cleaning",
    name: "BrightNest House Cleaning",
    shortName: "BrightNest",
    kind: "service",
    timezone: "America/Los_Angeles",
    tagline: "A two-person team that leaves every room bright.",
    description: "Standard, deep and move-in/move-out house cleaning by a two-person team.",
    supportEmail: "support@brightnest-cleaning.example.com",
    notifyEmail: "team@brightnest-cleaning.example.com",
    notifyPhone: "+12135550105",
    serviceArea: { mode: "any" },
    supportHours: hours([1, 2, 3, 4, 5, 6], "08:00", "18:00"),
    bookingHours: hours([1, 2, 3, 4, 5, 6], "08:00", "18:00"),
    minLeadMinutes: DEFAULT_MIN_LEAD_MINUTES,
    escalationResponse: "within 4 business hours",
    policies: SERVICE_POLICIES({
      name: "BrightNest",
      guarantee:
        "100% satisfaction: if we missed something, tell us within 24 hours and we will re-clean that area free.",
      prep: "Tidy clutter from counters and floors so we can clean surfaces, secure valuables and pets, and let us know about any delicate surfaces. We bring all supplies and equipment.",
    }),
  },
];

export const BUSINESS_IDS = BUSINESSES.map((b) => b.id);

export function getBusiness(id: string): BusinessProfile | undefined {
  return BUSINESSES.find((b) => b.id === id);
}
