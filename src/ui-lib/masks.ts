/**
 * Input masks for the checkout form. Pure functions: given the raw input value and the
 * caret position, return the formatted value and where the caret should go.
 */

export interface MaskResult {
  value: string;
  caret: number;
}

function digitsOf(s: string): string {
  return s.replace(/\D/g, "");
}

/** Position in `formatted` just after the n-th digit (0 → before the first digit). */
function caretAfterDigits(formatted: string, n: number): number {
  if (n <= 0) {
    const first = formatted.search(/\d/);
    return first === -1 ? formatted.length : first;
  }
  let seen = 0;
  for (let i = 0; i < formatted.length; i++) {
    if (/\d/.test(formatted[i] ?? "")) {
      seen++;
      if (seen === n) return i + 1;
    }
  }
  return formatted.length;
}

/** "5555550123" → "(555) 555-0123", progressively while typing. */
export function formatUsPhone(digits: string): string {
  const d = digits.slice(0, 10);
  if (d.length === 0) return "";
  if (d.length <= 3) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function phoneDigits(raw: string): string {
  let d = digitsOf(raw);
  // Pasted "+1 555 555 0123" / "1-555-…": drop the country code.
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.slice(0, 10);
}

/**
 * Mask a phone input change. `prev` is the value before the edit, so deleting a
 * separator (")", " ", "-") removes the digit before it instead of doing nothing.
 */
export function maskPhone(raw: string, caret: number, prev: string): MaskResult {
  let digits = phoneDigits(raw);
  let digitsBefore = digitsOf(raw.slice(0, caret)).length;
  const prevDigits = phoneDigits(prev);
  if (raw.length < prev.length && digits === prevDigits && digitsBefore > 0) {
    digits = digits.slice(0, digitsBefore - 1) + digits.slice(digitsBefore);
    digitsBefore -= 1;
  }
  const value = formatUsPhone(digits);
  return { value, caret: caretAfterDigits(value, Math.min(digitsBefore, digits.length)) };
}

/** ZIP: digits only, 5 or 9 digits, hyphen inserted automatically ("46241-1234"). */
export function maskZip(raw: string, caret: number): MaskResult {
  const digits = digitsOf(raw).slice(0, 9);
  const digitsBefore = Math.min(digitsOf(raw.slice(0, caret)).length, digits.length);
  const value = digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
  return { value, caret: caretAfterDigits(value, digitsBefore) };
}
