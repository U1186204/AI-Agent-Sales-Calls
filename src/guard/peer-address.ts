/**
 * Trusted client socket address for rate limiting (SEC-2).
 *
 * Next.js 16 route handlers and `proxy.ts` receive a Web `Request` with no socket address
 * (`NextRequest.ip` no longer exists), and the only address Next passes along is
 * `X-Forwarded-For`, which it fills from the socket ONLY when the client did not send one —
 * so a direct client can spoof it. Nothing in the request is trustworthy on its own.
 *
 * `installPeerAddressStamp()` (called once from src/instrumentation.ts in the Node runtime)
 * wraps `http.Server.prototype.emit` so every incoming request gets a private header
 * `x-oasis-peer: <per-process secret>:<socket remoteAddress>` before Next.js sees it. Any
 * client-supplied value is deleted first, and `readPeerAddress()` accepts the header only
 * with the per-process secret, so it cannot be forged. When the stamp is not installed (unit
 * tests, an unusual runtime), `readPeerAddress()` returns null and callers fall back to a
 * shared key (see guard/rate-limit `clientIp`).
 *
 * Note: only `http.Server` is wrapped. An `https.Server` (e.g. `next dev --experimental-https`)
 * does not inherit from it, so there every client shares the fallback key (fails safe: larger
 * shared buckets, dev only).
 */
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";

export const PEER_HEADER = "x-oasis-peer";

interface PeerState {
  token: string;
  installed: boolean;
}

const G = globalThis as unknown as { __oasisPeer?: PeerState };

function state(): PeerState {
  G.__oasisPeer ??= { token: randomBytes(16).toString("hex"), installed: false };
  return G.__oasisPeer;
}

/** True once the stamp is active in this process. */
export function peerStampInstalled(): boolean {
  return state().installed;
}

/** The header value the stamp writes for `address` (exported for tests). */
export function peerHeaderValue(address: string): string {
  return `${state().token}:${address}`;
}

/** The verified socket address, or null when absent/forged. */
export function readPeerAddress(headers: Headers): string | null {
  const raw = headers.get(PEER_HEADER);
  if (!raw) return null;
  const prefix = `${state().token}:`;
  if (!raw.startsWith(prefix)) return null;
  const addr = raw.slice(prefix.length).trim();
  return addr || null;
}

interface MinimalIncoming {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string } | null;
}

/** Stamp one Node request (exported for tests). */
export function stampRequest(req: MinimalIncoming): void {
  delete req.headers[PEER_HEADER];
  const addr = req.socket?.remoteAddress;
  if (addr) req.headers[PEER_HEADER] = peerHeaderValue(addr);
}

/** Idempotent. Node runtime only (never import this from client code). */
export async function installPeerAddressStamp(): Promise<void> {
  const s = state();
  if (s.installed) return;
  // Loaded lazily so bundlers never pull node:http into an edge/client graph.
  const http = await import("node:http");
  const original = http.Server.prototype.emit;
  http.Server.prototype.emit = function emit(
    this: Server,
    event: string | symbol,
    ...args: unknown[]
  ): boolean {
    if (event === "request" && args[0] && typeof args[0] === "object") {
      try {
        stampRequest(args[0] as MinimalIncoming);
      } catch {
        // never break request handling
      }
    }
    return (original as (this: unknown, ...a: unknown[]) => boolean).call(this, event, ...args);
  } as typeof original;
  s.installed = true;
}
