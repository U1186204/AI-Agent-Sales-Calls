/** Display formatting helpers (client + server safe, no dependencies). */

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatUsdAmount(usd: number, digits = 2): string {
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, 4) })}`;
}

export function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatDuration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** One-line outcome of a reply's trace: "3 steps completed · 1.9 s", "1 of 3 steps failed". */
export function traceSummaryLabel(
  steps: readonly { kind: string; ok: boolean; ms: number }[],
): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const failed = steps.filter((s) => !s.ok).length;
  // Guards report ok when they did their job, which may be bad news ("Usage limit reached"),
  // so they are counted apart from completed work.
  const guards = steps.filter((s) => s.ok && s.kind === "guard").length;
  const done = steps.length - guards;
  const ms = steps.reduce((sum, s) => sum + (Number.isFinite(s.ms) ? s.ms : 0), 0);
  const parts: string[] = [];
  if (failed > 0) {
    parts.push(steps.length === 1 ? "1 step failed" : `${failed} of ${steps.length} steps failed`);
  } else {
    if (done > 0) parts.push(`${plural(done, "step")} completed`);
    if (guards > 0) parts.push(plural(guards, "safety check"));
  }
  if (ms > 0) parts.push(formatMs(ms));
  return parts.join(" · ");
}

export interface UsageTotals {
  /** Replies in the conversation, and how many of them reported usage. */
  replies: number;
  reported: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Distinct models, in first-used order. */
  models: string[];
}

/** Conversation totals. Replies without usage add nothing; null when none reported any. */
export function usageTotals(
  usages: readonly (
    { model: string; inputTokens: number; outputTokens: number; costUsd: number } | undefined
  )[],
): UsageTotals | null {
  const known = usages.filter((u) => u !== undefined);
  if (known.length === 0) return null;
  return {
    replies: usages.length,
    reported: known.length,
    inputTokens: known.reduce((n, u) => n + u.inputTokens, 0),
    outputTokens: known.reduce((n, u) => n + u.outputTokens, 0),
    costUsd: known.reduce((n, u) => n + u.costUsd, 0),
    models: [...new Set(known.map((u) => u.model))],
  };
}

/** Calendar date (YYYY-MM-DD) of an instant in an IANA timezone. */
export function isoDateInTz(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** "Tuesday, October 7, 2026" for a YYYY-MM-DD calendar date (no timezone shift). */
export function formatIsoDateLong(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function formatIsoDateShort(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "Oct 5, 8:40 PM CDT": date and time with the zone abbreviation, so times never look ambiguous. */
export function formatDateTimeZoned(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** "Mountain Time" style name for a timezone, falling back to the IANA id. */
export function timezoneName(timeZone: string): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longGeneric" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
    return part ?? timeZone;
  } catch {
    return timeZone;
  }
}

/** Human label for snake/camel case keys: "durationMin" → "Duration min". */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Trace link label for one reply (R2-9). Only tool steps are "lookups": a failed turn (one
 * model/guard step, no tool call) reads "See how it answered" instead of "1 lookup".
 */
export function traceLinkLabel(lookups: number): string {
  return lookups > 0
    ? `${lookups} lookup${lookups === 1 ? "" : "s"}: see how it answered`
    : "See how it answered";
}

/** Number of tool calls (lookups) in a trace. */
export function countLookups(steps: readonly { kind: string }[]): number {
  return steps.filter((s) => s.kind === "tool").length;
}

const EMAIL_IN_TEXT = /([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/;

/**
 * Split text into plain runs and email addresses, so every email can be rendered as one
 * unbreakable mailto link (R2-6 / VIS-7: no "support@volt-" / "supply.example.com" split).
 */
export function splitEmails(text: string): { text: string; email: boolean }[] {
  return text
    .split(EMAIL_IN_TEXT)
    .map((part, i) => ({ text: part, email: i % 2 === 1 }))
    .filter((p) => p.text !== "");
}
