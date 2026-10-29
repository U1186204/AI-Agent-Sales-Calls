/**
 * In-memory rate limiting (SPEC §8, AT-80). Single-instance demo: counters live in this
 * process (documented); a multi-instance deploy would swap the store for Redis.
 *
 * Algorithm: token bucket per key. Capacity = `limit`, refilled continuously at
 * `limit / windowMs`, so a client can burst `limit` requests and then gets one more every
 * `windowMs / limit`. O(1) memory per key; the key map is bounded (`maxKeys`, oldest-touched
 * evicted first) and idle full buckets are swept.
 *
 * Stores hang off `globalThis` so the proxy bundle and route-handler bundles in the same
 * Node process share one set of counters.
 */
import { getEnv } from "@/config/env";
import { RATE_LIMIT_API_WINDOW_MS, RATE_LIMIT_CHAT_WINDOW_MS } from "@/config/constants";
import { readPeerAddress } from "./peer-address";

export interface RateLimitResult {
  ok: boolean;
  /** Whole seconds until the next request would be allowed (0 when ok). */
  retryAfterSec: number;
  /** Tokens left after this request. */
  remaining: number;
  limit: number;
}

export interface LimiterOptions {
  limit: number;
  windowMs: number;
  /** Max distinct keys tracked (LRU eviction). Default 10 000. */
  maxKeys?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketLimiter {
  readonly limit: number;
  readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(opts: LimiterOptions) {
    if (!(opts.limit >= 1) || !(opts.windowMs > 0)) throw new Error("Invalid limiter options");
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.maxKeys = opts.maxKeys ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  private get ratePerMs(): number {
    return this.limit / this.windowMs;
  }

  private refill(b: Bucket, t: number): void {
    const elapsed = Math.max(0, t - b.updatedAt);
    b.tokens = Math.min(this.limit, b.tokens + elapsed * this.ratePerMs);
    b.updatedAt = t;
  }

  /** Consume `cost` tokens for `key` if available. */
  consume(key: string, cost = 1): RateLimitResult {
    const t = this.now();
    this.maybeSweep(t);
    let b = this.buckets.get(key);
    if (b) {
      this.buckets.delete(key); // re-insert below → Map order = least recently used first
      this.refill(b, t);
    } else {
      b = { tokens: this.limit, updatedAt: t };
    }
    this.buckets.set(key, b);
    this.evictOverflow();

    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { ok: true, retryAfterSec: 0, remaining: Math.floor(b.tokens), limit: this.limit };
    }
    const waitMs = (cost - b.tokens) / this.ratePerMs;
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)),
      remaining: 0,
      limit: this.limit,
    };
  }

  /** Inspect without consuming. */
  peek(key: string): RateLimitResult {
    const b = this.buckets.get(key);
    if (!b) return { ok: true, retryAfterSec: 0, remaining: this.limit, limit: this.limit };
    const copy = { ...b };
    this.refill(copy, this.now());
    const ok = copy.tokens >= 1;
    return {
      ok,
      retryAfterSec: ok ? 0 : Math.max(1, Math.ceil((1 - copy.tokens) / this.ratePerMs / 1000)),
      remaining: Math.floor(copy.tokens),
      limit: this.limit,
    };
  }

  reset(key?: string): void {
    if (key === undefined) this.buckets.clear();
    else this.buckets.delete(key);
  }

  get size(): number {
    return this.buckets.size;
  }

  private evictOverflow(): void {
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }

  /** Drop buckets that have fully refilled (they carry no state). At most once a minute. */
  private maybeSweep(t: number): void {
    if (t - this.lastSweep < 60_000) return;
    this.lastSweep = t;
    for (const [k, b] of this.buckets) {
      if (b.tokens + (t - b.updatedAt) * this.ratePerMs >= this.limit) this.buckets.delete(k);
    }
  }
}

