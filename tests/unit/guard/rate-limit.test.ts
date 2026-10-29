import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/config/env";
import {
  CountLimiter,
  TokenBucketLimiter,
  checkApiRateLimit,
  checkChatRateLimit,
  checkLoginRateLimit,
  checkStatusRateLimit,
  LoginGuard,
  SHARED_CLIENT_KEY,
  SHARED_LIMIT_FACTOR,
  clientIp,
  resetLoginRateLimit,
  resetRateLimits,
} from "@/guard/rate-limit";
import { PEER_HEADER, peerHeaderValue, readPeerAddress, stampRequest } from "@/guard/peer-address";

afterEach(() => {
  delete process.env.RATE_LIMIT_IP_PER_10MIN;
  delete process.env.RATE_LIMIT_API_PER_MIN;
  delete process.env.OASIS_MAX_TURNS;
  resetEnvCache();
  resetRateLimits();
});

describe("TokenBucketLimiter", () => {
  it("allows `limit` requests per window then 429s with retryAfter", () => {
    let t = 0;
    const l = new TokenBucketLimiter({ limit: 3, windowMs: 60_000, now: () => t });
    expect([1, 2, 3].map(() => l.consume("a").ok)).toEqual([true, true, true]);
    const denied = l.consume("a");
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterSec).toBe(20); // one token per 20 s
    // other keys are independent
    expect(l.consume("b").ok).toBe(true);
    // after 20 s exactly one more request is allowed
    t = 20_000;
    expect(l.consume("a").ok).toBe(true);
    expect(l.consume("a").ok).toBe(false);
    // after a full window the bucket is full again
    t = 20_000 + 60_000;
    expect([1, 2, 3].map(() => l.consume("a").ok)).toEqual([true, true, true]);
    expect(l.consume("a").ok).toBe(false);
  });

  it("bounds memory by evicting least-recently-used keys", () => {
    const l = new TokenBucketLimiter({ limit: 1, windowMs: 60_000, maxKeys: 3, now: () => 0 });
    for (const k of ["a", "b", "c", "d"]) l.consume(k);
    expect(l.size).toBe(3);
    // "a" was evicted → treated as new (allowed again)
    expect(l.consume("a").ok).toBe(true);
  });

  it("sweeps fully-refilled buckets", () => {
    let t = 0;
    const l = new TokenBucketLimiter({ limit: 2, windowMs: 1_000, now: () => t });
    l.consume("a");
    l.consume("b");
    t = 120_000;
    l.consume("c");
    expect(l.size).toBe(1);
  });
});

describe("CountLimiter", () => {
  it("hard-caps per key", () => {
    const c = new CountLimiter(2);
    expect([c.consume("x").ok, c.consume("x").ok, c.consume("x").ok]).toEqual([true, true, false]);
  });
});

describe("app limiters (env-driven)", () => {
  it("chat: per-IP limit from RATE_LIMIT_IP_PER_10MIN", () => {
    process.env.RATE_LIMIT_IP_PER_10MIN = "2";
    resetEnvCache();
    resetRateLimits();
    expect(checkChatRateLimit({ ip: "1.1.1.1" }).ok).toBe(true);
    expect(checkChatRateLimit({ ip: "1.1.1.1" }).ok).toBe(true);
    const r = checkChatRateLimit({ ip: "1.1.1.1" });
    expect(r).toMatchObject({ ok: false, scope: "ip" });
    expect(r.retryAfterSec).toBeGreaterThan(0);
  });

  it("chat: per-conversation turn cap from OASIS_MAX_TURNS", () => {
    process.env.OASIS_MAX_TURNS = "2";
    resetEnvCache();
    resetRateLimits();
    expect(checkChatRateLimit({ ip: "a", conversationId: "c1" }).ok).toBe(true);
    expect(checkChatRateLimit({ ip: "b", conversationId: "c1" }).ok).toBe(true);
    expect(checkChatRateLimit({ ip: "c", conversationId: "c1" })).toMatchObject({
      ok: false,
      scope: "conversation",
    });
    expect(checkChatRateLimit({ ip: "c", conversationId: "c2" }).ok).toBe(true);
  });

  it("api: RATE_LIMIT_API_PER_MIN", () => {
    process.env.RATE_LIMIT_API_PER_MIN = "3";
    resetEnvCache();
    resetRateLimits();
    const results = Array.from({ length: 4 }, () => checkApiRateLimit("9.9.9.9").ok);
    expect(results).toEqual([true, true, true, false]);
  });

  it("login throttle: 5 per 15 min per IP, reset on success", () => {
    const ok = Array.from({ length: 6 }, () => checkLoginRateLimit("5.5.5.5").ok);
    expect(ok).toEqual([true, true, true, true, true, false]);
    resetLoginRateLimit("5.5.5.5");
    expect(checkLoginRateLimit("5.5.5.5").ok).toBe(true);
  });
});

