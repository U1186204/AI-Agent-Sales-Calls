import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_SECRETS, resetEnvCache } from "@/config/env";
import { hashPassword } from "@/auth/password";
import {
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  clearedOwnerCookies,
  constantTimeEqual,
  activateSession,
  createOwnerSessionCookies,
  endOwnerSession,
  getOwnerSession,
  isDemoOwnerPassword,
  requireOwnerApi,
  signSession,
  verifyOwnerCredentials,
  verifySession,
} from "@/auth/session";
import { csrfTokenForSession, csrfTokenMatches } from "@/auth/session-token";

const SECRET = DEMO_SECRETS.SESSION_SECRET;

afterEach(() => {
  delete process.env.OWNER_USERNAME;
  delete process.env.OWNER_PASSWORD_HASH;
  resetEnvCache();
});

const store = (value?: string) => ({
  get: (name: string) => (name === SESSION_COOKIE && value !== undefined ? { value } : undefined),
});

/** A signed AND active (server-side registered) session token. */
function activeToken(username = "owner", nowSec?: number) {
  const signed = signSession(username, SECRET, nowSec === undefined ? {} : { nowSec });
  activateSession(signed.session.sid, signed.session.exp);
  return signed;
}

/** Sign an arbitrary payload with the demo secret (forgery attempts). */
function forge(payload: Record<string, unknown>): string {
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${p}.${createHmac("sha256", SECRET).update(p).digest("base64url")}`;
}

describe("session token", () => {
  it("signs and verifies {u, sid, iat, exp} with an 8h TTL", () => {
    const now = 1_800_000_000;
    const { token, session } = signSession("owner", SECRET, { nowSec: now });
    expect(session).toMatchObject({ u: "owner", iat: now, exp: now + 8 * 3600 });
    expect(session.sid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(SESSION_TTL_SEC).toBe(28_800);
    expect(verifySession(token, SECRET, now + 10)).toEqual(session);
  });

  it("rejects expired tokens", () => {
    const { token } = signSession("owner", SECRET, { nowSec: 1000, ttlSec: 60 });
    expect(verifySession(token, SECRET, 1059)).not.toBeNull();
    expect(verifySession(token, SECRET, 1060)).toBeNull();
  });

  it("SEC-4: caps exp — a correctly signed far-future or over-long token is rejected", () => {
    const now = Math.floor(Date.now() / 1000);
    const sid = "abcdefghijklmnopqrstuv";
    expect(
      verifySession(forge({ u: "owner", sid, iat: now, exp: 9_999_999_999 }), SECRET),
    ).toBeNull();
    expect(
      verifySession(
        forge({ u: "owner", sid, iat: now - 10, exp: now + SESSION_TTL_SEC + 3600 }),
        SECRET,
      ),
    ).toBeNull();
    expect(
      verifySession(forge({ u: "owner", sid, iat: now + 3600, exp: now + 7200 }), SECRET),
    ).toBeNull();
    // legacy {u, exp} tokens (no sid) are rejected
    expect(verifySession(forge({ u: "owner", exp: now + 60 }), SECRET)).toBeNull();
    expect(
      verifySession(forge({ u: "owner", sid, iat: now, exp: now + 60 }), SECRET),
    ).not.toBeNull();
  });

  it("rejects tampered payloads, signatures, wrong secrets and junk", () => {
    const { token } = signSession("owner", SECRET);
    const [payload, sig] = token.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ u: "owner", exp: 9_999_999_999 })).toString(
      "base64url",
    );
    expect(verifySession(`${forged}.${sig}`, SECRET)).toBeNull();
    const flipped = sig.slice(0, -2) + (sig.endsWith("AA") ? "BB" : "AA");
    expect(verifySession(`${payload}.${flipped}`, SECRET)).toBeNull();
    expect(verifySession(token, "x".repeat(44))).toBeNull();
    for (const junk of ["", "abc", "a.b.c", `${payload}.`, `.${sig}`, "%%%.###"]) {
      expect(verifySession(junk, SECRET)).toBeNull();
    }
  });

  it("getOwnerSession reads the cookie, requires the configured username and an ACTIVE sid", () => {
    const { token } = activeToken();
    expect(getOwnerSession(store(token))?.u).toBe("owner");
    expect(getOwnerSession(store())).toBeNull();
    const other = activeToken("mallory").token;
    expect(getOwnerSession(store(other))).toBeNull();
    // validly signed but never activated (e.g. issued before a restart): rejected
    expect(getOwnerSession(store(signSession("owner", SECRET).token))).toBeNull();
  });

  it("SEC-4: logout revokes the session server-side; a copied cookie stops working", () => {
    const { token } = activeToken();
    expect(getOwnerSession(store(token))).not.toBeNull();
    endOwnerSession(store(token));
    expect(getOwnerSession(store(token))).toBeNull();
  });

  it("requireOwnerApi returns a 401 Response without a session", async () => {
    const res = requireOwnerApi({ cookies: store() });
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
    const { token } = activeToken();
    expect(requireOwnerApi({ cookies: store(token) })).toMatchObject({ u: "owner" });
  });
});

describe("cookies", () => {
  it("session cookie is HttpOnly, SameSite=Strict, Path=/, 8h; csrf cookie readable by JS", () => {
    const { cookies, csrfToken, session: s } = createOwnerSessionCookies("owner");
    const [session, csrf] = cookies;
    expect(session.name).toBe("oasis_owner");
    expect(session.options).toMatchObject({
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAge: 28_800,
    });
    expect(session.options.secure).toBe(false); // NODE_ENV=test
    expect(verifySession(session.value, SECRET)?.u).toBe("owner");
    expect(getOwnerSession(store(session.value))?.u).toBe("owner"); // activated at login
    expect(csrf).toMatchObject({ name: "oasis_csrf", value: csrfToken });
    expect(csrf.options.httpOnly).toBe(false);
    // SEC-8: the CSRF token is bound to the session id
    expect(csrfToken).toBe(csrfTokenForSession(s.sid, SECRET));
    expect(csrfTokenMatches(csrfToken, s.sid, SECRET)).toBe(true);
    expect(csrfTokenMatches(csrfToken, "another-session-id-xyz", SECRET)).toBe(false);
    expect(csrfTokenMatches("A".repeat(43), s.sid, SECRET)).toBe(false);
    expect(clearedOwnerCookies().every((c) => c.options.maxAge === 0 && c.value === "")).toBe(true);
  });
});

describe("credentials", () => {
  it("accepts the demo owner / password and flags demo credentials", async () => {
    expect(await verifyOwnerCredentials("owner", "oasis-demo-2026")).toBe(true);
    expect(isDemoOwnerPassword()).toBe(true);
  });
  it("rejects wrong username or password", async () => {
    expect(await verifyOwnerCredentials("owner", "wrong")).toBe(false);
    expect(await verifyOwnerCredentials("admin", "oasis-demo-2026")).toBe(false);
    expect(await verifyOwnerCredentials("", "")).toBe(false);
  });
  it("uses OWNER_USERNAME / OWNER_PASSWORD_HASH from env (escaped $ accepted)", async () => {
    const hash = await hashPassword("new-pass", { N: 1024 });
    process.env.OWNER_USERNAME = "boss";
    process.env.OWNER_PASSWORD_HASH = hash.replace(/\$/g, "\\$");
    resetEnvCache();
    expect(await verifyOwnerCredentials("boss", "new-pass")).toBe(true);
    expect(await verifyOwnerCredentials("owner", "oasis-demo-2026")).toBe(false);
    expect(isDemoOwnerPassword()).toBe(false);
  });
  it("constantTimeEqual", () => {
    expect(constantTimeEqual("a", "a")).toBe(true);
    expect(constantTimeEqual("a", "ab")).toBe(false);
  });
});
