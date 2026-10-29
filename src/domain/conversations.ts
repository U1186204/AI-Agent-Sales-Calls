/** Conversation + message + usage persistence for the agent module. */
import { decryptString, encryptString, randomId } from "@/guard/crypto";
import { DomainError, requireBusiness } from "./business";
import { db } from "./db";

export type ConversationOutcome = "none" | "order" | "booking" | "escalated";
export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface ConversationRecord {
  id: string;
  businessId: string;
  createdAt: Date;
  lastActiveAt: Date;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  escalated: boolean;
  outcome: string;
}

export interface StoredMessage {
  id: string;
  role: string;
  /** Decrypted text (was redacted by the caller before storage). */
  text: string;
  trace: unknown;
  createdAt: Date;
}

/** New conversation with a 128-bit random id (it is the chat's bearer handle, SEC-11). */
export async function createConversation(businessId: string): Promise<ConversationRecord> {
  requireBusiness(businessId);
  return db().conversation.create({ data: { id: randomId(), businessId } });
}

/** Null if unknown. `withMessages` adds the decrypted history (oldest first). */
export async function getConversation(
  id: string,
  opts: { withMessages?: boolean; messageLimit?: number } = {},
): Promise<(ConversationRecord & { messages?: StoredMessage[] }) | null> {
  const conv = await db().conversation.findUnique({ where: { id } });
  if (!conv) return null;
  if (!opts.withMessages) return conv;
  const rows = await db().message.findMany({
    where: { conversationId: id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: opts.messageLimit ?? 100,
  });
  const messages = rows.reverse().map((m) => ({
    id: m.id,
    role: m.role,
    text: tryDecrypt(m.contentEnc),
    trace: m.trace,
    createdAt: m.createdAt,
  }));
  return { ...conv, messages };
}

function tryDecrypt(v: string): string {
  try {
    return decryptString(v);
  } catch {
    return "[unreadable]";
  }
}

/** Store one message (text encrypted; the caller has ALREADY redacted it). */
export async function appendMessage(
  conversationId: string,
  role: MessageRole,
  text: string,
  trace?: unknown,
): Promise<{ id: string; messageCount: number }> {
  const now = new Date();
  const [msg, conv] = await db().$transaction([
    db().message.create({
      data: {
        conversationId,
        role,
        contentEnc: encryptString(text),
        trace: trace === undefined ? undefined : (JSON.parse(JSON.stringify(trace)) as object),
      },
    }),
    db().conversation.update({
      where: { id: conversationId },
      data: { messageCount: { increment: 1 }, lastActiveAt: now },
    }),
  ]);
  return { id: msg.id, messageCount: conv.messageCount };
}

export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export interface UsageTotals {
  day: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  requests: number;
}

/** Add one LLM call's usage to the conversation and to today's (UTC) UsageDay. */
export async function addUsage(
  conversationId: string,
  usage: { inputTokens: number; outputTokens: number; costMicros: number },
  now: Date = new Date(),
): Promise<{ conversation: ConversationRecord; day: UsageTotals }> {
  const n = (v: number) => Math.max(0, Math.round(v));
  const input = n(usage.inputTokens);
  const output = n(usage.outputTokens);
  const cost = n(usage.costMicros);
  const day = utcDay(now);
  const [conversation, d] = await db().$transaction([
    db().conversation.update({
      where: { id: conversationId },
      data: {
        inputTokens: { increment: input },
        outputTokens: { increment: output },
        costMicros: { increment: cost },
        lastActiveAt: now,
      },
    }),
    db().usageDay.upsert({
      where: { day },
      create: { day, inputTokens: input, outputTokens: output, costMicros: cost, requests: 1 },
      update: {
        inputTokens: { increment: input },
        outputTokens: { increment: output },
        costMicros: { increment: cost },
        requests: { increment: 1 },
      },
    }),
  ]);
  return {
    conversation,
    day: {
      day: d.day,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      costMicros: d.costMicros,
      requests: d.requests,
    },
  };
}

/** Usage for a UTC day `YYYY-MM-DD` (default today); zeros when nothing was recorded. */
export async function getDailyUsage(day: string = utcDay()): Promise<UsageTotals> {
  const d = await db().usageDay.findUnique({ where: { day } });
  return {
    day,
    inputTokens: d?.inputTokens ?? 0,
    outputTokens: d?.outputTokens ?? 0,
    costMicros: d?.costMicros ?? 0,
    requests: d?.requests ?? 0,
  };
}

export async function setConversationOutcome(
  conversationId: string,
  outcome: ConversationOutcome,
): Promise<void> {
  const res = await db().conversation.updateMany({
    where: { id: conversationId },
    data: { outcome, ...(outcome === "escalated" ? { escalated: true } : {}) },
  });
  if (res.count === 0) throw new DomainError("unknown_conversation", "Conversation not found");
}
