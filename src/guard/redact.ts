/**
 * Sensitive-data redaction (SPEC §2 AT-15, §8) and PII masking for traces/logs.
 *
 * - `redactSensitive` runs on every user chat message BEFORE it reaches the LLM or storage.
 *   It removes payment card numbers (Luhn-valid, 13–19 digits, spaces/dashes allowed),
 *   US Social Security numbers, and passwords typed as "password is X" / "pw: X".
 * - `mask*` helpers produce display-safe versions of PII (trace panel, Notification.toMasked,
 *   log lines). `maskDeep` walks an object and masks values under known PII keys.
 *
 * Pure functions, no imports: safe in the proxy, route handlers, and client components.
 */

export type RedactionKind = "card" | "ssn" | "password";

export interface RedactionResult {
  text: string;
  /** One entry per redacted occurrence, in order of appearance. */
  redactions: RedactionKind[];
}

export const REDACTION_LABELS: Record<RedactionKind, string> = {
  card: "[card number removed]",
  ssn: "[SSN removed]",
  password: "[password removed]",
};

/** Luhn checksum over a string of digits. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// 13–19 digits, each optionally followed by ONE space or dash (e.g. "4111 1111-1111 1111").
// Lookarounds stop us from matching the middle of a longer digit run.
const CARD_CANDIDATE = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d])/g;

// SSN with separators: 123-45-6789 / 123 45 6789 (same separator both times).
const SSN_SEPARATED = /(?<![\d-])(?!000|666|9\d\d)\d{3}([- ])(?!00)\d{2}\1(?!0000)\d{4}(?![\d-])/g;
// Bare 9 digits only when the word SSN / social security precedes it closely.
const SSN_BARE_WITH_CONTEXT =
  /(\b(?:ssn|social(?:\s+security)?(?:\s+(?:number|no\.?|#))?)\b[^\d\n]{0,20})(?!000|666|9\d\d)(\d{3}(?!00)\d{2}(?!0000)\d{4})(?!\d)/gi;

// "password is X", "password: X", "pw=X", "my passcode is 'x y'". The keyword is kept.
const PASSWORD =
  /\b(password|passcode|passwd|pass\s*word|pwd|pw|pin(?:\s*(?:code|number))?)(\s+is\s+|\s*[:=]\s*)("[^"\n]{1,200}"|'[^'\n]{1,200}'|[^\s"']{1,200})/gi;

/**
 * Remove card numbers, SSNs, and typed passwords. Non-Luhn digit runs (order numbers,
 * quantities, phone numbers) are left untouched.
 */
export function redactSensitive(input: string): RedactionResult {
  const found: { index: number; kind: RedactionKind }[] = [];
  let text = input;

  text = text.replace(PASSWORD, (_m, kw: string, sep: string, _v: string, offset: number) => {
    found.push({ index: offset, kind: "password" });
    return `${kw}${sep}${REDACTION_LABELS.password}`;
  });

  text = text.replace(CARD_CANDIDATE, (m: string, offset: number) => {
    const digits = m.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return m;
    // Separators, if any, must be consistent groupings — but any Luhn-valid 13–19 digit
    // run is treated as a card: false positives are cheap, leaks are not.
    found.push({ index: offset, kind: "card" });
    return REDACTION_LABELS.card;
  });

  text = text.replace(SSN_SEPARATED, (_m: string, _sep: string, offset: number) => {
    found.push({ index: offset, kind: "ssn" });
    return REDACTION_LABELS.ssn;
  });

  text = text.replace(SSN_BARE_WITH_CONTEXT, (_m, prefix: string, _d: string, offset: number) => {
    found.push({ index: offset + prefix.length, kind: "ssn" });
    return `${prefix}${REDACTION_LABELS.ssn}`;
  });

  found.sort((a, b) => a.index - b.index);
  return { text, redactions: found.map((f) => f.kind) };
}

// ---------------------------------------------------------------------------------------
// Contact details (escalation summaries, owner transcripts)
// ---------------------------------------------------------------------------------------

