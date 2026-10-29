/** GET /api/owner/orders[?businessId=] → { items: OwnerOrder[] } newest first, max 200. */
import type { OwnerOrdersResponse } from "@/contracts";
import { listOrders } from "@/domain";
import { ownerGet } from "../../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = ownerGet("orders", async ({ businessId }): Promise<OwnerOrdersResponse> => {
  const rows = await listOrders({ businessId, limit: 200 });
  return {
    items: rows.map((o) => ({
      businessId: o.businessId,
      businessName: o.businessName,
      reference: o.reference,
      status: o.status,
      createdAt: o.createdAt,
      customerName: o.customer.name,
      itemCount: o.itemCount,
      totalCents: o.totalCents,
      shipZone: o.shipZone > 0 ? o.shipZone : null,
    })),
  };
});
