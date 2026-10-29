/**
 * Small typed fetch client for the browser. Every response is validated with a Zod
 * schema from src/contracts, so a
 * malformed server reply becomes a handled error instead of a runtime crash.
 *
 * - Same-origin only (relative paths, `credentials: "same-origin"`).
 * - Sends `x-csrf-token` from the `oasis_csrf` cookie when present (double-submit).
 * - Never throws for HTTP or network errors; returns a discriminated result.
 */
import type { z } from "zod";
import {
  ChatResponse,
  CheckoutDraftView,
  CheckoutResult,
  CheckoutReview,
  DraftSelectionUpdated,
  DraftSlotsView,
  StatusResponse,
  type ChatErrorCode,
  type ChatRequest,
  type CheckoutInput,
  type DraftSelectionUpdate,
  type OwnerLogin,
  type StatusLookup,
} from "@/contracts";
import { csrfHeaders } from "@/guard/csrf-client";

/** Re-exported for callers that need the raw token (owner tools). */
export { readCsrfToken } from "@/guard/csrf-client";

export type ApiFailure = {
  ok: false;
  status: number;
  /** "network" = no response; "invalid_response" = body did not match the schema. */
  kind: "network" | "http" | "invalid_response";
  body: unknown;
};
export type ApiSuccess<T> = { ok: true; status: number; data: T };
export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  signal?: AbortSignal;
}

async function rawRequest(
  path: string,
  opts: RequestOptions,
): Promise<{ status: number; ok: boolean; body: unknown; retryAfterSec?: number } | null> {
  // Same-origin fetch: the browser sends Origin; the double-submit token rides along when present.
  const headers: Record<string, string> = { accept: "application/json", ...csrfHeaders() };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  try {
    const res = await fetch(path, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: "same-origin",
      cache: "no-store",
      signal: opts.signal,
    });
    let body: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const ra = Number(res.headers.get("retry-after"));
    return {
      status: res.status,
      ok: res.ok,
      body,
      ...(Number.isFinite(ra) && ra > 0 ? { retryAfterSec: Math.ceil(ra) } : {}),
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return null;
  }
}

/** Request + validate a 2xx body against `schema`. */
export async function apiRequest<S extends z.ZodType>(
  path: string,
  schema: S,
  opts: RequestOptions = {},
): Promise<ApiResult<z.output<S>>> {
  const res = await rawRequest(path, opts);
  if (!res) return { ok: false, status: 0, kind: "network", body: null };
  if (!res.ok) return { ok: false, status: res.status, kind: "http", body: res.body };
  const parsed = schema.safeParse(res.body);
  if (!parsed.success) {
    return { ok: false, status: res.status, kind: "invalid_response", body: res.body };
  }
  return { ok: true, status: res.status, data: parsed.data };
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export type ChatSendResult =
  | { ok: true; data: ChatResponse }
  | {
      ok: false;
      code: ChatErrorCode | "network";
      message?: string;
      offerEscalation: boolean;
      /** From the Retry-After header (429), in seconds. */
      retryAfterSec?: number;
    };

function chatCodeForStatus(status: number): ChatErrorCode | "network" {
  if (status === 0) return "network";
  if (status === 429) return "rate_limited";
  if (status === 402) return "budget_exceeded";
  if (status === 413) return "input_too_long";
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 503 || status === 504 || status === 502) return "llm_unavailable";
  return "internal";
}

