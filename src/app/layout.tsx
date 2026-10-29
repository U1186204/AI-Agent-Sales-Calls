import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Oasis — AI sales and service agents for contractors",
    template: "%s · Oasis",
  },
  description:
    "Oasis answers customers, quotes from live prices, checks stock and schedules, and books jobs for five demo contractor businesses.",
  applicationName: "Oasis",
  icons: { icon: [{ url: "/favicon.svg", type: "image/svg+xml" }] },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The proxy sets a per-request nonce CSP; Next.js can only stamp the nonce on its scripts
  // when pages render per request, so every page opts into dynamic rendering here.
  await connection();
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