/** Hard cap per key that never refills (e.g. max user turns per conversation). */
export class CountLimiter {
  private readonly counts = new Map<string, number>();
  constructor(
    readonly limit: number,
    private readonly maxKeys = 10_000,
  ) {}

  consume(key: string): RateLimitResult {
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.delete(key);
    this.counts.set(key, n);
    while (this.counts.size > this.maxKeys) {
      const oldest = this.counts.keys().next().value;
      if (oldest === undefined) break;
      this.counts.delete(oldest);
    }
    const ok = n <= this.limit;
    return { ok, retryAfterSec: 0, remaining: Math.max(0, this.limit - n), limit: this.limit };
  }

  reset(key?: string): void {
    if (key === undefined) this.counts.clear();
    else this.counts.delete(key);
  }
}

// ---------------------------------------------------------------------------------------
// App limiters (shared via globalThis)
// ---------------------------------------------------------------------------------------

/**
 * Per-IP limiter with a separate, larger bucket for the shared fallback key: when the client
 * address is unknown (TRUST_PROXY=false and no trusted socket stamp), every client shares
 * `SHARED_CLIENT_KEY`, so that bucket acts as a GLOBAL cap (`limit × SHARED_LIMIT_FACTOR`)
 * instead of letting one client exhaust a per-IP-sized budget for everybody.
 */
class IpLimiter {
  private readonly perIp: TokenBucketLimiter;
  private readonly shared: TokenBucketLimiter;
  constructor(opts: LimiterOptions) {
    this.perIp = new TokenBucketLimiter(opts);
    this.shared = new TokenBucketLimiter({ ...opts, limit: opts.limit * SHARED_LIMIT_FACTOR });
  }
  consume(ip: string): RateLimitResult {
    return ip === SHARED_CLIENT_KEY ? this.shared.consume(ip) : this.perIp.consume(ip);
  }
  reset(ip?: string): void {
    if (ip === undefined) {
      this.perIp.reset();
      this.shared.reset();
    } else if (ip === SHARED_CLIENT_KEY) this.shared.reset(ip);
    else this.perIp.reset(ip);
  }
}

interface Limiters {
  chatIp: IpLimiter;
  apiIp: IpLimiter;
  loginIp: IpLimiter;
  statusIp: IpLimiter;
  /** Status lookups per conversation (chat `lookup_status` tool, SEC-10). */
  statusConversation: TokenBucketLimiter;
  checkoutIp: IpLimiter;
  /** Booking-form "Service details" edits per IP. */
  draftEditIp: IpLimiter;
  /** New "Talk to a person" tickets per IP (R2-2). */
  escalationIp: IpLimiter;
  /** New "Talk to a person" tickets per business, all clients together (R2-2). */
  escalationBusiness: TokenBucketLimiter;
  turns: CountLimiter;
  login: LoginGuard;
}

const G = globalThis as unknown as { __oasisLimiters?: Limiters };

export const LOGIN_ATTEMPTS = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const STATUS_WINDOW_MS = 10 * 60 * 1000;
export const CHECKOUT_WINDOW_MS = 10 * 60 * 1000;
export const ESCALATION_WINDOW_MS = 60 * 60 * 1000;

/** Key used when the client address is unknown (see `clientIp`). */
export const SHARED_CLIENT_KEY = "shared";
/** The shared fallback bucket is this many times larger than a per-IP bucket. */
export const SHARED_LIMIT_FACTOR = 20;

