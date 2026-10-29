/**
 * GET /api/owner/conversations[?businessId=] → { items: OwnerConversation[] } newest first,
 * max 200. Metadata only — no message content.
 */
import { ConversationOutcome, type OwnerConversationsResponse } from "@/contracts";
import { listConversations } from "@/domain";
import { ownerGet } from "../../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = ownerGet(
  "conversations",
  async ({ businessId }): Promise<OwnerConversationsResponse> => {
    const rows = await listConversations(200, businessId);
    return {
      items: rows.map((c) => {
        const outcome = ConversationOutcome.safeParse(c.outcome);
        return {
          id: c.id,
          businessId: c.businessId,
          businessName: c.businessName,
          createdAt: c.createdAt,
          lastActiveAt: c.lastActiveAt,
          messageCount: c.messageCount,
          inputTokens: c.inputTokens,
          outputTokens: c.outputTokens,
          costUsd: c.costUsd,
          escalated: c.escalated,
          outcome: outcome.success ? outcome.data : "none",
        };
      }),
    };
  },
);
