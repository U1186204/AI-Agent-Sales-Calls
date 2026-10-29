/**
 * Shared helpers for the thin `/api/*` route handlers (private folder: not a route).
 *
 * Every response carries `x-request-id` and `cache-control: no-store`. Errors never include
 * stack traces or PII; logs record codes/ids only. CSRF + the per-IP API limit are enforced
 * by src/proxy.ts before a handler runs.
 */
import type { NextRequest } from "next/server";
import { BusinessSlug, Id, type CheckoutResult } from "@/contracts";
import { requireOwnerApi } from "@/auth";
import { apiContext, BODY_TOO_LARGE_MESSAGE, MAX_BODY_BYTES, type ApiContext } from "@/guard/api";
import { REQUEST_ID_HEADER } from "@/guard/request-id";

export type CheckoutFailureBody = Extract<CheckoutResult, { ok: false }>;

export function json(
  body: unknown,
  status: number,
  reqId: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { [REQUEST_ID_HEADER]: reqId, "cache-control": "no-store", ...extraHeaders },
  });
}

/** `{ error: { code, message } }` (ApiErrorBody). */
export function apiError(
  status: number,
  code: string,
  message: string,
  reqId: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return json({ error: { code, message } }, status, reqId, extraHeaders);
}

export type BodyResult = { ok: true; value: unknown } | { ok: false; tooLarge: boolean };

/**
 * Read and parse a JSON body with a hard size cap (SEC-5). Streams `request.body` and stops
 * as soon as the cap is passed, so chunked uploads without `content-length` are bounded too
 * (the proxy already rejects a declared `content-length` over the cap).
 * `{ok:false, tooLarge:true}` → send 413; `{ok:false, tooLarge:false}` → missing/invalid JSON.
 */
export async function readBody(
  request: Request,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<BodyResult> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, tooLarge: true };
  if (!request.body) return { ok: false, tooLarge: false };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, tooLarge: false };
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(buf)) as unknown };
  } catch {
    return { ok: false, tooLarge: false };
  }
}

/**
 * Parse a JSON body; `undefined` when it is missing or malformed. Bodies over the cap also
 * return `undefined` — use `readBody` where a 413 should be sent instead.
 */
export async function readJson(request: Request): Promise<unknown> {
  const r = await readBody(request);
  return r.ok ? r.value : undefined;
}

/** 413 in the `{error:{code,message}}` envelope. */
export function tooLarge(reqId: string): Response {
  return apiError(413, "input_too_long", BODY_TOO_LARGE_MESSAGE, reqId);
}

/**
 * The conversation id that binds a checkout draft (SEC-3): `?conversationId=` or the
 * `x-conversation-id` header. Null when absent or malformed.
 */
export function conversationIdParam(request: Request): string | null {
  let raw: string | null = null;
  try {
    raw = new URL(request.url).searchParams.get("conversationId");
  } catch {
    raw = null;
  }
  raw ??= request.headers.get("x-conversation-id");
  return raw && Id.safeParse(raw).success ? raw : null;
}

/** HTTP status for each checkout failure code. */
export const CHECKOUT_STATUS: Record<CheckoutFailureBody["code"], number> = {
  validation: 422,
  outside_service_area: 422,
  draft_not_found: 404,
  draft_expired: 410,
  already_completed: 409,
  out_of_stock: 409,
  slot_unavailable: 409,
  payment_failed: 402,
  rate_limited: 429,
  internal: 500,
};

/** A CheckoutResult{ok:false} response with the mapped status. Only contract fields are sent. */
export function checkoutFailure(
  f: CheckoutFailureBody,
  reqId: string,
  extraHeaders: Record<string, string> = {},
): Response {
  const body: CheckoutFailureBody = { ok: false, code: f.code, message: f.message };
  if (f.fieldErrors && Object.keys(f.fieldErrors).length) body.fieldErrors = f.fieldErrors;
  return json(body, CHECKOUT_STATUS[f.code], reqId, extraHeaders);
}

export function safeErr(err: unknown): { name: string; message: string } | string {
  // Error messages from Prisma/domain carry ids, never form values; still keep them short.
  return err instanceof Error ? { name: err.name, message: err.message.slice(0, 200) } : "unknown";
}

/**
 * Owner GET wrapper: request context, owner session (401), optional `?businessId` filter
 * (400 when it is not a known slug), and a 500 that never leaks internals.
 */
export function ownerGet(
  name: string,
  handler: (args: { ctx: ApiContext; businessId?: string; url: URL }) => Promise<unknown>,
) {
  return async function GET(request: NextRequest): Promise<Response> {
    const ctx = apiContext(request);
    const auth = requireOwnerApi(request);
    if (auth instanceof Response) {
      return apiError(401, "unauthorized", "Please sign in.", ctx.reqId);
    }
    const url = new URL(request.url);
    const rawBiz = url.searchParams.get("businessId");
    let businessId: string | undefined;
    if (rawBiz !== null && rawBiz !== "" && rawBiz !== "all") {
      const parsed = BusinessSlug.safeParse(rawBiz);
      if (!parsed.success) {
        return apiError(400, "invalid_request", "Unknown business.", ctx.reqId);
      }
      businessId = parsed.data;
    }
    try {
      const body = await handler({ ctx, businessId, url });
      return json(body, 200, ctx.reqId);
    } catch (err) {
      ctx.log.error(`owner_${name}_failed`, { error: safeErr(err) });
      return apiError(
        500,
        "internal",
        "Something went wrong on our side. Please try again.",
        ctx.reqId,
      );
    }
  };
}