function limiters(): Limiters {
  if (!G.__oasisLimiters) {
    const env = getEnv();
    G.__oasisLimiters = {
      chatIp: new IpLimiter({
        limit: env.RATE_LIMIT_IP_PER_10MIN,
        windowMs: RATE_LIMIT_CHAT_WINDOW_MS,
      }),
      apiIp: new IpLimiter({
        limit: env.RATE_LIMIT_API_PER_MIN,
        windowMs: RATE_LIMIT_API_WINDOW_MS,
      }),
      loginIp: new IpLimiter({ limit: LOGIN_ATTEMPTS, windowMs: LOGIN_WINDOW_MS }),
      statusIp: new IpLimiter({
        limit: env.RATE_LIMIT_STATUS_PER_10MIN,
        windowMs: STATUS_WINDOW_MS,
      }),
      statusConversation: new TokenBucketLimiter({
        limit: env.RATE_LIMIT_STATUS_PER_10MIN,
        windowMs: STATUS_WINDOW_MS,
      }),
      checkoutIp: new IpLimiter({
        limit: env.RATE_LIMIT_CHECKOUT_PER_10MIN,
        windowMs: CHECKOUT_WINDOW_MS,
      }),
      draftEditIp: new IpLimiter({
        limit: env.RATE_LIMIT_DRAFT_EDIT_PER_10MIN,
        windowMs: CHECKOUT_WINDOW_MS,
      }),
      escalationIp: new IpLimiter({
        limit: env.RATE_LIMIT_ESCALATION_PER_HOUR,
        windowMs: ESCALATION_WINDOW_MS,
      }),
      escalationBusiness: new TokenBucketLimiter({
        limit: env.RATE_LIMIT_ESCALATION_GLOBAL_PER_HOUR,
        windowMs: ESCALATION_WINDOW_MS,
      }),
      turns: new CountLimiter(env.OASIS_MAX_TURNS),
      login: new LoginGuard(),
    };
  }
  return G.__oasisLimiters;
}

/** Test helper: drop all counters (and re-read env limits on next use). */
export function resetRateLimits(): void {
  G.__oasisLimiters = undefined;
}

/** Generic API limit: `RATE_LIMIT_API_PER_MIN` per IP. Applied by the proxy to /api/*. */
export function checkApiRateLimit(ip: string): RateLimitResult {
  return limiters().apiIp.consume(ip);
}

/**
 * Chat limits: `RATE_LIMIT_IP_PER_10MIN` messages per IP, and `OASIS_MAX_TURNS` user
 * messages per conversation (hard cap). Call once per user message, before the LLM.
 * `scope` tells the UI which message to show.
 */
export function checkChatRateLimit(input: {
  ip: string;
  conversationId?: string | null;
}): RateLimitResult & { scope?: "ip" | "conversation" } {
  const ipRes = limiters().chatIp.consume(input.ip);
  if (!ipRes.ok) return { ...ipRes, scope: "ip" };
  if (input.conversationId) {
    const turnRes = limiters().turns.consume(input.conversationId);
    if (!turnRes.ok) return { ...turnRes, scope: "conversation" };
  }
  return ipRes;
}

/**
 * R2-4: a brand-new conversation is created AFTER `checkChatRateLimit` (which therefore could
 * not count its first message). Count that first user message here, right after creation, so
 * `OASIS_MAX_TURNS = N` accepts exactly N user messages per conversation.
 */
export function countFirstTurn(conversationId: string): RateLimitResult {
  return limiters().turns.consume(conversationId);
}

/**
 * "Talk to a person" flood guard (R2-2): `RATE_LIMIT_ESCALATION_PER_HOUR` (default 3) NEW
 * tickets per IP and `RATE_LIMIT_ESCALATION_GLOBAL_PER_HOUR` (default 30) per business across
 * all clients. Call only when a new ticket would be created (a deduplicated request for the
 * conversation's open ticket sends no email and is not counted).
 */
export function checkEscalationRateLimit(
  ip: string,
  businessId: string,
): RateLimitResult & { scope?: "ip" | "business" } {
  const l = limiters();
  const biz = l.escalationBusiness.peek(businessId);
  if (!biz.ok) return { ...biz, scope: "business" };
  const ipRes = l.escalationIp.consume(ip);
  if (!ipRes.ok) return { ...ipRes, scope: "ip" };
  const bizRes = l.escalationBusiness.consume(businessId);
  if (!bizRes.ok) return { ...bizRes, scope: "business" };
  return ipRes;
}

