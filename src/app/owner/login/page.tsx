import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { OwnerLoginForm } from "@/components/owner/OwnerLoginForm";

export const metadata: Metadata = {
  title: "Owner sign in",
  description:
    "Sign in to the Oasis owner dashboard to see orders, bookings, inventory and conversations.",
  robots: { index: false, follow: false },
};

export default function OwnerLoginPage() {
  return (
    <>
      <SiteHeader current="owner" />
      <main id="main" tabIndex={-1} className="page-narrow page-narrow--login">
        <h1 className="page-title">Owner sign in</h1>
        <p className="page-lede">
          See orders, bookings, stock and every conversation across the five businesses.
        </p>
        <OwnerLoginForm />
      </main>
      <SiteFooter />
    </>
  );
}
