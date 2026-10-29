/**
 * GET /api/owner/bookings[?businessId=] → { items: OwnerBooking[] }, max 200, sorted by the
 * business-LOCAL start time, each row with its zone label and local start (WF-7).
 */
import type { OwnerBookingsResponse } from "@/contracts";
import { getBusiness } from "@/config/businesses";
import { getServiceDefinition } from "@/config/pricing";
import { listBookings } from "@/domain";
import { ownerGet } from "../../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = ownerGet("bookings", async ({ businessId }): Promise<OwnerBookingsResponse> => {
  const rows = await listBookings({ businessId, limit: 200 });
  return {
    items: rows.map((b) => {
      const service = getServiceDefinition(b.businessId, b.serviceCode)?.name ?? b.serviceCode;
      return {
        businessId: b.businessId,
        businessName: b.businessName,
        reference: b.reference,
        status: b.status,
        serviceName: b.tierName ? `${service} — ${b.tierName}` : service,
        startsAt: b.startsAt,
        timezone: getBusiness(b.businessId)?.timezone ?? "UTC",
        timezoneLabel: b.timezoneLabel,
        localStart: b.appointment,
        durationMin: b.durationMin,
        contractor: b.contractor,
        customerName: b.customer.name,
        totalCents: b.totalCents,
      };
    }),
  };
});