/**
 * Owner login throttle: 5 attempts per 15 minutes per key. Consumes one attempt. The key is the
 * client IP, or `device:<id>` for a browser with a verified known-device cookie (R2-3), so an
 * attacker sharing the owner's IP cannot burn the owner's budget.
 */
export function checkLoginRateLimit(ip: string): RateLimitResult {
  return limiters().loginIp.consume(ip);
}

/** The IP-independent owner-login guard (global failure cap + per-username backoff). */
export function loginGuard(): LoginGuard {
  return limiters().login;
}

/**
 * Status lookups: `RATE_LIMIT_STATUS_PER_10MIN` (default 10) per IP, so references cannot be
 * enumerated, and the same budget per conversation when the lookup comes from the chat
 * `lookup_status` tool (SEC-10). Consumes one attempt per lookup, found or not.
 */
export function checkStatusRateLimit(ip: string, conversationId?: string): RateLimitResult {
  const ipRes = limiters().statusIp.consume(ip);
  if (!ipRes.ok || !conversationId) return ipRes;
  return limiters().statusConversation.consume(conversationId);
}

/** Checkout review/confirm: `RATE_LIMIT_CHECKOUT_PER_10MIN` (default 30) per IP. */
export function checkCheckoutRateLimit(ip: string): RateLimitResult {
  return limiters().checkoutIp.consume(ip);
}

/** Booking-form "Service details" edits: `RATE_LIMIT_DRAFT_EDIT_PER_10MIN` (default 120) per IP. */
export function checkDraftEditRateLimit(ip: string): RateLimitResult {
  return limiters().draftEditIp.consume(ip);
}

/** Clear the login throttle for an IP after a successful login. */
export function resetLoginRateLimit(ip: string): void {
  limiters().loginIp.reset(ip);
}

// ---------------------------------------------------------------------------------------
// Client IP
// ---------------------------------------------------------------------------------------

const IP_RE = /^[0-9a-fA-F:.]{2,45}$/;

function normalizeIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (ip.startsWith("[")) ip = ip.slice(1, ip.indexOf("]") > 0 ? ip.indexOf("]") : undefined);
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return IP_RE.test(ip) ? ip.toLowerCase() : null;
}

/**
 * Client IP for rate limiting (SEC-2).
 *
 * - `TRUST_PROXY=true`: the right-most `X-Forwarded-For` entry (the one your reverse proxy
 *   appended), then `X-Real-IP`, then the trusted socket stamp.
 * - `TRUST_PROXY=false` (default): client-supplied forwarding headers are IGNORED (Next.js
 *   passes a client's own `X-Forwarded-For` through unchanged, so it is spoofable). The
 *   address comes from the trusted socket stamp (src/guard/peer-address.ts, installed at
 *   server start). Without it, every client shares `SHARED_CLIENT_KEY`, whose buckets are
 *   `SHARED_LIMIT_FACTOR`× larger and act as global caps; per-conversation turn limits,
 *   budgets and the IP-independent login guard still apply.
 */
export function clientIp(request: { headers: Headers }, trustProxy?: boolean): string {
  const trust = trustProxy ?? getEnv().TRUST_PROXY;
  const peer = normalizeIp(readPeerAddress(request.headers));
  if (trust) {
    const xff = request.headers.get("x-forwarded-for");
    const entries = xff
      ? xff
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    return (
      normalizeIp(entries[entries.length - 1]) ??
      normalizeIp(request.headers.get("x-real-ip")) ??
      peer ??
      SHARED_CLIENT_KEY
    );
  }
  return peer ?? SHARED_CLIENT_KEY;
}

// ---------------------------------------------------------------------------------------
// Owner login guard (IP-independent)
// ---------------------------------------------------------------------------------------

export interface LoginGuardOptions {
  /** Failed logins across ALL clients per window before untrusted clients are refused. */
  globalFailures?: number;
  globalWindowMs?: number;
  /** Consecutive failures per username before backoff starts. */
  freeFailures?: number;
  /** First lockout; doubles with each further failure, capped at `maxLockMs`. */
  baseLockMs?: number;
  maxLockMs?: number;
  now?: () => number;
}

