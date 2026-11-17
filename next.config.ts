import { networkInterfaces } from "node:os";
import type { NextConfig } from "next";
import { staticSecurityHeaders } from "./src/guard/security-headers";

/**
 * This machine's own LAN IPv4 addresses (e.g. 10.x / 192.168.x), read at dev-server start.
 * Lets `npm run dev` be opened via the printed "Network:" URL (phone/second laptop demos);
 * otherwise Next.js 16 refuses its dev JS to non-localhost hosts and the page never becomes
 * interactive (chat can't send). Dev-only: `allowedDevOrigins` has no effect in production.
 */
function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i !== undefined && i.family === "IPv4" && !i.internal)
    .map((i) => i!.address);
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: lanAddresses(),
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
