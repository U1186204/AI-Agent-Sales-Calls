"use client";

import type { CardAction, UiBlock } from "@/contracts";
import { CartSummaryCard, ProductCardsCard } from "./ProductCards";
import { EstimateCard, QuoteCard, ServicePickerCard, SlotSuggestionsCard } from "./ServiceCards";

export type ChatCardBlock = Exclude<UiBlock, { type: "text" } | { type: "form" }>;

export const isCardBlock = (b: UiBlock): b is ChatCardBlock =>
  b.type !== "text" && b.type !== "form";

/** Which guided flow a card belongs to (cards of one flow replace each other step by step). */
export const cardFlow = (b: ChatCardBlock): "product" | "service" =>
  b.type === "product_cards" || b.type === "cart_summary" ? "product" : "service";

/** Render one server-built card (src/contracts/cards.ts). */
export function ChatCard({
  block,
  active,
  autoFocus,
  onAction,
  onTalk,
}: {
  block: ChatCardBlock;
  active: boolean;
  autoFocus?: boolean;
  onAction: (action: CardAction, label: string) => void;
  onTalk: (from: HTMLElement | null) => void;
}) {
  const common = { active, autoFocus, onAction };
  switch (block.type) {
    case "service_picker":
      return <ServicePickerCard block={block} {...common} />;
    case "quote_card":
      return <QuoteCard block={block} {...common} />;
    case "slot_suggestions":
      return <SlotSuggestionsCard block={block} {...common} />;
    case "estimate_card":
      return <EstimateCard block={block} active={active} autoFocus={autoFocus} onTalk={onTalk} />;
    case "product_cards":
      return <ProductCardsCard block={block} {...common} />;
    case "cart_summary":
      return <CartSummaryCard block={block} {...common} />;
  }
}
