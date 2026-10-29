/** Live inventory checks and product quotes (business-scoped). */
import type { z } from "zod";
import type { CheckInventoryOutput, ProductSummary, QuoteProductsOutput } from "@/contracts";
import { requireBusiness, DomainError } from "./business";
import { toProductSummary } from "./catalog";
import { db, type Tx } from "./db";
import { priceProducts, type PricedItem } from "./pricing";

export interface LineRequest {
  sku: string;
  qty: number;
}

/** Upper-case SKUs and merge duplicate lines (quantities add up). Order preserved. */
export function mergeLines(lines: readonly LineRequest[]): LineRequest[] {
  const map = new Map<string, number>();
  for (const l of lines) {
    const sku = l.sku.trim().toUpperCase();
    map.set(sku, (map.get(sku) ?? 0) + Math.max(0, Math.floor(l.qty)));
  }
  return [...map.entries()].map(([sku, qty]) => ({ sku, qty }));
}

async function productsBySku(businessId: string, skus: string[], client: Tx = db()) {
  const rows = await client.product.findMany({
    where: { businessId, active: true, sku: { in: skus } },
  });
  return new Map(rows.map((r) => [r.sku, r]));
}

function assertProductBusiness(businessId: string): void {
  const b = requireBusiness(businessId);
  if (b.kind !== "product") {
    throw new DomainError("wrong_business_kind", `${b.name} does not sell products`);
  }
}

export type InventoryLine = z.output<typeof CheckInventoryOutput>["items"][number] & {
  qtyOnHand: number;
};

/**
 * Per line: status in_stock | partial | out_of_stock | not_found, `available` (= units that can
 * be sold now, i.e. qtyOnHand), and up to 3 in-stock alternatives from the same category.
 */
export async function checkInventory(
  businessId: string,
  lines: readonly LineRequest[],
): Promise<{ items: InventoryLine[] }> {
  assertProductBusiness(businessId);
  const merged = mergeLines(lines);
  const found = await productsBySku(
    businessId,
    merged.map((l) => l.sku),
  );
  const items: InventoryLine[] = [];
  for (const l of merged) {
    const p = found.get(l.sku);
    if (!p) {
      items.push({
        sku: l.sku,
        requested: l.qty,
        available: 0,
        qtyOnHand: 0,
        status: "not_found",
        alternatives: [],
      });
      continue;
    }
    const onHand = Math.max(0, p.qtyOnHand);
    const status = onHand === 0 ? "out_of_stock" : onHand < l.qty ? "partial" : "in_stock";
    items.push({
      sku: p.sku,
      name: p.name,
      requested: l.qty,
      available: onHand,
      qtyOnHand: onHand,
      status,
      alternatives:
        status === "in_stock"
          ? []
          : await alternativesFor(businessId, p.category, p.sku, p.priceCents),
    });
  }
  return { items };
}

/** In-stock products in the same category, closest in price first. */
export async function alternativesFor(
  businessId: string,
  category: string,
  excludeSku: string,
  priceCents: number,
  limit = 3,
): Promise<ProductSummary[]> {
  const rows = await db().product.findMany({
    where: { businessId, category, active: true, qtyOnHand: { gt: 0 }, sku: { not: excludeSku } },
  });
  return rows
    .sort((a, b) => Math.abs(a.priceCents - priceCents) - Math.abs(b.priceCents - priceCents))
    .slice(0, limit)
    .map(toProductSummary);
}

export type ProductQuoteResult = z.output<typeof QuoteProductsOutput>;
export type ProductQuoteIssue = Extract<ProductQuoteResult, { issues: unknown }>["issues"][number];

/**
 * Price lines (+ shipping to `zip`). Unknown SKUs and out-of-stock lines are left out and
 * flagged; insufficient-stock lines are priced at the available quantity and flagged.
 * Never throws on bad lines.
 */
export async function quoteProducts(
  businessId: string,
  lines: readonly LineRequest[],
  zip?: string,
): Promise<ProductQuoteResult> {
  assertProductBusiness(businessId);
  const { items, issues } = await resolveLines(businessId, lines, "clamp");
  if (items.length === 0) {
    return {
      notFound: true,
      message:
        issues.length > 0
          ? `Nothing could be priced: ${issues.map((i) => `${i.sku} (${i.problem.replace(/_/g, " ")})`).join(", ")}.`
          : "No lines to price.",
    };
  }
  return { quote: priceProducts(items, zip).quote, issues };
}

/**
 * Look up lines in this business's catalog. `clamp` prices insufficient lines at the
 * available quantity; `strict` keeps the requested quantity (caller rejects on issues).
 */
export async function resolveLines(
  businessId: string,
  lines: readonly LineRequest[],
  mode: "clamp" | "strict",
  client: Tx = db(),
): Promise<{ items: (PricedItem & { productId: string })[]; issues: ProductQuoteIssue[] }> {
  const merged = mergeLines(lines).filter((l) => l.qty > 0);
  const found = await productsBySku(
    businessId,
    merged.map((l) => l.sku),
    client,
  );
  const items: (PricedItem & { productId: string })[] = [];
  const issues: ProductQuoteIssue[] = [];
  for (const l of merged) {
    const p = found.get(l.sku);
    if (!p) {
      issues.push({ sku: l.sku, problem: "not_found" });
      continue;
    }
    const onHand = Math.max(0, p.qtyOnHand);
    if (onHand === 0) {
      issues.push({ sku: p.sku, problem: "out_of_stock", available: 0 });
      continue;
    }
    let qty = l.qty;
    if (onHand < l.qty) {
      issues.push({ sku: p.sku, problem: "insufficient_stock", available: onHand });
      if (mode === "clamp") qty = onHand;
    }
    items.push({
      productId: p.id,
      sku: p.sku,
      name: p.name,
      unit: p.unit,
      priceCents: p.priceCents,
      weightLb: p.weightLb,
      qty,
    });
  }
  return { items, issues };
}
