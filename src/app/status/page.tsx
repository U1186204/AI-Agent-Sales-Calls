import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { StatusLookupForm } from "@/components/status/StatusLookupForm";

export const metadata: Metadata = {
  title: "Track an order or booking",
  description:
    "Look up an Oasis order or booking with your reference number and the email you used at checkout.",
};

export default function StatusPage() {
  return (
    <>
      <SiteHeader current="status" />
      <main id="main" tabIndex={-1} className="page-narrow">
        <h1 className="page-title">Track an order or booking</h1>
        <p className="page-lede">
          Enter the reference from your confirmation and the email you used at checkout.
        </p>
        <StatusLookupForm />
      </main>
      <SiteFooter />
    </>
  );
}
