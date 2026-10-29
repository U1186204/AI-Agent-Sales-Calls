"use client";

import { useId, useState } from "react";
import type { ProductCardItem } from "@/contracts";
import { formatCents } from "@/ui-lib/format";
import { maskZip } from "@/ui-lib/masks";
import { QuoteSummary } from "../../checkout/QuoteSummary";
import { Stepper } from "../../checkout/ServiceSpecFields";
import { IconAlert, IconCart } from "../../icons";
import { CardShell } from "./CardShell";
import type { CardProps } from "./ServiceCards";

type Lines = Record<string, number>;
const toLines = (q: Lines) =>
  Object.entries(q)
    .filter(([, n]) => n > 0)
    .map(([sku, qty]) => ({ sku, qty }));
const itemsLabel = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;

function stockText(i: ProductCardItem): string {
  if (i.stock === "out_of_stock") return "Out of stock";
  if (i.stock === "partial") return `Only ${i.qtyOnHand} in stock`;
  return `${i.qtyOnHand} in stock`;
}

// ---------------------------------------------------------------------------
// Product cards (search results or a stock check)
// ---------------------------------------------------------------------------

export function ProductCardsCard({
  block,
  active,
  autoFocus,
  onAction,
}: CardProps<"product_cards">) {
  const uid = useId().replace(/:/g, "");
  // Start with what the customer asked for (capped at stock), else nothing chosen.
  const [qty, setQty] = useState<Lines>(() =>
    Object.fromEntries(
      block.items
        .filter((i) => i.requested && i.qtyOnHand > 0 && !i.alternative)
        .map((i) => [i.sku, Math.min(i.requested!, i.qtyOnHand)]),
    ),
  );
  const lines = toLines(qty);
  const count = lines.reduce((n, l) => n + l.qty, 0);
  const asked = block.items.filter((i) => !i.alternative);
  const alternatives = block.items.filter((i) => i.alternative);

  const tile = (i: ProductCardItem) => {
    const id = `${uid}-${i.sku}`;
    const soldOut = i.qtyOnHand <= 0;
    return (
      <li className="product-tile" key={i.sku} data-stock={i.stock}>
        <div className="product-tile__text">
          <h3 className="product-tile__name" id={`${id}-name`}>
            {i.name}
          </h3>
          <p className="product-tile__price">
            <strong className="tabular">{formatCents(i.priceCents)}</strong> / {i.unit}
          </p>
          <p className={`product-tile__stock${soldOut || i.stock === "partial" ? " is-low" : ""}`}>
            {stockText(i)}
            {i.requested && i.stock === "partial" ? ` (you asked for ${i.requested})` : ""}
          </p>
          {i.heavy && <p className="product-tile__note">Over 50 lb: extra handling applies</p>}
        </div>
        {!soldOut && (
          <Stepper
            id={id}
            label={i.name}
            value={qty[i.sku] ?? 0}
            max={Math.min(i.qtyOnHand, 999)}
            disabled={!active}
            onChange={(n) => setQty((q) => ({ ...q, [i.sku]: n }))}
          />
        )}
      </li>
    );
  };

  return (
    <CardShell
      label="Products"
      eyebrow="Live stock"
      icon={<IconCart />}
      title={asked.some((i) => i.requested) ? "Stock check" : "Products"}
      subtitle="Choose quantities, then get your order total."
      autoFocus={autoFocus}
      inactive={!active}
    >
      {asked.length > 0 && (
        <ul className="product-tiles" role="list">
          {asked.map(tile)}
        </ul>
      )}
      {alternatives.length > 0 && (
        <div>
          <h3 className="checkout__section-title">In-stock alternatives</h3>
          <ul className="product-tiles" role="list">
            {alternatives.map(tile)}
          </ul>
        </div>
      )}
      <div className="checkout__actions">
        <p className="checkout__fine checkout__fine--grow">
          {count > 0 ? itemsLabel(count) + " selected" : "Nothing selected yet"}
        </p>
        <button
          type="button"
          className="btn"
          disabled={!active || count === 0}
          onClick={() =>
            onAction({ action: "quote_cart", lines }, `Price my order (${itemsLabel(count)})`)
          }
        >
          Get order total
        </button>
      </div>
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// Priced cart
// ---------------------------------------------------------------------------

export function CartSummaryCard({ block, active, autoFocus, onAction }: CardProps<"cart_summary">) {
  const uid = useId().replace(/:/g, "");
  const priced = Object.fromEntries(block.lines.map((l) => [l.sku, l.qty]));
  const [qty, setQty] = useState<Lines>(priced);
  const [zip, setZip] = useState(block.quote.shipZip ?? "");
  const [zipError, setZipError] = useState<string | null>(null);
  const lines = toLines(qty);
  const dirty = JSON.stringify(lines) !== JSON.stringify(toLines(priced));
  const count = lines.reduce((n, l) => n + l.qty, 0);
  const zipValid = /^\d{5}(-\d{4})?$/.test(zip.trim());

  const requote = (withZip: boolean) => {
    if (withZip && !zipValid) {
      setZipError("Enter a 5-digit US ZIP code");
      return;
    }
    setZipError(null);
    onAction(
      {
        action: "quote_cart",
        lines,
        ...(withZip ? { zip: zip.trim() } : {}),
      },
      withZip ? `Estimate shipping to ${zip.trim()}` : `Update my order (${itemsLabel(count)})`,
    );
  };

  return (
    <CardShell
      label="Your order"
      eyebrow="Your order"
      icon={<IconCart />}
      title={itemsLabel(block.lines.reduce((n, l) => n + l.qty, 0))}
      subtitle={
        block.quote.shipZip
          ? `Shipping to ${block.quote.shipZip} included`
          : "Shipping is added at checkout, or estimate it below"
      }
      autoFocus={autoFocus}
      inactive={!active}
    >
      {block.issues.length > 0 && (
        <div className="notice notice--warn">
          <IconAlert />
          <ul className="notice__body">
            {block.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
      )}
      <ul className="product-tiles product-tiles--cart" role="list">
        {block.lines.map((l) => {
          const priced = block.quote.lines.find((x) => x.kind === "goods" && x.code === l.sku);
          return (
            <li className="product-tile" key={l.sku}>
              <div className="product-tile__text">
                <h3 className="product-tile__name">{l.name}</h3>
                {priced && (
                  <p className="product-tile__price">
                    {priced.qty} × {formatCents(priced.unitCents)} ={" "}
                    <strong className="tabular">{formatCents(priced.amountCents)}</strong>
                  </p>
                )}
              </div>
              <Stepper
                id={`${uid}-${l.sku}`}
                label={l.name}
                value={qty[l.sku] ?? 0}
                max={l.maxQty}
                disabled={!active}
                onChange={(n) => setQty((q) => ({ ...q, [l.sku]: n }))}
              />
            </li>
          );
        })}
      </ul>
      <QuoteSummary
        compact
        hideItems
        quote={block.quote}
        showShipping={Boolean(block.quote.shipZip)}
        shippingPending={!block.quote.shipZip}
      />
      {active && !block.quote.shipZip && (
        <div className="cart-zip">
          <div className="field">
            <label className="field__label" htmlFor={`${uid}-zip`}>
              ZIP code <span className="field__optional">(optional, for a shipping estimate)</span>
            </label>
            <input
              id={`${uid}-zip`}
              className="input"
              inputMode="numeric"
              autoComplete="postal-code"
              maxLength={10}
              value={zip}
              aria-invalid={zipError ? true : undefined}
              aria-describedby={zipError ? `${uid}-zip-error` : undefined}
              onChange={(e) => setZip(maskZip(e.target.value, e.target.value.length).value)}
            />
            {zipError && (
              <p className="field__error" id={`${uid}-zip-error`}>
                <IconAlert />
                <span>{zipError}</span>
              </p>
            )}
          </div>
          <button
            type="button"
            className="btn btn--secondary"
            disabled={count === 0}
            onClick={() => requote(true)}
          >
            Estimate shipping
          </button>
        </div>
      )}
      {active && (
        <div className="checkout__actions">
          {dirty ? (
            <button
              type="button"
              className="btn"
              disabled={count === 0}
              onClick={() => requote(false)}
            >
              Update total
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              onClick={() =>
                onAction({ action: "checkout_cart", lines }, `Check out (${itemsLabel(count)})`)
              }
            >
              Check out
            </button>
          )}
        </div>
      )}
    </CardShell>
  );
}
