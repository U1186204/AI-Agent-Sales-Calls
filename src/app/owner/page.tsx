import type { Metadata } from "next";
import { requireOwner } from "@/auth";
import { OwnerDashboard } from "@/components/owner/OwnerDashboard";
import { BUSINESSES } from "@/config/businesses";

export const metadata: Metadata = {
  title: "Owner dashboard",
  description:
    "Orders, bookings, inventory, availability, notifications and conversations for the Oasis demo businesses.",
  robots: { index: false, follow: false },
};

export default async function OwnerPage() {
  await requireOwner();
  return (
    <OwnerDashboard
      businesses={BUSINESSES.map((b) => ({ id: b.id, name: b.name, kind: b.kind }))}
    />
  );
}
