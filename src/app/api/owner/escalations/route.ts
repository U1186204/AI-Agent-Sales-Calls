/**
 * GET /api/owner/escalations[?businessId=] → OwnerEscalationsResponse, newest first, max 200
 * (WF-2). Owner session required (401). Summaries have emails, phones and cards removed;
 * the customer's optional contact email is masked.
 */
import type { OwnerEscalationsResponse } from "@/contracts";
import { listEscalations } from "@/domain";
import { ownerGet } from "../../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = ownerGet(
  "escalations",
  async ({ businessId }): Promise<OwnerEscalationsResponse> => ({
    items: await listEscalations(200, businessId),
  }),
);
