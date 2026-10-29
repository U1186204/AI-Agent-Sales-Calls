/** Masking helpers for owner views, review screens and traces (never return raw PII). */

/** "Jane", "Smith" → "J. Smith". */
export function maskName(first: string, last: string): string {
  const f = first.trim();
  const l = last.trim();
  if (!f) return l || "Customer";
  return l ? `${f[0]?.toUpperCase()}. ${l}` : `${f[0]?.toUpperCase()}.`;
}

/** "jane.doe@example.com" → "j***@example.com". */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/** "+15125550123" → "(***) ***-0123". */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `(***) ***-${digits.slice(-4)}` : "(***) ***-****";
}

/** City, state and ZIP only. */
export function addressSummary(a: { city: string; state: string; zip: string }): string {
  return `${a.city}, ${a.state} ${a.zip}`;
}
