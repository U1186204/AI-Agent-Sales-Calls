/**
 * POST /api/chat  (ChatRequest → ChatResponse)
 *
 * 200 ChatResponse (also for graceful LLM/budget fallbacks: `fallback: true`, and for the
 *     LLM-free "Talk to a person" event `{type:"request_human"}`)
 * 400 invalid body / message too long (`input_too_long`, also when NFKC normalization would
 *     have truncated it) · 403 conversation belongs to another business · 413 body > 64 KB
 * 404 unknown conversation · 429 rate limited (per IP / per conversation; `escalation_limited`
 *     when "Talk to a person" would open too many NEW tickets, R2-2) · 500 internal
 * Error bodies: `{ error: { code, message } }` (429 per IP uses the guard's shape).
 * CSRF + the per-IP API limit are enforced by src/proxy.ts. No stack traces, no PII in logs.
 */
import type { NextRequest } from "next/server";
import { ChatRequest, type ChatErrorCode } from "@/contracts";
import { getEnv } from "@/config/env";
import {
  createConversation,
  getBusinessProfile,
  getConversation,
  hasRecentOpenEscalation,
} from "@/domain";
import { runTurn, UnknownConversationError } from "@/agent";
import { apiContext, tooManyRequests } from "@/guard/api";
import { checkChatRateLimit, checkEscalationRateLimit, countFirstTurn } from "@/guard/rate-limit";
import { redactSensitive, type RedactionKind } from "@/guard/redact";
import { sanitizeUserTextDetailed } from "@/guard/sanitize";
import { readBody } from "../_lib/http";
import { REQUEST_ID_HEADER } from "@/guard/request-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorJson(
  status: number,
  code: ChatErrorCode,
  message: string,
  reqId: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return Response.json(
    { error: { code, message } },
    {
      status,
      headers: { [REQUEST_ID_HEADER]: reqId, "cache-control": "no-store", ...extraHeaders },
    },
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  const { reqId, ip, log } = apiContext(request);
  try {
    const maxChars = getEnv().OASIS_MAX_INPUT_CHARS;
    const tooLong = (status: number) =>
      errorJson(
        status,
        "input_too_long",
        `Messages can be up to ${maxChars.toLocaleString("en-US")} characters. Please shorten it.`,
        reqId,
      );
    const read = await readBody(request);
    if (!read.ok) {
      return read.tooLarge
        ? tooLong(413)
        : errorJson(400, "invalid_request", "The request body must be JSON.", reqId);
    }
    const parsed = ChatRequest.safeParse(read.value);
    if (!parsed.success) {
      // ADV-5: an over-long message is "too long" whatever its size, not "invalid".
      if (parsed.error.issues.some((i) => i.code === "too_big" && i.path[0] === "message")) {
        return tooLong(400);
      }
      return errorJson(
        400,
        "invalid_request",
        "Send a message or an event for a known business.",
        reqId,
      );
    }
    const req = parsed.data;
    if (req.message !== undefined && Array.from(req.message).length > maxChars) {
      return tooLong(400);
    }
    if (req.event && req.event.type !== "request_human" && !req.conversationId) {
      return errorJson(400, "invalid_request", "Checkout events need their conversation.", reqId);
    }

    // Existing conversation: the business comes from the stored record only.
    let conversationId = req.conversationId;
    if (conversationId) {
      const conv = await getConversation(conversationId);
      if (!conv) {
        return errorJson(
          404,
          "not_found",
          "This conversation has ended. Please start a new chat.",
          reqId,
        );
      }
      if (conv.businessId !== req.businessId) {
        log.warn("chat_business_switch_rejected", { conversationId });
        return errorJson(
          403,
          "invalid_request",
          "This conversation belongs to a different business. Please start a new chat.",
          reqId,
        );
      }
    }

    // "Talk to a person" must work even when the chat hit its message cap: it only counts
    // against the per-IP limit.
    const isHumanRequest = req.event?.type === "request_human";
    const rl = checkChatRateLimit({ ip, conversationId: isHumanRequest ? null : conversationId });
    if (!rl.ok) {
      log.warn("chat_rate_limited", { scope: rl.scope, retryAfterSec: rl.retryAfterSec });
      if (rl.scope === "conversation") {
        return errorJson(
          429,
          "session_limit",
          "This chat has reached its message limit. Please start a new chat or ask for a human.",
          reqId,
          { "retry-after": String(rl.retryAfterSec) },
        );
      }
      return tooManyRequests(
        rl.retryAfterSec,
        reqId,
        "You're sending messages too quickly. Please wait a moment and try again.",
      );
    }

    // Sanitize + redact before anything else touches the text.
    let userText: string | undefined;
    let redactions: RedactionKind[] = [];
    if (req.message !== undefined && !req.event) {
      const clean = sanitizeUserTextDetailed(req.message, maxChars);
      // ADV-5: NFKC can expand text past the limit; tell the user instead of silently cutting.
      if (clean.truncated) return tooLong(400);
      const r = redactSensitive(clean.text);
      userText = r.text;
      redactions = r.redactions;
      if (!userText) {
        return errorJson(400, "invalid_request", "Your message was empty.", reqId);
      }
    }

    // R2-2: "Talk to a person" sends a support email, so NEW tickets are capped per IP and per
    // business. A repeat click in a conversation whose ticket is still open is deduplicated by
    // the domain (no email) and is not counted.
    if (isHumanRequest) {
      const deduped =
        conversationId !== undefined &&
        (await hasRecentOpenEscalation(req.businessId, conversationId));
      if (!deduped) {
        const erl = checkEscalationRateLimit(ip, req.businessId);
        if (!erl.ok) {
          log.warn("escalation_rate_limited", {
            scope: erl.scope,
            businessId: req.businessId,
            retryAfterSec: erl.retryAfterSec,
          });
          const supportEmail = (await getBusinessProfile(req.businessId))?.supportEmail;
          return errorJson(
            429,
            "escalation_limited",
            `We've already received several requests to talk to a person, so this one wasn't sent. ` +
              (supportEmail
                ? `Please email ${supportEmail} and the team will help.`
                : "Please email the support team."),
            reqId,
            { "retry-after": String(erl.retryAfterSec) },
          );
        }
      }
    }

    if (!conversationId) {
      // Every request — including "Talk to a person" — runs in a conversation bound to this
      // business, so the escalation dedupe and the turn cap apply to what follows.
      conversationId = (await createConversation(req.businessId)).id;
      log.info("chat_conversation_created", { conversationId, businessId: req.businessId });
      // R2-4: count this first user message against OASIS_MAX_TURNS (the check above ran
      // before the conversation existed).
      if (!isHumanRequest) countFirstTurn(conversationId);
    }

    const started = Date.now();
    const result = await runTurn({
      conversationId,
      userText,
      event: req.event,
      reqId,
      priorRedactions: redactions,
      ip,
    });
    const r = result.response;
    log.info("chat_turn", {
      conversationId,
      businessId: req.businessId,
      event: req.event?.type,
      ms: Date.now() - started,
      fallback: r.fallback,
      errorCode: r.error?.code,
      model: r.usage?.model,
      inputTokens: r.usage?.inputTokens ?? 0,
      outputTokens: r.usage?.outputTokens ?? 0,
      costUsd: r.usage?.costUsd ?? 0,
      toolRounds: r.usage?.toolRounds ?? 0,
      tools: result.toolCalls.map((t) => t.name),
      redactions: redactions.length,
      outputBlocked: result.outputBlocked,
    });
    return Response.json(r, {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: reqId, "cache-control": "no-store" },
    });
  } catch (err) {
    if (err instanceof UnknownConversationError) {
      return errorJson(
        404,
        "not_found",
        "This conversation has ended. Please start a new chat.",
        reqId,
      );
    }
    log.error("chat_failed", {
      error: err instanceof Error ? { name: err.name, message: err.message } : "unknown",
    });
    return errorJson(500, "internal", "Something went wrong on our side. Please try again.", reqId);
  }
}
