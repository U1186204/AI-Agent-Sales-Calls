/**
 * Client-side CSRF helpers for owner dashboard requests (no server imports).
 *
 *   await fetch("/api/owner/…", { method: "POST", headers: { ...csrfHeaders(), "content-type": "application/json" }, body })
 *
 * The `oasis_csrf` cookie is set at login (not HttpOnly, SameSite=Strict); the proxy rejects
 * owner API writes whose `x-csrf-token` header does not match it.
 */
export const CSRF_COOKIE = "oasis_csrf";
export const CSRF_HEADER = "x-csrf-token";

/** Read the CSRF token from `document.cookie` (or a supplied cookie string). */
export function readCsrfToken(cookieString?: string): string | null {
  const source = cookieString ?? (typeof document !== "undefined" ? document.cookie : "");
  for (const part of source.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === CSRF_COOKIE) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

/** Headers to spread into an owner `fetch` call. Empty object when no token is present. */
export function csrfHeaders(cookieString?: string): Record<string, string> {
  const token = readCsrfToken(cookieString);
  return token ? { [CSRF_HEADER]: token } : {};
}
