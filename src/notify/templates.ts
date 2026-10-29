/**
 * Notification templates: plain text + simple, accessible HTML (Oasis brand, SPEC §9).
 * Every interpolated value goes through `escapeHtml` in the HTML variant. Pure functions.
 */
import { getBusiness } from "@/config/businesses";
import { redactContactDetails, shortName } from "@/guard/redact";
import type { CheckoutNotificationPayload, EmailMessage, EscalationEmailInput } from "./types";

const INK = "#1d1d1f";
const MUTED = "#6e6e73";
const LINE = "#e8e8ed";
const ACCENT = "#0a7c86";
const FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Strip CR/LF so values cannot inject extra header-like lines into subjects. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

function formatPhone(e164: string): string {
  const d = e164.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164;
}

function durationLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return `${h} hr ${m} min`;
  if (h) return `${h} hr`;
  return `${m} min`;
}

// ---------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------

interface Row {
  label: string;
  value: string;
  strong?: boolean;
}

function htmlLayout(opts: { preheader: string; title: string; bodyHtml: string; footer: string }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f7;color:${INK};font-family:${escapeHtml(FONT)};">
<div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;">
<tr><td style="padding:24px 28px 0 28px;font-size:20px;font-weight:600;letter-spacing:-0.01em;">
<span aria-hidden="true" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${ACCENT};margin-right:6px;"></span>oasis
</td></tr>
<tr><td style="padding:16px 28px 28px 28px;font-size:16px;line-height:1.5;">
<h1 style="font-size:22px;line-height:1.3;margin:0 0 12px 0;font-weight:600;">${escapeHtml(opts.title)}</h1>
${opts.bodyHtml}
</td></tr>
</table>
<p style="max-width:560px;margin:16px auto 0 auto;font-size:12px;line-height:1.5;color:${MUTED};">${escapeHtml(opts.footer)}</p>
</td></tr>
</table>
</body>
</html>`;
}

function p(text: string): string {
  return `<p style="margin:0 0 12px 0;">${escapeHtml(text)}</p>`;
}

function rowsTable(caption: string, rows: Row[]): string {
  const body = rows
    .map(
      (r) =>
        `<tr><th scope="row" style="text-align:left;font-weight:${r.strong ? 600 : 400};padding:6px 0;border-top:1px solid ${LINE};">${escapeHtml(r.label)}</th>` +
        `<td style="text-align:right;font-weight:${r.strong ? 600 : 400};padding:6px 0;border-top:1px solid ${LINE};white-space:nowrap;">${escapeHtml(r.value)}</td></tr>`,
    )
    .join("");
  return `<table role="table" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:8px 0 16px 0;font-size:15px;"><caption style="text-align:left;font-size:13px;color:${MUTED};padding-bottom:4px;">${escapeHtml(caption)}</caption><tbody>${body}</tbody></table>`;
}

function rowsText(rows: Row[]): string {
  return rows.map((r) => `  ${r.label}: ${r.value}`).join("\n");
}

function lineRows(pl: CheckoutNotificationPayload): Row[] {
  return pl.lines.map((l) => ({
    label: l.qty && l.qty > 1 ? `${l.label} × ${l.qty}` : l.label,
    value: formatCents(l.amountCents),
  }));
}

function totalRows(pl: CheckoutNotificationPayload): Row[] {
  const rows: Row[] = [{ label: "Subtotal", value: formatCents(pl.subtotalCents) }];
  if (pl.discountCents && pl.discountCents > 0)
    rows.push({ label: "Discount", value: `-${formatCents(pl.discountCents)}` });
  if (pl.kind === "order") rows.push({ label: "Shipping", value: formatCents(pl.shippingCents) });
  rows.push({ label: "Tax", value: formatCents(pl.taxCents) });
  rows.push({ label: "Total", value: formatCents(pl.totalCents), strong: true });
  return rows;
}

const TAX_NOTE = "Demo tax rule — not tax advice. No payment was collected (demo).";

// ---------------------------------------------------------------------------------------
// Customer confirmations
// ---------------------------------------------------------------------------------------

