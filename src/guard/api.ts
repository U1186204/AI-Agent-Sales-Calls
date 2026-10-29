/**
 * Guard helpers for `/api/*`.
 *
 * `src/proxy.ts` calls `guardApi(request)` for EVERY /api request (CSRF + per-IP API rate
 * limit) and stamps `x-request-id`. Route handlers therefore do not repeat those checks;
 * they call `apiContext(request)` for the request id, client IP, and a request-bound
 * logger, then apply route-specific guards (chat rate limit, budget, sanitize/redact).
 */
import { getEnv } from "@/config/env";
import { checkCsrf, type CsrfFailure } from "./csrf";
import { withRequestLogger, type Logger } from "./logger";
import { checkApiRateLimit, clientIp } from "./rate-limit";
import { getRequestId, REQUEST_ID_HEADER } from "./request-id";

export interface ApiContext {
  reqId: string;
  ip: string;
  log: Logger;
}

export function apiContext(request: Request): ApiContext {
  const reqId = getRequestId(request.headers);
  const route = safePath(request.url);
  return { reqId, ip: clientIp(request), log: withRequestLogger(reqId, { route }) };
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function jsonError(
  status: number,
  body: Record<string, unknown>,
  reqId: string,
  extra: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { [REQUEST_ID_HEADER]: reqId, "cache-control": "no-store", ...extra },
  });
}

const CSRF_MESSAGES: Record<CsrfFailure, string> = {
  origin_mismatch: "Cross-site request blocked.",
  missing_origin: "Cross-site request blocked.",
  token_missing: "Security token missing. Please reload the page and try again.",
  token_mismatch: "Security token mismatch. Please reload the page and try again.",
};

/** 403 response for a CSRF failure. */
export function forbiddenCsrf(reason: CsrfFailure, reqId: string): Response {
  return jsonError(403, { error: "forbidden", reason, message: CSRF_MESSAGES[reason] }, reqId);
}

/** 429 response with Retry-After. */
export function tooManyRequests(retryAfterSec: number, reqId: string, message?: string): Response {
  return jsonError(
    429,
    {
      error: "rate_limited",
      retryAfterSec,
      message:
        message ?? "You're sending requests too quickly. Please wait a moment and try again.",
    },
    reqId,
    { "retry-after": String(retryAfterSec) },
  );
}

/** Max request body for every /api route (SEC-5). Chat messages are ≤ 20,000 chars. */
export const MAX_BODY_BYTES = 64 * 1024;

export const BODY_TOO_LARGE_MESSAGE = "This request is too large. Please shorten your message.";

/** 413 response (same `{error:{code,message}}` envelope as the chat/status errors). */
export function payloadTooLarge(reqId: string): Response {
  return jsonError(
    413,
    { error: { code: "input_too_long", message: BODY_TOO_LARGE_MESSAGE } },
    reqId,
  );
}

export interface GuardApiOptions {
  /** SEC-8: is this owner CSRF token bound to the caller's session? (set by the proxy) */
  isCsrfTokenBound?: (token: string) => boolean;
}

/**
 * Run the global API guards. Returns a Response to send (403/413/429) or null to continue.
 * Used by the proxy; route handlers may call it too if they are ever served without it.
 */
export function guardApi(
  request: Request,
  reqId = getRequestId(request.headers),
  opts: GuardApiOptions = {},
): Response | null {
  const pathname = safePath(request.url);
  const log = withRequestLogger(reqId, { route: pathname, method: request.method });
  const env = getEnv();
  const csrf = checkCsrf(request, pathname, env.APP_URL, {
    trustProxy: env.TRUST_PROXY,
    production: env.NODE_ENV === "production",
    isBound: opts.isCsrfTokenBound,
  });
  if (!csrf.ok) {
    log.warn("csrf_rejected", { reason: csrf.reason });
    return forbiddenCsrf(csrf.reason, reqId);
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    log.warn("body_too_large", { bytes: declared });
    return payloadTooLarge(reqId);
  }
  const rl = checkApiRateLimit(clientIp(request));
  if (!rl.ok) {
    log.warn("api_rate_limited", { retryAfterSec: rl.retryAfterSec });
    return tooManyRequests(rl.retryAfterSec, reqId);
  }
  return null;
}