describe("clientIp (SEC-2)", () => {
  const req = (h: Record<string, string>) => ({ headers: new Headers(h) });
  it("TRUST_PROXY=true: right-most X-Forwarded-For entry, then X-Real-IP", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.9, 10.0.0.2" }), true)).toBe("10.0.0.2");
    expect(clientIp(req({ "x-real-ip": "198.51.100.7" }), true)).toBe("198.51.100.7");
    expect(clientIp(req({ "x-forwarded-for": "::ffff:127.0.0.1" }), true)).toBe("127.0.0.1");
    expect(clientIp(req({ "x-forwarded-for": "<script>" }), true)).toBe(SHARED_CLIENT_KEY);
  });
  it("TRUST_PROXY=false: client-supplied forwarding headers are ignored", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.9" }), false)).toBe(SHARED_CLIENT_KEY);
    expect(clientIp(req({ "x-real-ip": "198.51.100.7" }), false)).toBe(SHARED_CLIENT_KEY);
  });
  it("TRUST_PROXY=false: uses the trusted socket stamp, which a client cannot forge", () => {
    expect(clientIp(req({ [PEER_HEADER]: peerHeaderValue("::ffff:198.51.100.4") }), false)).toBe(
      "198.51.100.4",
    );
    expect(clientIp(req({ [PEER_HEADER]: "deadbeef:6.6.6.6" }), false)).toBe(SHARED_CLIENT_KEY);
    // the stamp replaces any client-sent value on the Node request
    const incoming = {
      headers: { [PEER_HEADER]: "forged:1.2.3.4" } as Record<string, string | undefined>,
      socket: { remoteAddress: "192.0.2.77" },
    };
    stampRequest(incoming);
    expect(readPeerAddress(new Headers(incoming.headers as Record<string, string>))).toBe(
      "192.0.2.77",
    );
  });
  it("the shared fallback bucket is SHARED_LIMIT_FACTOR× a per-IP bucket", () => {
    process.env.RATE_LIMIT_API_PER_MIN = "2";
    resetEnvCache();
    resetRateLimits();
    const shared = Array.from({ length: 2 * SHARED_LIMIT_FACTOR + 1 }, () =>
      checkApiRateLimit(SHARED_CLIENT_KEY),
    );
    expect(shared.filter((r) => r.ok)).toHaveLength(2 * SHARED_LIMIT_FACTOR);
    expect(shared.at(-1)?.ok).toBe(false);
  });
});

describe("LoginGuard (SEC-2, R2-3)", () => {
  const make = () => {
    let t = 1_000_000;
    const guard = new LoginGuard({ now: () => t, globalFailures: 10 });
    return { guard, advance: (ms: number) => (t += ms) };
  };

  it("per-username exponential backoff, capped, not extended by refused attempts", () => {
    const { guard, advance } = make();
    for (let i = 0; i < 4; i++) guard.recordFailure("Owner");
    expect(guard.check("owner").ok).toBe(true);
    guard.recordFailure("owner"); // 5th → 30 s lock
    const r = guard.check("owner");
    expect(r.ok).toBe(false);
    expect(r.retryAfterSec).toBe(30);
    advance(31_000);
    expect(guard.check("owner").ok).toBe(true);
    guard.recordFailure("owner"); // 6th → 60 s
    expect(guard.check("owner").retryAfterSec).toBe(60);
    for (let i = 0; i < 20; i++) guard.recordFailure("owner");
    expect(guard.check("owner").retryAfterSec).toBeLessThanOrEqual(15 * 60);
    // other usernames are unaffected by this lock
    expect(guard.check("someone-else").ok).toBe(false); // global cap (10) reached
  });

  it("global failure cap and username lock; only a known DEVICE bypasses them, never an IP", () => {
    const { guard } = make();
    guard.recordSuccess("owner");
    for (let i = 0; i < 10; i++) guard.recordFailure(`user${i}`);
    for (let i = 0; i < 5; i++) guard.recordFailure("owner");
    expect(guard.check("new-user").ok).toBe(false);
    expect(guard.check("owner").ok).toBe(false); // a past success does not trust anyone
    expect(guard.check("owner", true).ok).toBe(true); // verified known-device cookie
  });

  it("success clears the username backoff", () => {
    const { guard } = make();
    for (let i = 0; i < 5; i++) guard.recordFailure("owner");
    expect(guard.check("owner").ok).toBe(false);
    guard.recordSuccess("owner");
    expect(guard.check("owner").ok).toBe(true);
  });
});

describe("status limiter (SEC-10)", () => {
  it("counts per conversation as well as per IP", () => {
    process.env.RATE_LIMIT_STATUS_PER_10MIN = "2";
    resetEnvCache();
    resetRateLimits();
    expect(checkStatusRateLimit("1.1.1.1", "conv-a").ok).toBe(true);
    expect(checkStatusRateLimit("2.2.2.2", "conv-a").ok).toBe(true);
    // a third address does not reset the conversation budget
    expect(checkStatusRateLimit("3.3.3.3", "conv-a").ok).toBe(false);
    expect(checkStatusRateLimit("3.3.3.3", "conv-b").ok).toBe(true);
    delete process.env.RATE_LIMIT_STATUS_PER_10MIN;
  });
});