const CONTACT_EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const CONTACT_PHONE_RE =
  /(?<![\w+])(?:\+?1[\s.-]?)?(?:\(\s*[2-9]\d{2}\s*\)|[2-9]\d{2})[\s.-]?\d{3}[\s.-]?\d{4}(?![\w])/g;

/**
 * Remove email addresses and US phone numbers from free text (plus everything
 * `redactSensitive` removes). Used for escalation summaries (INJ-5): the only contact detail
 * support receives is the customer's explicit `contactEmail`.
 */
export function redactContactDetails(input: string): string {
  return redactSensitive(input)
    .text.replace(CONTACT_EMAIL_RE, "[email removed]")
    .replace(CONTACT_PHONE_RE, "[phone removed]");
}

/** Mask (not remove) emails and phone numbers in free text: `j***@e***.com`, `***-***-0123`. */
export function maskContactDetails(input: string): string {
  return input
    .replace(CONTACT_EMAIL_RE, (m) => maskEmail(m))
    .replace(CONTACT_PHONE_RE, (m) => maskPhone(m));
}

// ---------------------------------------------------------------------------------------
// Masking helpers
// ---------------------------------------------------------------------------------------

const STAR = "***";

/** `jane.doe@example.com` → `j***@e***.com` */
export function maskEmail(value: string): string {
  const v = value.trim();
  const at = v.lastIndexOf("@");
  if (at <= 0) return STAR;
  const local = v.slice(0, at);
  const domain = v.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const tld = dot > 0 ? domain.slice(dot) : "";
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  return `${local[0] ?? ""}${STAR}@${host[0] ?? ""}${STAR}${tld}`;
}

/** `+15551234567` / `(555) 123-4567` → `***-***-4567` */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 4) return STAR;
  return `***-***-${digits.slice(-4)}`;
}

/** `Jane` → `J.`; `Jane Doe` → `J. D.` */
export function maskName(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return STAR;
  return parts.map((p) => `${Array.from(p)[0]?.toUpperCase() ?? ""}.`).join(" ");
}

/** First name + last initial, for business SMS: `Jane`, `Doe` → `Jane D.` */
export function shortName(firstName: string, lastName: string): string {
  const initial = Array.from(lastName.trim())[0]?.toUpperCase();
  return `${firstName.trim()}${initial ? ` ${initial}.` : ""}`;
}

/** Street lines are hidden entirely. */
export function maskAddress(value: string): string {
  return value.trim() === "" ? "" : "[address hidden]";
}

/** `46241-1234` → `462**` */
export function maskZip(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 3 ? `${digits.slice(0, 3)}**` : STAR;
}

/** Mask a value by its key name; returns `undefined` when the key is not PII. */
function maskByKey(key: string, value: unknown): unknown {
  const k = key.toLowerCase();
  if (typeof value !== "string") {
    // Nested objects under an address key (e.g. `address: {line1, zip}`) are walked normally.
    return undefined;
  }
  if (k === "firstname" || k === "lastname" || k === "fullname" || k === "customername")
    return maskName(value);
  if (k.endsWith("email") && !k.endsWith("masked")) return maskEmail(value);
  if ((k.includes("phone") || k === "tel" || k === "mobile") && !k.endsWith("masked"))
    return maskPhone(value);
  if (k.startsWith("address") || k === "line1" || k === "line2" || k === "street")
    return maskAddress(value);
  if (k === "zip" || k === "zipcode" || k === "postalcode") return maskZip(value);
  if (k === "instructions" || k === "password") return value ? "[hidden]" : value;
  return undefined;
}

/**
 * Deep-copy `obj`, masking values under known PII keys (firstName, lastName, email, phone,
 * address*, zip → first 3 digits, instructions, password). Free-text strings elsewhere are
 * passed through `redactSensitive`. Cycles are replaced with "[circular]".
 */
export function maskDeep<T>(obj: T): T {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redactSensitive(v).text;
    if (v === null || typeof v !== "object") return v;
    if (v instanceof Date || v instanceof Error) return v; // errors: serialized by the logger
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
      const masked = maskByKey(key, val);
      out[key] = masked !== undefined ? masked : walk(val);
    }
    return out;
  };
  return walk(obj) as T;
}
