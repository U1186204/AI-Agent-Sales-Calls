import { describe, expect, it } from "vitest";
import {
  checkCsrf,
  checkDoubleSubmit,
  checkSameOrigin,
  generateCsrfToken,
  readCookie,
  safeEqual,
} from "@/guard/csrf";
import { csrfHeaders, readCsrfToken } from "@/guard/csrf-client";

const APP = "http://localhost:3000";
const req = (
  method: string,
  headers: Record<string, string>,
  url = "http://localhost:3000/api/chat",
) => ({
  method,
  url,
  headers: new Headers({ host: "localhost:3000", ...headers }),
});

describe("same-origin check", () => {
  it("always allows safe methods", () => {
    expect(checkSameOrigin(req("GET", { origin: "https://evil.example" }), APP).ok).toBe(true);
    expect(checkSameOrigin(req("HEAD", {}), APP).ok).toBe(true);
  });
  it("accepts a matching Origin (APP_URL, loopback aliases, own host outside production)", () => {
    expect(checkSameOrigin(req("POST", { origin: "http://localhost:3000" }), APP).ok).toBe(true);
    expect(checkSameOrigin(req("POST", { origin: "http://127.0.0.1:3000" }), APP).ok).toBe(true);
    // dev: the request's own host
    expect(
      checkSameOrigin(
        req(
          "POST",
          { origin: "http://oasis.test", host: "oasis.test" },
          "http://oasis.test/api/chat",
        ),
        APP,
      ).ok,
    ).toBe(true);
    // behind a trusted proxy: X-Forwarded-Host / -Proto
    expect(
      checkSameOrigin(
        req("POST", {
          origin: "https://oasis.example",
          "x-forwarded-host": "oasis.example",
          "x-forwarded-proto": "https",
        }),
        APP,
        { trustProxy: true, production: true },
      ).ok,
    ).toBe(true);
  });

  it("SEC-7: without TRUST_PROXY, X-Forwarded-Host is ignored; in production Host is too", () => {
    const spoofed = req(
      "POST",
      {
        origin: "https://evil.example",
        host: "evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      },
      "http://evil.example/api/status",
    );
    const prod = "https://shop.example";
    expect(checkSameOrigin(spoofed, prod, { production: true }).ok).toBe(false);
    expect(checkSameOrigin(spoofed, prod, { production: true, trustProxy: false }).ok).toBe(false);
    const fwdOnly = req("POST", {
      origin: "https://evil.example",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
    });
    expect(checkSameOrigin(fwdOnly, APP).ok).toBe(false);
    expect(checkSameOrigin(req("POST", { origin: prod }), prod, { production: true }).ok).toBe(
      true,
    );
  });

  it("SEC-8: the double-submit token must also be bound to the session", () => {
    const t = "abcdefghijklmnopqrstuvwxyz";
    const r = req("POST", { cookie: `oasis_csrf=${t}`, "x-csrf-token": t });
    expect(checkDoubleSubmit(r).ok).toBe(true);
    expect(checkDoubleSubmit(r, () => false)).toEqual({ ok: false, reason: "token_mismatch" });
    expect(checkDoubleSubmit(r, (tok) => tok === t).ok).toBe(true);
  });
  it("rejects a cross-site Origin", () => {
    expect(checkSameOrigin(req("POST", { origin: "https://evil.example" }), APP)).toEqual({
      ok: false,
      reason: "origin_mismatch",
    });
    // scheme or port mismatch is cross-origin too
    expect(checkSameOrigin(req("POST", { origin: "http://localhost:3001" }), APP).ok).toBe(false);
    expect(checkSameOrigin(req("POST", { origin: "null" }), APP)).toEqual({
      ok: false,
      reason: "missing_origin",
    });
  });
  it("falls back to Sec-Fetch-Site", () => {
    expect(checkSameOrigin(req("POST", { "sec-fetch-site": "same-origin" }), APP).ok).toBe(true);
    expect(checkSameOrigin(req("POST", { "sec-fetch-site": "cross-site" }), APP).ok).toBe(false);
    expect(checkSameOrigin(req("POST", { "sec-fetch-site": "same-site" }), APP).ok).toBe(false);
  });
  it("rejects requests with neither header", () => {
    expect(checkSameOrigin(req("DELETE", {}), APP)).toEqual({
      ok: false,
      reason: "missing_origin",
    });
  });
});

describe("double-submit token", () => {
  const token = generateCsrfToken();
  it("generates URL-safe 43-char tokens", () => {
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateCsrfToken()).not.toBe(token);
  });
  it("accepts matching cookie + header", () => {
    expect(
      checkDoubleSubmit(req("POST", { cookie: `a=1; oasis_csrf=${token}`, "x-csrf-token": token }))
        .ok,
    ).toBe(true);
  });
  it("rejects missing or mismatched token", () => {
    expect(checkDoubleSubmit(req("POST", { cookie: `oasis_csrf=${token}` }))).toEqual({
      ok: false,
      reason: "token_missing",
    });
    expect(checkDoubleSubmit(req("POST", { "x-csrf-token": token }))).toEqual({
      ok: false,
      reason: "token_missing",
    });
    expect(
      checkDoubleSubmit(
        req("POST", { cookie: `oasis_csrf=${token}`, "x-csrf-token": generateCsrfToken() }),
      ),
    ).toEqual({ ok: false, reason: "token_mismatch" });
  });
  it("checkCsrf requires the token only on owner routes (login exempt)", () => {
    const same = { origin: "http://localhost:3000" };
    expect(checkCsrf(req("POST", same), "/api/chat", APP).ok).toBe(true);
    expect(checkCsrf(req("POST", same), "/api/owner/login", APP).ok).toBe(true);
    expect(checkCsrf(req("POST", same), "/api/owner/logout", APP)).toEqual({
      ok: false,
      reason: "token_missing",
    });
    expect(
      checkCsrf(
        req("POST", { ...same, cookie: `oasis_csrf=${token}`, "x-csrf-token": token }),
        "/api/owner/logout",
        APP,
      ).ok,
    ).toBe(true);
    // cross-origin fails before the token check
    expect(
      checkCsrf(
        req("POST", {
          origin: "https://evil.example",
          cookie: `oasis_csrf=${token}`,
          "x-csrf-token": token,
        }),
        "/api/owner/x",
        APP,
      ),
    ).toEqual({ ok: false, reason: "origin_mismatch" });
  });
});

describe("helpers", () => {
  it("safeEqual", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
  it("readCookie / client helpers", () => {
    expect(readCookie("a=1; b=x%20y", "b")).toBe("x y");
    expect(readCookie(null, "b")).toBeNull();
    expect(readCsrfToken("oasis_owner=zzz; oasis_csrf=tok123")).toBe("tok123");
    expect(csrfHeaders("oasis_csrf=tok123")).toEqual({ "x-csrf-token": "tok123" });
    expect(csrfHeaders("")).toEqual({});
  });
});
