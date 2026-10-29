import { describe, expect, it } from "vitest";
import { sanitizeUserText, sanitizeUserTextDetailed } from "@/guard/sanitize";
import { acceptRequestId } from "@/guard/request-id";
import { buildCsp, staticSecurityHeaders } from "@/guard/security-headers";

describe("sanitizeUserText", () => {
  it("strips control and invisible characters but keeps newline and tab", () => {
    const input = "a\u0000b\u0007c\td\ne\u200Bf\u202Eg\uFEFF\u0085h";
    expect(sanitizeUserText(input)).toBe("abc\td\nefgh");
  });
  it("R2-9: keeps emoji ZWJ sequences intact, strips every other zero-width joiner", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const techSkin = "\u{1F469}\u{1F3FD}\u200D\u{1F4BB}";
    const heartFire = "\u2764\uFE0F\u200D\u{1F525}"; // VS16 removed, the join kept
    expect(sanitizeUserText(`hi ${family} and ${techSkin}`)).toBe(`hi ${family} and ${techSkin}`);
    expect(sanitizeUserText(heartFire)).toBe("\u2764\u200D\u{1F525}");
    // ZWJ between letters, at the edges, doubled, or after an emoji but before text: removed
    expect(sanitizeUserText("ig\u200Dnore")).toBe("ignore");
    expect(sanitizeUserText("\u200Dx\u200D")).toBe("x");
    expect(sanitizeUserText("\u{1F468}\u200D\u200D\u{1F469}")).toBe("\u{1F468}\u{1F469}");
    expect(sanitizeUserText("\u{1F468}\u200Dabc")).toBe("\u{1F468}abc");
  });
  it("normalizes CRLF, NFKC, collapses blank runs, trims", () => {
    expect(sanitizeUserText("  ｆｕｌｌ\r\n\r\n\r\n\r\nwidth ﬁ  ")).toBe("full\n\nwidth fi");
  });
  it("leaves HTML as text (rendering escapes it)", () => {
    expect(sanitizeUserText("<script>alert(1)</script>")).toBe("<script>alert(1)</script>");
  });
  it("enforces the max length (default OASIS_MAX_INPUT_CHARS=2000)", () => {
    const r = sanitizeUserTextDetailed("x".repeat(2500));
    expect(r.text).toHaveLength(2000);
    expect(r.truncated).toBe(true);
    expect(sanitizeUserTextDetailed("hello", 3)).toEqual({ text: "hel", truncated: true });
    expect(sanitizeUserTextDetailed("hi")).toEqual({ text: "hi", truncated: false });
  });
});

describe("request ids", () => {
  it("keeps safe incoming ids and replaces unsafe ones", () => {
    expect(acceptRequestId("abc-12345678")).toBe("abc-12345678");
    expect(acceptRequestId("bad id\n")).toMatch(/^[0-9a-f-]{36}$/);
    expect(acceptRequestId(null)).toMatch(/^[0-9a-f-]{36}$/);
    expect(acceptRequestId("x".repeat(200))).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("security headers", () => {
  it("default (nonce-less) CSP: self-only scripts, no eval in prod, no framing/objects", () => {
    const csp = buildCsp();
    expect(csp).toContain("script-src 'self' 'unsafe-inline';");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/https?:/); // no third-party origins
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(buildCsp({ dev: true })).toContain("'unsafe-eval'");
    expect(buildCsp({ upgradeInsecure: true })).toContain("upgrade-insecure-requests");
  });
  it("nonce CSP (opt-in) drops unsafe-inline for scripts", () => {
    const csp = buildCsp({ nonce: "abc123" });
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });
  it("static headers include nosniff, referrer, permissions, frame denial; HSTS only in prod", () => {
    const dev = Object.fromEntries(staticSecurityHeaders(false).map((h) => [h.key, h.value]));
    expect(dev["X-Content-Type-Options"]).toBe("nosniff");
    expect(dev["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(dev["Permissions-Policy"]).toContain("camera=(), microphone=(), geolocation=()");
    expect(dev["X-Frame-Options"]).toBe("DENY");
    expect(dev["Strict-Transport-Security"]).toBeUndefined();
    const prod = Object.fromEntries(staticSecurityHeaders(true).map((h) => [h.key, h.value]));
    expect(prod["Strict-Transport-Security"]).toMatch(/max-age=\d+/);
  });
});
