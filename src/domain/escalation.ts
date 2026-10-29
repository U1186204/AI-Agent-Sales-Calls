/**
 * Human hand-off (AT-51): Escalation row + ticket reference + expected response time.
 *
 * - Idempotent per conversation (INJ-2, WF-1): while the conversation has an OPEN escalation
 *   created in the last 10 minutes, the existing ticket is returned (`deduplicated: true`) and
 *   the caller sends no second support email. Escalation spam from one chat (25 tool calls,
 *   repeated "Talk to a person" clicks) therefore creates one ticket.
 * - The summary is scrubbed of emails, phone numbers, card numbers, SSNs and passwords before
 *   it is stored or emailed (INJ-5). The only contact detail kept is the explicit
 *   `contactEmail` the customer typed into the hand-off form.
 */
import type { z } from "zod";
import type { EscalationReason } from "@/contracts";
import { encryptJson, generateReference } from "@/guard/crypto";
import { redactContactDetails } from "@/guard/redact";
import { DomainError, requireBusiness } from "./business";
import { db } from "./db";

export type EscalationReasonCode = z.output<typeof EscalationReason>;

/** Window in which a conversation's open escalation is reused instead of creating another. */
export const ESCALATION_DEDUPE_MS = 10 * 60 * 1000;

export interface EscalationResult {
  escalated: true;
  ticketId: string;
  supportEmail: string;
  responseTime: string;
  /** True when an existing open ticket was returned (no new row, send no email). */
  deduplicated: boolean;
  /** For the notify module's support email. The summary is already scrubbed. */
  notification: {
    businessId: string;
    businessName: string;
    supportEmail: string;
    ticketId: string;
    reason: EscalationReasonCode;
    summary: string;
    contactEmail?: string;
    conversationId: string | null;
  };
}

const REASONS: readonly EscalationReasonCode[] = [
  "requested_human",
  "frustration",
  "unresolved",
  "complaint",
  "other",
];

/**
 * True when `recordEscalation` would return this conversation's existing open ticket
 * (dedupe window) instead of creating one. Lets the chat route skip the new-ticket flood
 * limit for a repeat click (R2-2).
 */
export async function hasRecentOpenEscalation(
  businessId: string,
  conversationId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const recent = await db().escalation.findFirst({
    where: {
      businessId,
      conversationId,
      status: "open",
      createdAt: { gte: new Date(now.getTime() - ESCALATION_DEDUPE_MS) },
    },
    select: { id: true },
  });
  return recent !== null;
}

/**
 * Record an escalation (or return the conversation's recent open one). The Escalation row id
 * IS the ticket reference (`ESC-XXXX-XXXX`). Summary (+ optional contact email) are stored
 * encrypted. Marks the conversation escalated (outcome becomes "escalated" unless an
 * order/booking was already completed).
 */
export async function recordEscalation(
  businessId: string,
  conversationId: string | null,
  input: { reason: string; summary: string; contactEmail?: string },
  now: Date = new Date(),
): Promise<EscalationResult> {
  const b = requireBusiness(businessId);
  const reason: EscalationReasonCode = (REASONS as readonly string[]).includes(input.reason)
    ? (input.reason as EscalationReasonCode)
    : "other";
  const summary = redactContactDetails(input.summary.trim()).slice(0, 4000);
  const contactEmail = input.contactEmail?.trim().toLowerCase() || undefined;
  const result = (ticketId: string, deduplicated: boolean): EscalationResult => ({
    escalated: true,
    ticketId,
    supportEmail: b.supportEmail,
    responseTime: b.escalationResponse,
    deduplicated,
    notification: {
      businessId,
      businessName: b.name,
      supportEmail: b.supportEmail,
      ticketId,
      reason,
      summary,
      contactEmail,
      conversationId,
    },
  });

  if (conversationId) {
    const conv = await db().conversation.findFirst({ where: { id: conversationId, businessId } });
    if (!conv) throw new DomainError("unknown_conversation", "Conversation not found for business");
    const recent = await db().escalation.findFirst({
      where: {
        businessId,
        conversationId,
        status: "open",
        createdAt: { gte: new Date(now.getTime() - ESCALATION_DEDUPE_MS) },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (recent) return result(recent.id, true);
  }

  let ticketId = "";
  for (let i = 0; i < 8 && !ticketId; i++) {
    const candidate = generateReference("ESC");
    const clash = await db().escalation.findUnique({
      where: { id: candidate },
      select: { id: true },
    });
    if (!clash) ticketId = candidate;
  }
  if (!ticketId) throw new Error("Could not allocate a ticket id");

  await db().$transaction([
    db().escalation.create({
      data: {
        id: ticketId,
        businessId,
        conversationId,
        reason,
        summaryEnc: encryptJson({ summary, contactEmail: contactEmail ?? null }),
        status: "open",
        createdAt: now,
      },
    }),
    ...(conversationId
      ? [
          db().conversation.updateMany({
            where: { id: conversationId, businessId },
            data: { escalated: true },
          }),
          db().conversation.updateMany({
            where: { id: conversationId, businessId, outcome: "none" },
            data: { outcome: "escalated" },
          }),
        ]
      : []),
  ]);

  return result(ticketId, false);
}