export function customerConfirmationEmail(
  pl: CheckoutNotificationPayload,
  appUrl: string,
): Omit<EmailMessage, "to"> {
  const isOrder = pl.kind === "order";
  const what = isOrder ? "order" : "booking";
  const subject = oneLine(`Your ${pl.businessName} ${what} is confirmed — ${pl.reference}`);
  const title = isOrder ? "Thanks — your order is confirmed" : "You're booked";
  const statusUrl = `${appUrl.replace(/\/+$/, "")}/status`;
  const details: Row[] = [{ label: "Reference", value: pl.reference, strong: true }];
  if (pl.appointment) {
    details.push({ label: "When", value: pl.appointment.localDateTimeLabel });
    details.push({ label: "Estimated duration", value: durationLabel(pl.appointment.durationMin) });
  }
  if (pl.addressLabel)
    details.push({ label: isOrder ? "Ship to" : "Service address", value: pl.addressLabel });
  if (pl.instructions) details.push({ label: "Your notes", value: pl.instructions });

  const intro = isOrder
    ? `Hi ${pl.customer.firstName}, ${pl.businessName} has received your order.`
    : `Hi ${pl.customer.firstName}, your appointment with ${pl.businessName} is confirmed.`;
  const next = `Check status any time at ${statusUrl} with your reference and this email address.`;

  const text = [
    title,
    "",
    intro,
    "",
    rowsText(details),
    "",
    "Items:",
    rowsText(lineRows(pl)),
    "",
    rowsText(totalRows(pl)),
    "",
    next,
    `Questions? Reply to ${pl.business.supportEmail}.`,
    "",
    TAX_NOTE,
  ].join("\n");

  const html = htmlLayout({
    preheader: `${pl.reference} · ${formatCents(pl.totalCents)}`,
    title,
    footer: `${TAX_NOTE} Sent by Oasis on behalf of ${pl.businessName}.`,
    bodyHtml:
      p(intro) +
      rowsTable("Details", details) +
      rowsTable(isOrder ? "Items" : "Service", lineRows(pl)) +
      rowsTable("Summary", totalRows(pl)) +
      `<p style="margin:0 0 12px 0;">Check status any time at <a href="${escapeHtml(statusUrl)}" style="color:${ACCENT};">${escapeHtml(statusUrl)}</a> with your reference and this email address.</p>` +
      p(`Questions? Contact ${pl.business.supportEmail}.`),
  });

  return { subject, text, html, replyTo: pl.business.supportEmail };
}

// ---------------------------------------------------------------------------------------
// Business notifications
// ---------------------------------------------------------------------------------------

/** Short business name for SMS ("Volt & Wire"), falling back to the full name. */
function smsSender(pl: CheckoutNotificationPayload): string {
  return getBusiness(pl.businessId)?.shortName ?? pl.businessName;
}

export function businessNewCheckoutEmail(
  pl: CheckoutNotificationPayload,
): Omit<EmailMessage, "to"> {
  const isOrder = pl.kind === "order";
  const who = shortName(pl.customer.firstName, pl.customer.lastName);
  // The subject is stored in the Notification log (plaintext), so it carries NO customer name
  // (SEC-12); it names the business so a shared inbox can tell stores apart (WF-5).
  const subject = oneLine(
    `New ${isOrder ? "order" : "booking"} ${pl.reference} for ${pl.businessName} — ${formatCents(pl.totalCents)}`,
  );
  const title = isOrder ? `New order for ${pl.businessName}` : `New booking for ${pl.businessName}`;
  const customer: Row[] = [
    { label: "Name", value: `${pl.customer.firstName} ${pl.customer.lastName}` },
    { label: "Email", value: pl.customer.email },
    { label: "Phone", value: formatPhone(pl.customer.phoneE164) },
  ];
  if (pl.addressLabel)
    customer.push({ label: isOrder ? "Ship to" : "Service address", value: pl.addressLabel });
  if (pl.instructions) customer.push({ label: "Instructions", value: pl.instructions });
  const details: Row[] = [{ label: "Reference", value: pl.reference, strong: true }];
  if (pl.appointment) {
    details.push({ label: "When", value: pl.appointment.localDateTimeLabel });
    details.push({ label: "Duration", value: durationLabel(pl.appointment.durationMin) });
  }

  const text = [
    `${title} (received via Oasis)`,
    "",
    rowsText(details),
    "",
    "Customer:",
    rowsText(customer),
    "",
    isOrder ? "Items:" : "Service:",
    rowsText(lineRows(pl)),
    "",
    rowsText(totalRows(pl)),
    "",
    "Payment: none collected (demo).",
  ].join("\n");

  const html = htmlLayout({
    preheader: `${pl.reference} · ${who} · ${formatCents(pl.totalCents)}`,
    title,
    footer: `Sent by Oasis to ${pl.businessName}. Contains customer contact details — handle per your privacy policy.`,
    bodyHtml:
      rowsTable("Details", details) +
      rowsTable("Customer", customer) +
      rowsTable(isOrder ? "Items" : "Service", lineRows(pl)) +
      rowsTable("Summary", totalRows(pl)) +
      p("Payment: none collected (demo)."),
  });
  return { subject, text, html, replyTo: pl.customer.email };
}

