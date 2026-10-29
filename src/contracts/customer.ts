import { z } from "zod";
import { Email } from "./common";
import { normalizeZip } from "./zip";

export {
  normalizeZip,
  statesForZip,
  US_STATE_NAMES,
  zipMatchesState,
  zipStateWarning,
  ZIP_FORMAT_MESSAGE,
} from "./zip";

/** 50 states + DC (SPEC §5). */
export const US_STATES = [
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "DC",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
] as const;

/**
 * U.S. territories accepted as a ship-to / service state (SPEC §5-6: every valid US ZIP ships,
 * territories at zone 8). The form lists them in a separate "U.S. territories" group.
 */
export const US_TERRITORIES = ["PR", "GU", "VI", "AS", "MP"] as const;
export const US_TERRITORY_NAMES: Record<(typeof US_TERRITORIES)[number], string> = {
  PR: "Puerto Rico",
  GU: "Guam",
  VI: "U.S. Virgin Islands",
  AS: "American Samoa",
  MP: "Northern Mariana Islands",
};

/** Every accepted `state` value: 50 states + DC + territories. */
export const US_STATE_CODES = [...US_STATES, ...US_TERRITORIES] as const;
export const UsState = z.enum(US_STATE_CODES, "Choose a US state or territory");
export type UsState = z.infer<typeof UsState>;

/** Remove ASCII control characters except tab and newline; normalize CRLF. */
export function stripControlChars(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/**
 * Invisible format characters that can spoof or hide text: soft hyphen, CGJ, Arabic letter
 * mark, Hangul/Khmer/Mongolian fillers, zero-width chars, bidi embeddings / overrides /
 * isolates, word joiners, variation selectors, BOM and Unicode tag characters.
 */
const INVISIBLE_CLASS =
  "\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2069\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}";
export const INVISIBLE_CHARS = new RegExp(`[${INVISIBLE_CLASS}]`, "gu");

/** Multi-line free text (instructions): control chars (except \n, \t) and invisible chars removed. */
export function cleanMultilineText(s: string): string {
  return stripControlChars(s).replace(INVISIBLE_CHARS, "");
}

/** Any C0/C1 control (incl. CR/LF/tab) or invisible/bidi char: not allowed in one-line fields. */
const UNSAFE_SINGLE_LINE = new RegExp(`[\\u0000-\\u001F\\u007F-\\u009F${INVISIBLE_CLASS}]`, "u");
const SINGLE_LINE_MESSAGE = "Remove line breaks and special or invisible characters";

/** True when a one-line field value contains control, line-break or invisible/bidi chars. */
export function hasUnsafeSingleLineChars(s: string): boolean {
  return UNSAFE_SINGLE_LINE.test(s);
}

/**
 * Normalize a US phone number to E.164 (`+1XXXXXXXXXX`), or return null.
 * Accepts 10 digits or 11 starting with 1, with common separators: spaces ( ) - . and a
 * leading +. Fullwidth digits are folded to ASCII (NFKC). Area code and exchange must not
 * start with 0 or 1 (NANP). Extensions are rejected (the number must receive texts).
 */
export function normalizeUsPhone(input: string): string | null {
  const s = input.normalize("NFKC").trim();
  if (!/^\+?[\d\s().-]+$/.test(s)) return null;
  let digits = s.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return null;
  return `+1${digits}`;
}

/** "512-555-0123 x12", "ext. 12", "extension 12", "#12" at the end of a phone number. */
const PHONE_EXTENSION = /\s*(?:x|ext\.?|extension|#)\s*\d{1,6}\s*$/i;

const NAME_RE = /^[\p{L}][\p{L}\p{M} '’.-]*$/u;
const CITY_RE = /^[\p{L}][\p{L}\p{M} '’.-]*$/u;

const personName = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(50, `${label} must be 50 characters or fewer`)
    .regex(NAME_RE, `${label} can contain letters, spaces, apostrophes, hyphens and periods`);

export const PhoneE164 = z.string().transform((v, ctx) => {
  const n = normalizeUsPhone(v);
  if (!n) {
    const folded = v.normalize("NFKC");
    const hasExtension =
      PHONE_EXTENSION.test(folded) &&
      normalizeUsPhone(folded.replace(PHONE_EXTENSION, "")) !== null;
    ctx.addIssue({
      code: "custom",
      message: hasExtension
        ? "Remove the extension — we need a number that can receive texts"
        : "Enter a 10-digit US phone number",
    });
    return z.NEVER;
  }
  return n;
});

/**
 * US ZIP: `12345`, `12345-6789`, or 9 bare digits (normalized to `12345-6789`). Prefixes
 * 000-003 (e.g. `00000`) are rejected as non-existent. See src/contracts/zip.ts.
 */
export const ZipCode = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const r = normalizeZip(v);
    if (!r.ok) {
      ctx.addIssue({ code: "custom", message: r.message });
      return z.NEVER;
    }
    return r.zip;
  });

/** Optional multi-line text: control/invisible characters stripped (newlines kept). */
const optionalMultiline = (max: number, msg: string) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const t = v === undefined ? "" : cleanMultilineText(v).trim();
      return t === "" ? undefined : t;
    })
    .pipe(z.string().max(max, msg).optional());

/** Optional one-line text: rejected (never silently changed) when it holds control/bidi chars. */
const optionalSingleLine = (max: number, msg: string) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const t = v === undefined ? "" : v.trim();
      return t === "" ? undefined : t;
    })
    .pipe(
      z
        .string()
        .max(max, msg)
        .refine((t) => !hasUnsafeSingleLineChars(t), SINGLE_LINE_MESSAGE)
        .optional(),
    );

/**
 * Checkout contact + address form. Shared by the client form (inline errors) and the
 * server (`/api/checkout/*` re-validates and returns 422 on failure).
 *
 * ZIP ↔ state is deliberately NOT a validation rule (R2-1): real ZIP areas cross state lines,
 * so a mismatch is a soft review warning (`zipStateWarning`, added by reviewCheckout).
 */
export const CustomerForm = z.object({
  firstName: personName("First name"),
  lastName: personName("Last name"),
  email: Email,
  phone: PhoneE164,
  address1: z
    .string()
    .trim()
    .min(1, "Street address is required")
    .max(100, "Street address must be 100 characters or fewer")
    .refine((t) => !hasUnsafeSingleLineChars(t), SINGLE_LINE_MESSAGE),
  address2: optionalSingleLine(100, "Apartment/suite must be 100 characters or fewer"),
  city: z
    .string()
    .trim()
    .min(1, "City is required")
    .max(60, "City must be 60 characters or fewer")
    .regex(CITY_RE, "City can contain letters, spaces, apostrophes, hyphens and periods"),
  state: z.string().trim().toUpperCase().pipe(UsState),
  zip: ZipCode,
  instructions: optionalMultiline(500, "Instructions must be 500 characters or fewer"),
});
/** Raw form values (what the browser sends). */
export type CustomerFormInput = z.input<typeof CustomerForm>;
/** Normalized values (E.164 phone, lower-case email, upper-case state). */
export type CustomerFormData = z.output<typeof CustomerForm>;

/** PII-free view of a customer for review screens and traces. */
export const MaskedCustomer = z.object({
  name: z.string(),
  emailMasked: z.string(),
  phoneMasked: z.string(),
  addressSummary: z.string(),
});
export type MaskedCustomer = z.infer<typeof MaskedCustomer>;
