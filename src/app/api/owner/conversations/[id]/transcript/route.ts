/**
 * GET /api/owner/conversations/:id/transcript → OwnerTranscript (WF-2). Owner session
 * required (401); 400 malformed id; 404 unknown conversation. Customer + assistant messages
 * only, oldest first, max 200: stored text is already redacted (cards/SSNs/passwords) and
 * emails/phone numbers are masked here.
 */
import type { NextRequest } from "next/server";
import { Id, type OwnerTranscript } from "@/contracts";
import { requireOwnerApi } from "@/auth";
import { getConversationTranscript } from "@/domain";
import { apiContext } from "@/guard/api";
import { apiError, json, safeErr } from "../../../../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = apiContext(request);
  const auth = requireOwnerApi(request);
  if (auth instanceof Response) return apiError(401, "unauthorized", "Please sign in.", ctx.reqId);
  try {
    const { id } = await params;
    if (!Id.safeParse(id).success) {
      return apiError(400, "invalid_request", "Invalid conversation id.", ctx.reqId);
    }
    const t = await getConversationTranscript(id);
    if (!t) return apiError(404, "not_found", "Conversation not found.", ctx.reqId);
    const body: OwnerTranscript = {
      conversationId: t.conversationId,
      businessName: t.businessName,
      messages: t.messages,
    };
    return json(body, 200, ctx.reqId);
  } catch (err) {
    ctx.log.error("owner_transcript_failed", { error: safeErr(err) });
    return apiError(
      500,
      "internal",
      "Something went wrong on our side. Please try again.",
      ctx.reqId,
    );
  }
}
