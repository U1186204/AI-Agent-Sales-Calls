import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getBusiness } from "@/config/businesses";
import { env } from "@/config/env";
import { ChatApp } from "@/components/chat/ChatApp";
import { STARTERS } from "@/ui-lib/starters";

type Params = { params: Promise<{ business: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { business } = await params;
  const b = getBusiness(business);
  if (!b) return { title: "Business not found" };
  return {
    title: `Chat with ${b.name}`,
    description: `Ask ${b.name}'s AI assistant about ${
      b.kind === "product"
        ? "stock, prices and shipping, and place an order"
        : "prices and open appointments, and book a visit"
    }. ${b.tagline}`,
  };
}

export default async function ChatPage({ params }: Params) {
  const { business } = await params;
  const b = getBusiness(business);
  if (!b) notFound();

  let maxChars = 2000;
  try {
    maxChars = env.OASIS_MAX_INPUT_CHARS;
  } catch {
    // Invalid env falls back to the documented default; the server still enforces its limit.
  }

  return (
    <ChatApp
      business={{
        id: b.id,
        name: b.name,
        shortName: b.shortName,
        kind: b.kind,
        tagline: b.tagline,
        supportEmail: b.supportEmail,
      }}
      starters={STARTERS[b.id] ?? []}
      maxChars={maxChars}
    />
  );
}
