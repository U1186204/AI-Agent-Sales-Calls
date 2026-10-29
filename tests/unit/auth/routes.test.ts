import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/owner/login/route";
import { POST as logout } from "@/app/api/owner/logout/route";
import { setLogSink } from "@/guard/logger";
import { resetRateLimits } from "@/guard/rate-limit";
import { proxy } from "@/proxy";
import { DEMO_SECRETS, resetEnvCache } from "@/config/env";
import { csrfTokenForSession, signSession } from "@/auth/session-token";
import { activateSession, resetSessionStore } from "@/auth/session-store";
import { PEER_HEADER, peerHeaderValue } from "@/guard/peer-address";

const BASE = "http://localhost:3000";
let logs: string[] = [];

beforeEach(() => {
  logs = [];
  setLogSink((l) => logs.push(l));
  resetRateLimits();
  resetSessionStore();
});
afterEach(() => setLogSink());

/** A signed + server-side active owner session and its bound CSRF token. */
function activeSession() {
  const { token, session } = signSession("owner", DEMO_SECRETS.SESSION_SECRET);
  activateSession(session.sid, session.exp);
  return { token, csrf: csrfTokenForSession(session.sid, DEMO_SECRETS.SESSION_SECRET) };
}

/**
 * `ip` arrives as the trusted socket stamp (what the server sets from the real TCP peer);
 * `xff` is a client-supplied X-Forwarded-For, which is ignored with TRUST_PROXY=false.
 */
function loginReq(body: unknown, ip: string | null = "203.0.113.5", xff?: string, cookie?: string) {
  return new NextRequest(`${BASE}/api/owner/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: BASE,
      host: "localhost:3000",
      ...(ip ? { [PEER_HEADER]: peerHeaderValue(ip) } : {}),
      ...(xff ? { "x-forwarded-for": xff } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const GOOD = { username: "owner", password: "oasis-demo-2026" };

describe("POST /api/owner/login", () => {
  it("good credentials → 200 + session and csrf cookies", async () => {
    const res = await login(loginReq(GOOD));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const setCookie = res.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/oasis_owner=[^;]+;.*HttpOnly/i);
    expect(setCookie).toMatch(/oasis_owner=[^;]+;.*SameSite=strict/i);
    expect(setCookie).toContain(`oasis_csrf=${body.csrfToken}`);
  });

  it("bad credentials → 401 generic message, no cookies, no PII in logs", async () => {
    const res = await login(loginReq({ username: "owner", password: "nope" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "invalid_credentials",
      message: "Invalid username or password.",
    });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(logs.join("\n")).not.toContain("nope");
  });

  it("malformed body → 400", async () => {
    expect((await login(loginReq("{not json"))).status).toBe(400);
    expect((await login(loginReq({ username: "" }))).status).toBe(400);
  });

  it("throttles after 5 attempts per IP; the account then backs off for every address", async () => {
    for (let i = 0; i < 5; i++) {
      expect(
        (await login(loginReq({ username: "owner", password: `bad${i}` }, "198.51.100.1"))).status,
      ).toBe(401);
    }
    const blocked = await login(loginReq(GOOD, "198.51.100.1"));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    // SEC-2: the username is now in backoff, so a NEW address is refused too
    expect((await login(loginReq(GOOD, "198.51.100.2"))).status).toBe(429);
  });

  it("SEC-2: rotating X-Forwarded-For does not bypass throttling (TRUST_PROXY=false)", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await login(
        loginReq({ username: "owner", password: `bad${i}` }, null, `172.16.0.${i}`),
      );
      codes.push(res.status);
    }
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.slice(5)).toEqual([429, 429, 429]);
    expect(logs.join("\n")).toContain('"scope":"account"');
  });

  /** The `oasis_device=…` pair from a login response. */
  const deviceCookie = (res: Response) => {
    const line = res.headers.getSetCookie().find((c) => c.startsWith("oasis_device="));
    return line?.split(";")[0];
  };
  const lockAccount = async () => {
    for (let i = 0; i < 6; i++) {
      await login(loginReq({ username: "owner", password: `bad${i}` }, `198.51.100.${i + 20}`));
    }
  };

  it("R2-3: sets a signed 30-day known-device cookie (HttpOnly, SameSite=Strict, login path)", async () => {
    const res = await login(loginReq(GOOD));
    const line = res.headers.getSetCookie().find((c) => c.startsWith("oasis_device="));
    expect(line).toBeTruthy();
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/SameSite=strict/i);
    expect(line).toMatch(/Path=\/api\/owner\/login/i);
    expect(line).toMatch(/Max-Age=2592000/i);
    expect(line).not.toMatch(/Secure/i); // dev / localhost: Secure only in production
  });

  it("SEC-2 / R2-3: the owner's known DEVICE is not locked out; sharing its IP grants nothing", async () => {
    const first = await login(loginReq(GOOD, "192.0.2.10"));
    expect(first.status).toBe(200);
    const device = deviceCookie(first)!;
    await lockAccount();
    // attacker addresses are locked out of the account
    expect((await login(loginReq(GOOD, "198.51.100.99"))).status).toBe(429);
    // the same IP as the owner (NAT, VPN, forged XFF) WITHOUT the cookie: still locked
    expect((await login(loginReq(GOOD, "192.0.2.10"))).status).toBe(429);
    // the owner's browser (cookie) signs in, from any address
    expect((await login(loginReq(GOOD, "192.0.2.77", undefined, device))).status).toBe(200);
  });

  it("R2-3: the device cookie survives a restart (stateless) but not a SESSION_SECRET rotation", async () => {
    const device = deviceCookie(await login(loginReq(GOOD, "192.0.2.11")))!;
    resetRateLimits(); // a restart: all in-memory guard state is gone
    resetSessionStore();
    await lockAccount();
    expect((await login(loginReq(GOOD, "192.0.2.11", undefined, device))).status).toBe(200);

    const saved = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "a-brand-new-rotated-session-secret-0123456789";
    resetEnvCache();
    try {
      resetRateLimits();
      await lockAccount();
      expect((await login(loginReq(GOOD, "192.0.2.11", undefined, device))).status).toBe(429);
    } finally {
      if (saved === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = saved;
      resetEnvCache();
    }
  });

  it("R2-3: a forged or tampered device cookie is ignored", async () => {
    const device = deviceCookie(await login(loginReq(GOOD, "192.0.2.12")))!;
    await lockAccount();
    const [name, value] = device.split("=") as [string, string];
    const [payload, sig] = value.split(".") as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ u: "owner", iat: Math.floor(Date.now() / 1000), id: "A".repeat(22) }),
    ).toString("base64url");
    for (const bad of [`${forged}.${sig}`, `${payload}.${sig.slice(0, -2)}AA`, "garbage"]) {
      expect((await login(loginReq(GOOD, "192.0.2.12", undefined, `${name}=${bad}`))).status).toBe(
        429,
      );
    }
  });

  it("SEC-5: oversized body → 413", async () => {
    const res = await login(loginReq({ username: "owner", password: "x".repeat(10_000) }));
    expect(res.status).toBe(413);
  });
});

describe("POST /api/owner/logout", () => {
  it("clears cookies and revokes the session server-side (SEC-4)", async () => {
    const { token } = activeSession();
    const page = () =>
      proxy(
        new NextRequest(`${BASE}/owner`, {
          headers: { host: "localhost:3000", cookie: `oasis_owner=${token}` },
        }),
      ).status;
    expect(page()).toBe(200);
    const res = await logout(
      new NextRequest(`${BASE}/api/owner/logout`, {
        method: "POST",
        headers: { cookie: `oasis_owner=${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const set = res.headers.getSetCookie().join("\n");
    expect(set).toMatch(/oasis_owner=;/);
    expect(set).toMatch(/oasis_csrf=;/);
    // the saved cookie no longer works
    expect(page()).toBe(307);
  });
});

