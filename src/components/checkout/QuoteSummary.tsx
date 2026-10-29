import type { Quote } from "@/contracts";
import { formatCents } from "@/ui-lib/format";

const ITEM_KINDS = new Set(["goods", "service", "extra_unit", "addon", "surcharge", "discount"]);
/** Compact mode keeps short line notes ("Labor", "Included in this tier") and drops long "why" text. */
const SHORT_NOTE = 60;
/** Quote notes a compact card already shows elsewhere (duration in its subtitle). */
const REDUNDANT_NOTE = /^(Labor \$|Estimated time on site)/;

export function QuoteSummary({
  quote,
  showShipping,
  shippingPending,
  compact,
  hideItems,
}: {
  quote: Quote;
  showShipping: boolean;
  /** Products before a ZIP is known: shipping is computed at review. */
  shippingPending?: boolean;
  /** Chat cards: short line notes only (the "why" lives in the options' disclosures). */
  compact?: boolean;
  /** The card lists the items itself (e.g. with quantity steppers). */
  hideItems?: boolean;
}) {
  const items = hideItems ? [] : quote.lines.filter((l) => ITEM_KINDS.has(l.kind));
  const notes = compact ? quote.notes.filter((n) => !REDUNDANT_NOTE.test(n)) : quote.notes;
  const taxPct = String(Number((quote.taxRateBps / 100).toFixed(2)));
  return (
    <div>
      <dl className="quote">
        {items.map((l, i) => (
          <div className="quote__row" key={`${l.code}-${i}`}>
            <dt>
              {l.label}
              {l.qty > 1 && (
                <span className="quote__sub">
                  {l.qty} × {formatCents(l.unitCents)}
                </span>
              )}
              {l.note && (!compact || l.note.length <= SHORT_NOTE) && (
                <span className="quote__sub">{l.note}</span>
              )}
            </dt>
            <dd>{formatCents(l.amountCents)}</dd>
          </div>
        ))}
        <div className="quote__row quote__row--muted">
          <dt>Subtotal</dt>
          <dd>{formatCents(quote.subtotalCents)}</dd>
        </div>
        {quote.discountCents > 0 && (
          <div className="quote__row quote__row--muted">
            <dt>Discount</dt>
            <dd>−{formatCents(quote.discountCents)}</dd>
          </div>
        )}
        {showShipping && (
          <div className="quote__row quote__row--muted">
            <dt>
              Shipping
              {quote.shipZone !== undefined && (
                <span className="quote__sub">
                  Ground, zone {quote.shipZone}
                  {quote.shipZip ? ` to ${quote.shipZip}` : ""}
                </span>
              )}
            </dt>
            <dd>
              {shippingPending
                ? "At next step"
                : quote.shippingCents === 0
                  ? "Free"
                  : formatCents(quote.shippingCents)}
            </dd>
          </div>
        )}
        <div className="quote__row quote__row--muted">
          <dt>Tax ({taxPct}%)</dt>
          <dd>{formatCents(quote.taxCents)}</dd>
        </div>
        <div className="quote__row quote__row--total">
          <dt>{shippingPending ? "Estimated total" : "Total"}</dt>
          <dd>{formatCents(quote.totalCents)}</dd>
        </div>
      </dl>
      {notes.length > 0 && (
        <ul className="quote__note">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <p className="quote__note">{quote.taxDisclaimer}</p>
    </div>
  );
}
