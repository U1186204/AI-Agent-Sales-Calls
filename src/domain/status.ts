/**
 * Order/booking status lookup (AT-50). Returns the SAME generic not-found result unless the
 * reference AND the email hash both match a record of THIS business. No PII except the
 * customer's first name (the agent's contract parse strips it before the LLM sees it).
 */
import type { z } from "zod";
import { StatusLookup, type LookupStatusOutput } from "@/contracts";
import { getServiceDefinition } from "@/config/pricing";
import { decryptString, safeEqualHex } from "@/guard/crypto";
import { requireBusiness } from "./business";
import { db } from "./db";
import { appointmentLabel } from "./availability";
import { emailHash } from "./checkout";
import { formatDuration } from "./pricing";

const NOT_FOUND = {
  found: false as const,
  message:
    "We could not find an order or booking with that reference and email. Check both and try again.",
};

export type StatusResult =
  | (Extract<z.output<typeof LookupStatusOutput>, { found: true }> & {
      firstName: string;
      items?: { sku: string; name: string; qty: number }[];
      totals: {
        subtotalCents: number;
        discountCents: number;
        shippingCents: number;
        taxCents: number;
        totalCents: number;
      };
    })
  | Extract<z.output<typeof LookupStatusOutput>, { found: false }>;

interface OrderLine {
  sku: string;
  name: string;
  qty: number;
}

export async function lookupStatus(
  businessId: string,
  input: { reference: string; email: string },
): Promise<StatusResult> {
  const b = requireBusiness(businessId);
  const parsed = StatusLookup.safeParse(input);
  // Always hash + query so timing does not reveal which half failed.
  const hash = emailHash(parsed.success ? parsed.data.email : String(input?.email ?? ""));
  const reference = parsed.success ? parsed.data.reference : "";
  const [order, booking] = await Promise.all([
    db().order.findFirst({ where: { businessId, reference }, include: { customer: true } }),
    db().booking.findFirst({ where: { businessId, reference }, include: { customer: true } }),
  ]);
  if (!parsed.success) return NOT_FOUND;

  const rec = order ?? booking;
  if (!rec || !safeEqualHex(rec.customer.emailHash, hash)) return NOT_FOUND;

  const firstName = safeDecrypt(rec.customer.firstNameEnc);
  const totals = {
    subtotalCents: rec.subtotalCents,
    discountCents: rec.discountCents,
    shippingCents: rec.shippingCents,
    taxCents: rec.taxCents,
    totalCents: rec.totalCents,
  };
  if (order) {
    const lines = (Array.isArray(order.lines) ? order.lines : []) as unknown as OrderLine[];
    const items = lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty }));
    const label = itemsLabel(items.reduce((s, i) => s + i.qty, 0));
    return {
      found: true,
      kind: "product",
      reference: order.reference,
      status: order.status,
      totalCents: order.totalCents,
      createdAt: order.createdAt.toISOString(),
      itemsLabel: label,
      summary: `${label}: ${items.map((i) => `${i.qty} × ${i.name}`).join("; ")}`,
      firstName,
      items,
      totals,
    };
  }
  const bk = booking!;
  const sel = (bk.selection ?? {}) as { tierName?: string };
  const serviceName = getServiceDefinition(businessId, bk.serviceCode)?.name ?? "Service visit";
  return {
    found: true,
    kind: "service",
    reference: bk.reference,
    status: bk.status,
    totalCents: bk.totalCents,
    createdAt: bk.createdAt.toISOString(),
    appointment: appointmentLabel(bk.startsAt, b.timezone),
    serviceName,
    summary: `${serviceName}${sel.tierName ? ` — ${sel.tierName}` : ""} · about ${formatDuration(bk.durationMin)}`,
    firstName,
    totals,
  };
}

/** "1 item" / "3 items". */
export function itemsLabel(n: number): string {
  return `${n} item${n === 1 ? "" : "s"}`;
}

function safeDecrypt(v: string): string {
  try {
    return decryptString(v);
  } catch {
    return "";
  }
}
