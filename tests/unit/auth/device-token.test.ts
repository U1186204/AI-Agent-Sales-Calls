/** R2-3: the signed owner "known device" token that replaced IP-address trust. */
import { describe, expect, it } from "vitest";
import { DEVICE_TTL_SEC, signDeviceToken, verifyDeviceToken } from "@/auth/device-token";
import { signSession } from "@/auth/session-token";

const SECRET = "test-session-secret-0123456789abcdef0123456789";
const NOW = 1_800_000_000;

describe("known-device token", () => {
  it("round-trips username, issue time and a 128-bit random id", () => {
    const { token, device } = signDeviceToken("owner", SECRET, { nowSec: NOW });
    expect(device.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(verifyDeviceToken(token, SECRET, NOW + 60)).toEqual(device);
    // every sign-in gets a new id
    expect(signDeviceToken("owner", SECRET).device.id).not.toBe(device.id);
  });

  it("expires after 30 days and rejects tokens issued in the future", () => {
    const { token } = signDeviceToken("owner", SECRET, { nowSec: NOW });
    expect(verifyDeviceToken(token, SECRET, NOW + DEVICE_TTL_SEC - 1)).not.toBeNull();
    expect(verifyDeviceToken(token, SECRET, NOW + DEVICE_TTL_SEC)).toBeNull();
    expect(verifyDeviceToken(token, SECRET, NOW - 3600)).toBeNull();
  });

  it("is invalidated by rotating SESSION_SECRET and by any tampering", () => {
    const { token } = signDeviceToken("owner", SECRET, { nowSec: NOW });
    expect(verifyDeviceToken(token, "another-secret-0123456789abcdef0123456789", NOW)).toBeNull();
    const [payload, sig] = token.split(".") as [string, string];
    const other = Buffer.from(JSON.stringify({ u: "admin", iat: NOW, id: "B".repeat(22) }));
    expect(verifyDeviceToken(`${other.toString("base64url")}.${sig}`, SECRET, NOW)).toBeNull();
    expect(verifyDeviceToken(`${payload}.${sig}x`, SECRET, NOW)).toBeNull();
    for (const bad of ["", "abc", "a.b.c", undefined, null, "x".repeat(600)]) {
      expect(verifyDeviceToken(bad, SECRET, NOW)).toBeNull();
    }
  });

  it("a session token signed with the same secret never passes as a device token", () => {
    const { token } = signSession("owner", SECRET, { nowSec: NOW });
    expect(verifyDeviceToken(token, SECRET, NOW)).toBeNull();
  });
});
