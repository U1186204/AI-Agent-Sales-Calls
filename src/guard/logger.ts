/**
 * Structured JSON-lines logger (SPEC §8, AT-84, AT-85).
 *
 *   {"ts":"…","level":"info","reqId":"…","msg":"…", ...fields}
 *
 * Every string that reaches the output (msg and all nested field values) passes through
 * `scrubLogText`, which masks emails, US phone numbers, card-like digit runs, and SSNs.
 * Values under known PII keys (firstName, email, phone, address*, zip, …) are masked by key
 * first (`maskDeep`). The log level comes from `LOG_LEVEL` (default info).
 */
import { getEnv } from "@/config/env";
import { maskDeep, maskEmail, maskPhone } from "./redact";

export type LogLevel = "debug" | "info" | "warn" | "error";
type LevelSetting = LogLevel | "silent";

const LEVEL_RANK: Record<LevelSetting, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export type LogFields = Record<string, unknown>;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE =
  /(?<![\w+])(?:\+?1[\s.-]?)?(?:\(\s*[2-9]\d{2}\s*\)|[2-9]\d{2})[\s.-]?\d{3}[\s.-]?\d{4}(?![\w])/g;
// Any 13–19 digit run (spaces/dashes allowed), Luhn-valid or not: card-like.
const CARDLIKE_RE = /(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w])/g;
const SSN_RE = /(?<![\w-])\d{3}-\d{2}-\d{4}(?![\w-])/g;

/** Mask emails, phone numbers, card-like numbers, and SSNs inside free text. */
export function scrubLogText(text: string): string {
  return text
    .replace(EMAIL_RE, (m) => maskEmail(m))
    .replace(CARDLIKE_RE, "[card-like number]")
    .replace(SSN_RE, "[SSN]")
    .replace(PHONE_RE, (m) => maskPhone(m));
}

function serializeError(err: Error): Record<string, unknown> {
  return {
    name: err.name,
    message: err.message,
    ...(getEnv().NODE_ENV !== "production" && err.stack ? { stack: err.stack } : {}),
    ...("code" in err && typeof err.code === "string" ? { code: err.code } : {}),
  };
}

/** Deep-scrub a value for logging (key-based masking, then text scrubbing). */
export function scrubValue(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrubLogText(v);
    if (typeof v === "bigint") return v.toString();
    if (v === null || typeof v !== "object") return v;
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Error) return walk(serializeError(v));
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
    return out;
  };
  return walk(maskDeep(value));
}

export type LogSink = (line: string, level: LogLevel) => void;

const defaultSink: LogSink = (line, level) => {
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
};

let sink: LogSink = defaultSink;

/** Test hook: capture log lines. Pass nothing to restore the console sink. */
export function setLogSink(next?: LogSink): void {
  sink = next ?? defaultSink;
}

function currentLevel(): LevelSetting {
  try {
    return getEnv().LOG_LEVEL;
  } catch {
    return "info";
  }
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Child logger with extra base fields. */
  child(fields: LogFields): Logger;
  readonly reqId?: string;
}

const RESERVED = new Set(["ts", "level", "reqId", "msg"]);

function emit(level: LogLevel, base: LogFields, msg: string, fields?: LogFields): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[currentLevel()]) return;
  const extra: LogFields = {};
  for (const [k, v] of Object.entries({ ...base, ...fields })) {
    if (!RESERVED.has(k) && v !== undefined) extra[k] = v;
  }
  const scrubbed = scrubValue(extra) as LogFields;
  const record = {
    ts: new Date().toISOString(),
    level,
    reqId: typeof base.reqId === "string" ? base.reqId : undefined,
    msg: scrubLogText(String(msg)),
    ...scrubbed,
  };
  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    line = JSON.stringify({ ts: record.ts, level, reqId: record.reqId, msg: record.msg });
  }
  sink(line, level);
}

export function createLogger(base: LogFields = {}): Logger {
  return {
    debug: (msg, f) => emit("debug", base, msg, f),
    info: (msg, f) => emit("info", base, msg, f),
    warn: (msg, f) => emit("warn", base, msg, f),
    error: (msg, f) => emit("error", base, msg, f),
    child: (f) => createLogger({ ...base, ...f }),
    reqId: typeof base.reqId === "string" ? base.reqId : undefined,
  };
}

/** Process-wide logger (no request id). */
export const logger: Logger = createLogger();

/** Logger bound to a request id (and optionally a route). */
export function withRequestLogger(reqId: string, fields: LogFields = {}): Logger {
  return createLogger({ ...fields, reqId });
}
