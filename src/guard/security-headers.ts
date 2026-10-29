/**
 * Security headers (SPEC §8, AT-83). No imports: `next.config.ts` loads this file directly.
 *
 * - Static headers (`staticSecurityHeaders`) are applied to every route by next.config.ts.
 * - The page Content-Security-Policy is set by `src/proxy.ts` (`buildCsp`); JSON API
 *   responses get `API_CSP`.
 *
 * Nonce CSP: Next.js App Router emits inline bootstrap/flight scripts. A nonce CSP only
 * works when EVERY page is dynamically rendered (Next stamps the nonce at render time), so
 * the root layout calls `await connection()` and the proxy passes a fresh `nonce` per
 * request: `script-src 'self' 'nonce-…' 'strict-dynamic'` — no 'unsafe-inline' for scripts,
 * no eval in production — plus `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`,
 * `frame-ancestors 'none'`. Calling `buildCsp()` without a nonce yields the nonce-less
 * fallback (`'self' 'unsafe-inline'`), used only if a page must be served statically.
 */

export interface CspOptions {
  /** Per-request nonce. Only use when all pages are dynamically rendered (see above). */
  nonce?: string;
  dev?: boolean;
  /** Add `upgrade-insecure-requests` (production behind HTTPS). */
  upgradeInsecure?: boolean;
}

export function buildCsp({ nonce, dev = false, upgradeInsecure = false }: CspOptions = {}): string {
  const scriptSrc = nonce ? `'self' 'nonce-${nonce}' 'strict-dynamic'` : "'self' 'unsafe-inline'";
  const directives = [
    "default-src 'self'",
    `script-src ${scriptSrc}${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ];
  if (upgradeInsecure) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

/** CSP for JSON API responses: nothing may load or frame them. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

export function staticSecurityHeaders(production: boolean): { key: string; value: string }[] {
  const headers = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "X-DNS-Prefetch-Control", value: "off" },
  ];
  if (production) {
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains",
    });
  }
  return headers;
}

/** Random base64 nonce (128 bits). */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