/** POST /api/chat. Error replies may still carry a full ChatResponse body. */
export async function sendChat(req: ChatRequest, signal?: AbortSignal): Promise<ChatSendResult> {
  const res = await rawRequest("/api/chat", { method: "POST", body: req, signal });
  if (!res) return { ok: false, code: "network", offerEscalation: true };
  const parsed = ChatResponse.safeParse(res.body);
  if (parsed.success) return { ok: true, data: parsed.data };
  const errBody = res.body as { error?: { code?: unknown; message?: unknown } } | null;
  const code =
    typeof errBody?.error?.code === "string"
      ? (errBody.error.code as ChatErrorCode)
      : chatCodeForStatus(res.ok ? 500 : res.status);
  const message = typeof errBody?.error?.message === "string" ? errBody.error.message : undefined;
  const errRetry = (errBody as { error?: { retryAfterSec?: unknown } } | null)?.error
    ?.retryAfterSec;
  const retryAfterSec =
    res.retryAfterSec ??
    (typeof errRetry === "number" && errRetry > 0 ? Math.ceil(errRetry) : undefined);
  return {
    ok: false,
    code,
    message,
    offerEscalation: true,
    ...(retryAfterSec ? { retryAfterSec } : {}),
  };
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/** `?conversationId=` binding: a draft is only readable from the conversation that created it. */
function convQuery(conversationId: string | undefined, sep: "?" | "&"): string {
  return conversationId ? `${sep}conversationId=${encodeURIComponent(conversationId)}` : "";
}

export function getDraft(draftId: string, conversationId?: string, signal?: AbortSignal) {
  return apiRequest(
    `/api/checkout/draft/${encodeURIComponent(draftId)}${convQuery(conversationId, "?")}`,
    CheckoutDraftView,
    { signal },
  );
}

export function getDraftSlots(
  draftId: string,
  date: string,
  conversationId?: string,
  signal?: AbortSignal,
) {
  return apiRequest(
    `/api/checkout/draft/${encodeURIComponent(draftId)}/slots?date=${encodeURIComponent(date)}${convQuery(conversationId, "&")}`,
    DraftSlotsView,
    { signal },
  );
}

export type CheckoutFailure = Extract<CheckoutResult, { ok: false }>;

function toCheckoutFailure(status: number, body: unknown): CheckoutFailure {
  const parsed = CheckoutResult.safeParse(body);
  if (parsed.success && !parsed.data.ok) return parsed.data;
  if (status === 429) {
    return { ok: false, code: "rate_limited", message: "Too many attempts. Wait a moment." };
  }
  return {
    ok: false,
    code: "internal",
    message:
      status === 0
        ? "We couldn't reach the server. Check your connection and try again."
        : "Something went wrong on our side. Please try again.",
  };
}

export async function postReview(
  body: CheckoutInput,
): Promise<{ ok: true; data: CheckoutReview } | CheckoutFailure> {
  const res = await rawRequest("/api/checkout/review", { method: "POST", body });
  if (!res) return toCheckoutFailure(0, null);
  if (res.ok) {
    const parsed = CheckoutReview.safeParse(res.body);
    if (parsed.success) return { ok: true, data: parsed.data };
  }
  return toCheckoutFailure(res.status, res.body);
}

export async function postConfirm(body: CheckoutInput): Promise<CheckoutResult> {
  const res = await rawRequest("/api/checkout/confirm", { method: "POST", body });
  if (!res) return toCheckoutFailure(0, null);
  const parsed = CheckoutResult.safeParse(res.body);
  if (parsed.success) return parsed.data;
  return toCheckoutFailure(res.status, res.body);
}

/**
 * PATCH /api/checkout/draft/:id/selection — change a booking's service configuration. The
 * server re-prices it and returns the new draft view (or a CheckoutFailure).
 */
export async function patchDraftSelection(
  draftId: string,
  body: DraftSelectionUpdate,
  signal?: AbortSignal,
): Promise<{ ok: true; data: DraftSelectionUpdated } | CheckoutFailure> {
  const res = await rawRequest(`/api/checkout/draft/${encodeURIComponent(draftId)}/selection`, {
    method: "PATCH",
    body,
    signal,
  });
  if (!res) return toCheckoutFailure(0, null);
  if (res.ok) {
    const parsed = DraftSelectionUpdated.safeParse(res.body);
    if (parsed.success) return { ok: true, data: parsed.data };
  }
  return toCheckoutFailure(res.status, res.body);
}

/** Re-export so callers can type the base body. */
export type { CheckoutInput };

// ---------------------------------------------------------------------------
// Status + owner
// ---------------------------------------------------------------------------

export function lookupStatus(body: StatusLookup) {
  return apiRequest("/api/status", StatusResponse, { method: "POST", body });
}

export async function ownerLogin(
  body: OwnerLogin,
): Promise<{ ok: true } | { ok: false; status: number }> {
  const res = await rawRequest("/api/owner/login", { method: "POST", body });
  if (!res) return { ok: false, status: 0 };
  return res.ok ? { ok: true } : { ok: false, status: res.status };
}

export async function ownerLogout(): Promise<boolean> {
  const res = await rawRequest("/api/owner/logout", { method: "POST", body: {} });
  return Boolean(res?.ok);
}
