/**
 * Server-side owner session store (SEC-4). An allow-list of active session ids with their
 * expiry, kept in process memory on `globalThis` (shared by the proxy and route handlers in
 * the same Node process, like the rate limiters).
 *
 * - Login adds the new `sid`; logout removes it, so a copied cookie stops working at once.
 * - Fail-closed: a server restart empties the store and signs the owner out (single-owner
 *   demo; documented in SPEC §8). A multi-instance deployment would back this with Redis/DB.
 * - Bounded: expired ids are swept; at most MAX_SESSIONS concurrent sessions (oldest evicted).
 */
const MAX_SESSIONS = 50;

const G = globalThis as unknown as { __oasisSessions?: Map<string, number> };

function store(): Map<string, number> {
  G.__oasisSessions ??= new Map();
  return G.__oasisSessions;
}

function sweep(nowSec: number): void {
  const s = store();
  for (const [sid, exp] of s) if (exp <= nowSec) s.delete(sid);
  while (s.size > MAX_SESSIONS) {
    const oldest = s.keys().next().value;
    if (oldest === undefined) break;
    s.delete(oldest);
  }
}

export function activateSession(sid: string, expSec: number): void {
  const now = Math.floor(Date.now() / 1000);
  store().set(sid, expSec);
  sweep(now);
}

export function revokeSession(sid: string): void {
  store().delete(sid);
}

export function isSessionActive(
  sid: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  const exp = store().get(sid);
  return exp !== undefined && exp > nowSec;
}

/** Test helper: forget every session. */
export function resetSessionStore(): void {
  store().clear();
}
