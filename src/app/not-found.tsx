import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export const metadata: Metadata = {
  title: "Page not found",
  description: "That page doesn't exist on Oasis.",
};

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main id="main" tabIndex={-1} className="not-found">
        <h1 className="page-title">We couldn&rsquo;t find that page.</h1>
        <p className="page-lede">
          The link may be old, or the business you&rsquo;re looking for isn&rsquo;t part of this
          demo.
        </p>
        <Link href="/" className="btn">
          See all businesses
        </Link>
      </main>
      <SiteFooter />
    </>
  );
}
