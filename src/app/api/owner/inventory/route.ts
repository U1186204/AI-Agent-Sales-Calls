/** GET /api/owner/inventory[?businessId=] → { items: OwnerInventoryItem[] } (active products). */
import type { OwnerInventoryResponse, StockLevel } from "@/contracts";
import { getBusiness } from "@/config/businesses";
import { inventoryLevels } from "@/domain";
import { ownerGet } from "../../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STOCK: Record<"ok" | "low" | "out", StockLevel> = { ok: "in_stock", low: "low", out: "out" };

export const GET = ownerGet(
  "inventory",
  async ({ businessId }): Promise<OwnerInventoryResponse> => {
    const rows = await inventoryLevels(businessId);
    return {
      items: rows.map((p) => ({
        businessId: p.businessId,
        businessName: getBusiness(p.businessId)?.name ?? p.businessId,
        sku: p.sku,
        name: p.name,
        category: p.category,
        qtyOnHand: p.qtyOnHand,
        priceCents: p.priceCents,
        stock: STOCK[p.level],
      })),
    };
  },
);
