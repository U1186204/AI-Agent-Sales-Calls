import type { NextConfig } from "next";
import { staticSecurityHeaders } from "./src/guard/security-headers";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Native / server-only packages must not be bundled.
  serverExternalPackages: ["better-sqlite3", "@prisma/adapter-better-sqlite3"],
  // Security headers (SPEC §8). The nonce-based Content-Security-Policy is set per request
  // in src/proxy.ts; everything static is applied here to every route.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: staticSecurityHeaders(process.env.NODE_ENV === "production"),
      },
    ];
  },
};

export default nextConfig;
