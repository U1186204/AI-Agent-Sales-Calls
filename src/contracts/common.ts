import { z } from "zod";

/** Business slugs (SPEC §1). Kept in sync with src/config/businesses.ts by a unit test. */
export const BUSINESS_SLUGS = [
  "volt-supply",
  "flowline-plumbing",
  "mountpro-tv",
  "greenstripe-lawn",
  "brightnest-cleaning",
] as const;
export const BusinessSlug = z.enum(BUSINESS_SLUGS);
export type BusinessSlug = z.infer<typeof BusinessSlug>;

export const BusinessKind = z.enum(["product", "service"]);
export type BusinessKind = z.infer<typeof BusinessKind>;

export const CheckoutKind = BusinessKind;
export type CheckoutKind = BusinessKind;

/** Non-negative integer number of US cents. */
export const Cents = z.number().int().min(0);

/** `OAS-XXXX-XXXX`, case-insensitive on input, upper-cased on output. No 0/O/1/I. */
export const Reference = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^OAS-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/, "Reference looks like OAS-ABCD-2345");
export type Reference = z.infer<typeof Reference>;

/** Calendar date `YYYY-MM-DD` (interpreted in the business timezone). */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "Invalid date");

/** ISO 8601 timestamp with offset or Z. */
export const IsoDateTime = z.iso.datetime({ offset: true });

export const Sku = z
  .string()
  .trim()
  .toUpperCase()
  .min(2)
  .max(40)
  .regex(/^[A-Z0-9][A-Z0-9-]*$/, "Invalid SKU");

export const Code = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Invalid code");

export const Id = z.string().min(1).max(64);

/**
 * Internationalized domain → ASCII (punycode) via the WHATWG URL parser, which exists in
 * browsers and Node, so client and server normalize identically: `jane@bücher.de` →
 * `jane@xn--bcher-kva.de`. Unicode in the local part is not accepted (most mail systems
 * cannot route it); that rule is documented in SPEC §5.
 */
export function asciiEmailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return email;
  const domain = email.slice(at + 1);
  if (/^[\x00-\x7F]*$/.test(domain)) return email;
  try {
    const host = new URL(`http://${domain}`).hostname;
    return host ? `${email.slice(0, at)}@${host}` : email;
  } catch {
    return email;
  }
}

/** Lower-case + trimmed email used by status lookup (same rules as CustomerForm.email). */
export const Email = z
  .string()
  .trim()
  .toLowerCase()
  .transform(asciiEmailDomain)
  .pipe(z.email("Enter a valid email address").max(254));