describe("proxy", () => {
  const r = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
    new NextRequest(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers: { host: "localhost:3000", ...init.headers },
    });

  it("assigns x-request-id (keeps a safe incoming one) and sets the page CSP", () => {
    const res = proxy(r("/"));
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    const api = proxy(r("/api/health"));
    expect(api.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(api.headers.get("x-request-id")).toBeTruthy();
    expect(
      proxy(r("/", { headers: { "x-request-id": "trace-abc-123" } })).headers.get("x-request-id"),
    ).toBe("trace-abc-123");
  });

  it("rejects cross-origin API writes with 403", async () => {
    const res = proxy(
      r("/api/owner/login", { method: "POST", headers: { origin: "https://evil.example" } }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect((await res.json()).error).toBe("forbidden");
  });

  it("requires the session-bound CSRF token for owner writes (SEC-8)", () => {
    const res = proxy(r("/api/owner/logout", { method: "POST", headers: { origin: BASE } }));
    expect(res.status).toBe(403);
    const { token, csrf } = activeSession();
    // a planted token that matches its own cookie but not the session: rejected
    const planted = proxy(
      r("/api/owner/logout", {
        method: "POST",
        headers: {
          origin: BASE,
          cookie: `oasis_owner=${token}; oasis_csrf=abcdefghijklmnopqrstuvwxyz`,
          "x-csrf-token": "abcdefghijklmnopqrstuvwxyz",
        },
      }),
    );
    expect(planted.status).toBe(403);
    const ok = proxy(
      r("/api/owner/logout", {
        method: "POST",
        headers: {
          origin: BASE,
          cookie: `oasis_owner=${token}; oasis_csrf=${csrf}`,
          "x-csrf-token": csrf,
        },
      }),
    );
    expect(ok.status).toBe(200);
  });

  it("SEC-5: rejects a declared body over 64 KB with 413", () => {
    const res = proxy(
      r("/api/chat", {
        method: "POST",
        headers: { origin: BASE, "content-length": String(65 * 1024) },
      }),
    );
    expect(res.status).toBe(413);
  });

  it("lets same-origin API writes and API GETs through", () => {
    expect(proxy(r("/api/chat", { method: "POST", headers: { origin: BASE } })).status).toBe(200);
    expect(proxy(r("/api/health")).status).toBe(200);
  });

  it("redirects /owner pages to /owner/login without a valid session", () => {
    const res = proxy(r("/owner/orders"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${BASE}/owner/login?next=%2Fowner%2Forders`);
    expect(proxy(r("/owner")).headers.get("location")).toBe(`${BASE}/owner/login`);
    expect(proxy(r("/owner", { headers: { cookie: "oasis_owner=forged.token" } })).status).toBe(
      307,
    );
    // the login page itself is reachable
    expect(proxy(r("/owner/login")).status).toBe(200);
    // signed but not active (never logged in / logged out) is refused
    const stale = signSession("owner", DEMO_SECRETS.SESSION_SECRET).token;
    expect(proxy(r("/owner", { headers: { cookie: `oasis_owner=${stale}` } })).status).toBe(307);
    // valid session passes
    const { token } = activeSession();
    expect(proxy(r("/owner", { headers: { cookie: `oasis_owner=${token}` } })).status).toBe(200);
  });
});