/**
 * Short SMS for the business, prefixed with the business's short name (WF-5): reference, first
 * name + last initial, total. Never the address.
 */
export function businessSms(pl: CheckoutNotificationPayload): string {
  const who = shortName(pl.customer.firstName, pl.customer.lastName);
  const total = formatCents(pl.totalCents);
  const from = smsSender(pl);
  if (pl.kind === "booking") {
    const when = pl.appointment
      ? ` ${pl.appointment.localDateTimeLabel} (${durationLabel(pl.appointment.durationMin)})`
      : "";
    return oneLine(
      `${from}: New booking ${pl.reference} — ${who},${when}, ${total}. Details in email.`,
    );
  }
  const units = pl.lines.reduce((n, l) => n + (l.qty ?? 1), 0);
  return oneLine(
    `${from}: New order ${pl.reference} — ${who}, ${units} item${units === 1 ? "" : "s"}, ${total}. Details in email.`,
  );
}

// ---------------------------------------------------------------------------------------
// Support escalation
// ---------------------------------------------------------------------------------------

const REASON_LABELS: Record<string, string> = {
  requested_human: "Customer asked for a person",
  frustration: "Customer frustrated",
  unresolved: "Unresolved question",
  complaint: "Complaint",
  other: "Other",
};

export function escalationEmail(input: EscalationEmailInput): Omit<EmailMessage, "to"> {
  const reason = REASON_LABELS[input.reason] ?? input.reason;
  // INJ-5: emails/phones in the summary are removed; only the explicit contactEmail is shown.
  const summary = redactContactDetails(input.summary);
  const subject = oneLine(`Escalation ${input.ticketRef}: ${reason} — ${input.businessName}`);
  const title = "Customer needs a hand";
  const contact = input.contactEmail
    ? `Reply to the customer at ${input.contactEmail} (they shared it for follow-up).`
    : `The customer did not leave a contact email. Open ticket ${input.ticketRef} under Escalations in the owner dashboard to read the masked conversation transcript.`;
  const rows: Row[] = [
    { label: "Ticket", value: input.ticketRef, strong: true },
    { label: "Business", value: input.businessName },
    { label: "Reason", value: reason },
  ];
  const text = [
    `${title} — ${input.businessName}`,
    "",
    rowsText(rows),
    "",
    "Conversation summary:",
    summary,
    "",
    contact,
  ].join("\n");
  const html = htmlLayout({
    preheader: `${input.ticketRef} · ${reason}`,
    title,
    footer:
      "Sent by Oasis. Card numbers, SSNs, email addresses and phone numbers are removed from summaries automatically.",
    bodyHtml:
      rowsTable("Ticket", rows) +
      `<h2 style="font-size:16px;margin:0 0 8px 0;">Conversation summary</h2>` +
      `<p style="margin:0 0 12px 0;white-space:pre-wrap;">${escapeHtml(summary)}</p>` +
      p(contact),
  });
  return { subject, text, html, replyTo: input.contactEmail };
}
