import { z } from "zod";
import { BusinessSlug, CheckoutKind, Email, Id, Reference } from "./common";
import { ToolName } from "./tools";
import {
  CardAction,
  CartSummaryBlock,
  EstimateCardBlock,
  ProductCardsBlock,
  QuoteCardBlock,
  ServicePickerBlock,
  SlotSuggestionsBlock,
} from "./cards";

/**
 * `ChatUsage.model` reported by the TEST-ONLY scripted LLM (OASIS_LLM_STUB=1). The trace
 * panel shows "Test mode" for it.
 */
export const TEST_STUB_MODEL = "oasis-test-stub";

/** Hard upper bound; the server also enforces OASIS_MAX_INPUT_CHARS (default 2,000). */
export const CHAT_MESSAGE_HARD_MAX = 20_000;

/** Max length of the optional note sent with a "Talk to a person" request. */
export const HUMAN_REQUEST_NOTE_MAX = 500;

/**
 * Events the client posts into a conversation.
 *
 * - `checkout_completed` / `checkout_cancelled`: never contain PII; verified against the draft
 *   created in THIS conversation.
 * - `request_human` ("Talk to a person" button): handled WITHOUT the LLM. The server records an
 *   escalation (idempotent per conversation for 10 minutes), emails support, and replies with
 *   one text block holding the ticket ref (ESC-…), the support email and the expected response
 *   time. `contactEmail` (optional) is the only place a customer email is accepted outside
 *   checkout; it is stored encrypted and shown to support masked in the dashboard.
 * - `card_action`: a click on an interactive card (src/contracts/cards.ts). Handled WITHOUT
 *   the LLM: the server validates the codes against this business's catalog, runs the real
 *   tools and replies with the next card. The payload never carries prices or labels.
 */
export const ChatEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("checkout_completed"), draftId: Id, reference: Reference }),
  z.object({ type: z.literal("checkout_cancelled"), draftId: Id }),
  z.object({
    type: z.literal("request_human"),
    note: z.string().trim().max(HUMAN_REQUEST_NOTE_MAX).optional(),
    contactEmail: Email.optional(),
  }),
  z.object({ type: z.literal("card_action"), action: CardAction }),
]);
export type ChatEvent = z.infer<typeof ChatEvent>;

export const ChatRequest = z
  .object({
    /** Used only when creating a conversation; afterwards the server uses the stored value. */
    businessId: BusinessSlug,
    conversationId: Id.optional(),
    message: z.string().max(CHAT_MESSAGE_HARD_MAX).optional(),
    event: ChatEvent.optional(),
  })
  .refine(
    (r) => (r.message !== undefined && r.message.trim().length > 0) || r.event !== undefined,
    {
      message: "Send a message or an event",
      path: ["message"],
    },
  );
export type ChatRequest = z.infer<typeof ChatRequest>;

export const UiBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("form"),
    draftId: Id,
    kind: CheckoutKind,
    /** Short, PII-free summary of what is being bought/booked, shown above the form. */
    summary: z.string(),
  }),
  ServicePickerBlock,
  QuoteCardBlock,
  SlotSuggestionsBlock,
  EstimateCardBlock,
  ProductCardsBlock,
  CartSummaryBlock,
]);
export type UiBlock = z.infer<typeof UiBlock>;

/**
 * A data reference shown as a chip in the trace panel. `id` is the HUMAN-READABLE value to
 * display — never a raw database id: SKUs and service codes as-is, slots as their local time
 * ("Tue Oct 13, 9:00 AM"), drafts as "Checkout #<last 4>", ZIPs as a 3-digit prefix.
 */
export const DataRef = z.object({
  type: z.enum(["sku", "service", "slot", "policy", "order", "booking", "draft", "zip", "ticket"]),
  id: z.string(),
});
export type DataRef = z.infer<typeof DataRef>;

/** Max data refs per trace step; the rest are counted in `TraceStep.moreRefs`. */
export const TRACE_MAX_REFS = 6;

/** One step in the transparency panel (all values PII-masked). */
export const TraceStep = z.object({
  id: z.string(),
  kind: z.enum(["tool", "guard", "model"]),
  tool: ToolName.optional(),
  /** Friendly label, e.g. "Checked live inventory". */
  label: z.string(),
  /** The model's stated reason (tool `reason` arg), or the guard/model note. */
  why: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
  outputSummary: z.string(),
  /** At most TRACE_MAX_REFS, most relevant first. */
  dataRefs: z.array(DataRef).default([]),
  /** How many further refs were omitted ("+19 more"). Absent when none. */
  moreRefs: z.number().int().min(1).optional(),
  ok: z.boolean(),
  error: z.string().optional(),
  /** Measured duration; tool steps report at least 1. */
  ms: z.number().int().min(0),
});
export type TraceStep = z.infer<typeof TraceStep>;

export const ChatUsage = z.object({
  model: z.string(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  costUsd: z.number().min(0),
  toolRounds: z.number().int().min(0),
});
export type ChatUsage = z.infer<typeof ChatUsage>;

export const ChatErrorCode = z.enum([
  "llm_unconfigured",
  "llm_unavailable",
  "rate_limited",
  "session_limit",
  /** Too many new "Talk to a person" tickets from this client / for this business (R2-2). */
  "escalation_limited",
  "budget_exceeded",
  "input_too_long",
  "not_found",
  "invalid_request",
  "internal",
]);
export type ChatErrorCode = z.infer<typeof ChatErrorCode>;

export const ChatResponse = z.object({
  conversationId: Id,
  blocks: z.array(UiBlock),
  trace: z.array(TraceStep),
  usage: ChatUsage.optional(),
  /** True when the reply is a canned fallback (no/failed LLM call). */
  fallback: z.boolean().default(false),
  /** Offer the human hand-off button (e.g. after an LLM failure). */
  offerEscalation: z.boolean().default(false),
  error: z.object({ code: ChatErrorCode, message: z.string() }).optional(),
});
export type ChatResponse = z.infer<typeof ChatResponse>;
