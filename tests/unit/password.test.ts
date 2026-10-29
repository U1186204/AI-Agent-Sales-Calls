import { describe, expect, it } from "vitest";
import { hashPassword, parsePasswordHash, verifyPassword } from "@/auth/password";
import { DEMO_SECRETS } from "@/config/env";

describe("password hashing (scrypt)", () => {
  it("hashes in scrypt$N$r$p$salt$hash format and verifies", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("uses a random salt", async () => {
    const [a, b] = await Promise.all([hashPassword("same"), hashPassword("same")]);
    expect(a).not.toBe(b);
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });

  it("verifies the shipped demo hash for the documented demo password", async () => {
    expect(await verifyPassword("oasis-demo-2026", DEMO_SECRETS.OWNER_PASSWORD_HASH)).toBe(true);
    expect(await verifyPassword("oasis-demo-2025", DEMO_SECRETS.OWNER_PASSWORD_HASH)).toBe(false);
  });

  it("honors custom cost parameters", async () => {
    const hash = await hashPassword("pw", { N: 1024, r: 8, p: 1 });
    expect(hash.startsWith("scrypt$1024$8$1$")).toBe(true);
    expect(await verifyPassword("pw", hash)).toBe(true);
  });

  it.each([
    "",
    "plaintext",
    "bcrypt$10$abc$def",
    "scrypt$16384$8$1$onlyfive",
    "scrypt$1000$8$1$c2FsdHNhbHQ=$aGFzaGhhc2hoYXNoaGFzaA==", // N not a power of two
    "scrypt$4194304$8$1$c2FsdHNhbHQ=$aGFzaGhhc2hoYXNoaGFzaA==", // N too large (DoS guard)
    "scrypt$16384$64$1$c2FsdHNhbHQ=$aGFzaGhhc2hoYXNoaGFzaA==", // r too large
  ])("rejects malformed hash %j without throwing", async (stored) => {
    expect(parsePasswordHash(stored)).toBeNull();
    await expect(verifyPassword("anything", stored)).resolves.toBe(false);
  });

  it("rejects empty passwords at hash time", async () => {
    await expect(hashPassword("")).rejects.toThrow();
  });
});
