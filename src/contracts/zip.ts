/**
 * US ZIP code rules shared by the checkout form (client) and the server (no imports).
 *
 * - `normalizeZip`: accepts `12345`, `12345-6789` and a bare 9-digit `123456789`
 *   (→ `12345-6789`). Prefixes 000–003 (including `00000`) are not assigned by USPS and are
 *   rejected; 004 is NY (Holtsville IRS special-use ZIPs, R2-8). Other unassigned prefixes
 *   are NOT checked (the list changes; shipping still prices them by zone), see SPEC §5.
 * - `zipMatchesState` / `zipStateWarning`: a coarse ZIP-prefix → state table (3-digit
 *   prefixes, USPS ranges). A mismatch is only a SOFT warning shown on the review step
 *   (R2-1): about 137 real ZIP areas cross a state line (99362 Walla Walla WA/OR, 83120 WY/ID,
 *   97635 OR/CA …), and shipping is priced by ZIP, so the state never blocks checkout.
 */

/** [firstPrefix, lastPrefix, ...state codes] — 3-digit ZIP prefixes, inclusive. */
const RANGES: readonly (readonly [number, number, ...string[]])[] = [
  [4, 5, "NY"],
  [6, 7, "PR"],
  [8, 8, "VI"],
  [9, 9, "PR"],
  [10, 27, "MA"],
  [28, 29, "RI"],
  [30, 38, "NH"],
  [39, 49, "ME"],
  [50, 54, "VT"],
  [55, 55, "MA", "VT"],
  [56, 59, "VT"],
  [60, 69, "CT"],
  [70, 89, "NJ"],
  [100, 149, "NY"],
  [150, 196, "PA"],
  [197, 199, "DE"],
  [200, 200, "DC"],
  [201, 201, "VA"],
  [202, 205, "DC"],
  [206, 219, "MD"],
  [220, 246, "VA"],
  [247, 268, "WV"],
  [270, 289, "NC"],
  [290, 299, "SC"],
  [300, 319, "GA"],
  [320, 339, "FL"],
  [341, 349, "FL"],
  [350, 369, "AL"],
  [370, 385, "TN"],
  [386, 397, "MS"],
  [398, 399, "GA"],
  [400, 427, "KY"],
  [430, 459, "OH"],
  [460, 479, "IN"],
  [480, 499, "MI"],
  [500, 528, "IA"],
  [530, 549, "WI"],
  [550, 567, "MN"],
  [569, 569, "DC"],
  [570, 577, "SD"],
  [580, 588, "ND"],
  [590, 599, "MT"],
  [600, 629, "IL"],
  [630, 658, "MO"],
  [660, 679, "KS"],
  [680, 693, "NE"],
  [700, 714, "LA"],
  [716, 729, "AR"],
  [730, 732, "OK"],
  [733, 733, "TX", "OK"],
  [734, 749, "OK"],
  [750, 799, "TX"],
  [800, 816, "CO"],
  [820, 831, "WY"],
  [832, 838, "ID", "WY"],
  [840, 847, "UT"],
  [850, 865, "AZ"],
  [870, 884, "NM"],
  [885, 885, "TX"],
  [889, 898, "NV"],
  [900, 961, "CA"],
  [967, 968, "HI", "AS"],
  [969, 969, "GU", "MP"],
  [970, 979, "OR"],
  [980, 994, "WA"],
  [995, 999, "AK"],
];

/** States/territories a 3-digit prefix belongs to, or null when the table has no entry. */
export function statesForZip(zip: string): readonly string[] | null {
  const prefix = Number(zip.slice(0, 3));
  if (!/^\d{3}/.test(zip) || Number.isNaN(prefix)) return null;
  for (const [lo, hi, ...states] of RANGES) {
    if (prefix >= lo && prefix <= hi) return states;
  }
  return null;
}

/** True unless the table clearly places `zip` in a different state/territory than `state`. */
export function zipMatchesState(zip: string, state: string): boolean {
  const states = statesForZip(zip);
  return !states || states.includes(state.toUpperCase());
}

/** Display names for every accepted state / territory code. */
export const US_STATE_NAMES: Readonly<Record<string, string>> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
  // U.S. territories (shipping zone 8)
  PR: "Puerto Rico",
  GU: "Guam",
  VI: "U.S. Virgin Islands",
  AS: "American Samoa",
  MP: "Northern Mariana Islands",
};

/**
 * Non-blocking review warning when the ZIP prefix usually belongs to another state, e.g.
 * "ZIP 99362 is usually in Washington — double-check your state." Null when it matches or the
 * prefix is not in the table. Never a validation error (R2-1).
 */
export function zipStateWarning(zip: string, state: string): string | null {
  if (zipMatchesState(zip, state)) return null;
  const states = statesForZip(zip);
  if (!states) return null;
  const where = states.map((s) => US_STATE_NAMES[s] ?? s).join(" or ");
  return `ZIP ${zip.slice(0, 5)} is usually in ${where} — double-check your state.`;
}

export type ZipCheck = { ok: true; zip: string } | { ok: false; message: string };

export const ZIP_FORMAT_MESSAGE = "Enter a 5-digit ZIP or ZIP+4";

/** Normalize and validate a US ZIP (see module doc). */
export function normalizeZip(input: string): ZipCheck {
  const s = input.trim();
  let zip: string;
  if (/^\d{5}(-\d{4})?$/.test(s)) zip = s;
  else if (/^\d{9}$/.test(s)) zip = `${s.slice(0, 5)}-${s.slice(5)}`;
  else return { ok: false, message: ZIP_FORMAT_MESSAGE };
  if (Number(zip.slice(0, 3)) <= 3) {
    return { ok: false, message: "That ZIP code doesn't exist. Check it and try again." };
  }
  return { ok: true, zip };
}