interface UserState {
  failures: number;
  lockedUntil: number;
  touchedAt: number;
}

/**
 * Brute-force protection that IP rotation cannot dodge, designed so an attacker cannot
 * permanently lock the owner out:
 *
 * - Per-username exponential backoff: after `freeFailures` (5) consecutive failures the
 *   username locks for 30 s, doubling per further failure up to `maxLockMs` (15 min). Attempts
 *   during a lock are refused WITHOUT counting, so an attacker cannot extend it beyond the cap.
 * - Global cap: more than `globalFailures` (50) failures per 15 min across all clients refuses
 *   further attempts from untrusted clients until the bucket refills.
 * - Known devices (R2-3): a browser holding a valid signed `oasis_device` cookie for this
 *   username (src/auth/device-token.ts, issued on every successful sign-in, 30 days) bypasses
 *   both the username lock and the global cap, so the owner can always sign in from a known
 *   device even while an attacker keeps the lock engaged. It is NOT an IP address: sharing the
 *   owner's NAT/VPN/office IP or forging X-Forwarded-For grants nothing, and it survives a
 *   restart (stateless signature). The caller verifies the cookie and passes `knownDevice`.
 *   A successful login clears the username's failures.
 */
export class LoginGuard {
  private readonly users = new Map<string, UserState>();
  private readonly global: TokenBucketLimiter;
  private readonly freeFailures: number;
  private readonly baseLockMs: number;
  private readonly maxLockMs: number;
  private readonly now: () => number;

  constructor(opts: LoginGuardOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.global = new TokenBucketLimiter({
      limit: opts.globalFailures ?? 50,
      windowMs: opts.globalWindowMs ?? LOGIN_WINDOW_MS,
      now: this.now,
    });
    this.freeFailures = opts.freeFailures ?? LOGIN_ATTEMPTS;
    this.baseLockMs = opts.baseLockMs ?? 30_000;
    this.maxLockMs = opts.maxLockMs ?? LOGIN_WINDOW_MS;
  }

  private key(username: string): string {
    return username.trim().toLowerCase().slice(0, 100);
  }

  /**
   * Before verifying a password: may this attempt proceed? `knownDevice` = the request carries
   * a verified known-device cookie issued to this username.
   */
  check(username: string, knownDevice = false): RateLimitResult {
    const limit = this.freeFailures;
    if (knownDevice) return { ok: true, retryAfterSec: 0, remaining: limit, limit };
    const t = this.now();
    const u = this.users.get(this.key(username));
    if (u && u.lockedUntil > t) {
      return {
        ok: false,
        retryAfterSec: Math.ceil((u.lockedUntil - t) / 1000),
        remaining: 0,
        limit,
      };
    }
    const g = this.global.peek("all");
    if (!g.ok) return { ...g, remaining: 0, limit };
    return { ok: true, retryAfterSec: 0, remaining: limit, limit };
  }

  /** After a failed password check. */
  recordFailure(username: string): void {
    const t = this.now();
    this.global.consume("all");
    const k = this.key(username);
    const u = this.users.get(k) ?? { failures: 0, lockedUntil: 0, touchedAt: t };
    u.failures += 1;
    u.touchedAt = t;
    if (u.failures >= this.freeFailures) {
      const exp = u.failures - this.freeFailures;
      u.lockedUntil = t + Math.min(this.maxLockMs, this.baseLockMs * 2 ** Math.min(exp, 20));
    }
    this.users.delete(k);
    this.users.set(k, u);
    while (this.users.size > 1000) {
      const oldest = this.users.keys().next().value;
      if (oldest === undefined) break;
      this.users.delete(oldest);
    }
  }

  /** After a successful sign-in (the route then issues a known-device cookie). */
  recordSuccess(username: string): void {
    this.users.delete(this.key(username));
  }
}
