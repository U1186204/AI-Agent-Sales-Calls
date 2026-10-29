/**
 * User text sanitization (SPEC §8, AT-83). Defense in depth: the UI renders every string as a
 * React text node (never `dangerouslySetInnerHTML`), so HTML is harmless; this pass removes
 * invisible/control characters that confuse logs, models, and terminals, and enforces the
 * max-length guardrail.
 */
import { getEnv } from "@/config/env";

export interface SanitizeResult {
  text: string;
  /** True when the input exceeded the max length and was cut. */
  truncated: boolean;
}

// C0 controls except \t (09) and \n (0A); DEL; C1 controls; zero-width / bidi overrides
// commonly used to smuggle hidden instructions; BOM. INJ-4 adds the other invisible
// "format" characters: soft hyphen (00AD), combining grapheme joiner (034F), Arabic letter
// mark (061C), Hangul/Khmer/Mongolian fillers, variation selectors (FE00-FE0F and the
// supplement E0100-E01EF) and Unicode TAG characters (E0000-E007F), which can spell out
// whole instructions the customer never sees.
const CONTROL = new RegExp(
  "[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180E\\u200B\\u200C\\u200E\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}]",
  "gu",
);

/**
 * R2-9: U+200D (zero-width joiner) is kept ONLY inside emoji ZWJ sequences (family, "woman
 * technologist" with a skin tone, ...): after an emoji or skin-tone modifier AND before an
 * emoji. Anywhere else it is an invisible character and is removed (runs after CONTROL, so a
 * VS16 between them is already gone).
 */
const STRAY_ZWJ =
  /(?<![\p{Extended_Pictographic}\p{Emoji_Modifier}])\u200D|\u200D(?!\p{Extended_Pictographic})/gu;

/**
 * Normalize CRLF → LF, apply Unicode NFKC, strip control/invisible characters (keeps newline
 * and tab), collapse 3+ blank lines, trim, and cut to `maxChars` (default
 * `OASIS_MAX_INPUT_CHARS`). Truncation is reported so callers can tell the user.
 */
export function sanitizeUserTextDetailed(input: string, maxChars?: number): SanitizeResult {
  const limit = maxChars ?? getEnv().OASIS_MAX_INPUT_CHARS;
  const text = String(input ?? "")
    .replace(/\r\n?/g, "\n")
    .normalize("NFKC")
    .replace(CONTROL, "")
    .replace(STRAY_ZWJ, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const chars = Array.from(text);
  if (chars.length <= limit) return { text, truncated: false };
  return { text: chars.slice(0, limit).join("").trimEnd(), truncated: true };
}

/** Same as `sanitizeUserTextDetailed(...).text`. */
export function sanitizeUserText(input: string, maxChars?: number): string {
  return sanitizeUserTextDetailed(input, maxChars).text;
}
