/**
 * GET /api/owner/availability[?businessId=] → { days, items: OwnerAvailability[] }
 * Next 14 local days, per service business and active contractor: open / booked / held slots.
 */
import type { OwnerAvailabilityResponse } from "@/contracts";
import { contractorAvailability } from "@/domain";
import { ownerGet } from "../../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = ownerGet(
  "availability",
  async ({ businessId }): Promise<OwnerAvailabilityResponse> =>
    contractorAvailability(businessId, 14),
);
