/**
 * Owner "known device" token (R2-3). Replaces the old IP-address trust in the login guard.
 *
 * Token: `<payload b64url>.<HMAC-SHA256 b64url>`, payload `{u, iat, id}` (username, issued-at
 * epoch seconds, 128-bit random id), signed with SESSION_SECRET under a "device:" domain tag so
 * a session token can never pass as a device token (or the other way round).
 *
 * - Issued as the HttpOnly, SameSite=Strict (Secure in production) cookie `oasis_device` on
 *   every successful sign-in, valid for 30 days, scoped to the login endpoint.
 * - Stateless: survives a server restart (only the signature is checked), and it cannot be
 *   inherited by sharing the owner's IP address (NAT, VPN, office network).
 * - Rotating SESSION_SECRET invalidates every device token at once.
 *
 * No Next.js imports (unit-testable in plain Node).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DEVICE_COOKIE = "oasis_device";
export const DEVICE_TTL_SEC = 30 * 24 * 60 * 60;
/** The cookie is only ever needed by the sign-in endpoint. */
export const DEVICE_COOKIE_PATH = "/api/owner/login";
const SKEW_SEC = 60;

export interface DeviceToken {
  /** Owner username the device signed in as. */
  u: string;
  /** Issued at, epoch seconds. */
  iat: number;
  /** Random device id (128-bit, base64url). */
  id: string;
}

function sign(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(`device:${payload}`).digest();
}

export function signDeviceToken(
  username: string,
  secret: string,
  opts: { nowSec?: number; id?: string } = {},
): { token: string; device: DeviceToken } {
  const device: DeviceToken = {
    u: username,
    iat: opts.nowSec ?? Math.floor(Date.now() / 1000),
    id: opts.id ?? randomBytes(16).toString("base64url"),
  };
  const payload = Buffer.from(JSON.stringify(device), "utf8").toString("base64url");
  return { token: `${payload}.${sign(payload, secret).toString("base64url")}`, device };
}

/**
 * The device token when the signature is valid (under `secret`) and it was issued less than
 * DEVICE_TTL_SEC ago (not in the future); otherwise null.
 */
export function verifyDeviceToken(
  token: string | null | undefined,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): DeviceToken | null {
  if (!token || token.length > 512) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;
  const expected = sign(payload, secret);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const d = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<DeviceToken>;
    if (
      typeof d !== "object" ||
      d === null ||
      typeof d.u !== "string" ||
      typeof d.id !== "string" ||
      !/^[A-Za-z0-9_-]{16,64}$/.test(d.id) ||
      typeof d.iat !== "number" ||
      !Number.isFinite(d.iat)
    ) {
      return null;
    }
    if (d.iat > nowSec + SKEW_SEC) return null;
    if (nowSec - d.iat >= DEVICE_TTL_SEC) return null;
    return { u: d.u, iat: d.iat, id: d.id };
  } catch {
    return null;
  }
}
