import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Reference } from "@/contracts";
import {
  CryptoError,
  decryptJson,
  decryptString,
  encryptJson,
  encryptString,
  generateReference,
  hmacLookup,
  isEncrypted,
} from "@/guard/crypto";

describe("AES-256-GCM field encryption (AT-84)", () => {
  it("round-trips and uses the v1:<iv>:<tag>:<ct> format with a fresh IV", () => {
    const a = encryptString("jane@example.com");
    const b = encryptString("jane@example.com");
    expect(a).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(isEncrypted(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(Buffer.from(a.split(":")[1]!, "base64")).toHaveLength(12);
    expect(Buffer.from(a.split(":")[2]!, "base64")).toHaveLength(16);
    expect(a).not.toContain("jane");
    expect(decryptString(a)).toBe("jane@example.com");
    expect(decryptString(encryptString(""))).toBe("");
    expect(decryptString(encryptString("Zoë – ünïcode ✓"))).toBe("Zoë – ünïcode ✓");
  });

  it("detects tampering with ciphertext, tag or IV", () => {
    const enc = encryptString("secret value");
    const [v, iv, tag, ct] = enc.split(":") as [string, string, string, string];
    const flip = (b64: string) => {
      const buf = Buffer.from(b64, "base64");
      buf[0] = buf[0]! ^ 0x01;
      return buf.toString("base64");
    };
    expect(() => decryptString([v, iv, tag, flip(ct)].join(":"))).toThrow(CryptoError);
    expect(() => decryptString([v, iv, flip(tag), ct].join(":"))).toThrow(CryptoError);
    expect(() => decryptString([v, flip(iv), tag, ct].join(":"))).toThrow(CryptoError);
    expect(() => decryptString(["v2", iv, tag, ct].join(":"))).toThrow(CryptoError);
    expect(() => decryptString("not-encrypted")).toThrow(CryptoError);
  });

  it("fails with the wrong key", () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const enc = encryptString("hello", k1);
    expect(decryptString(enc, k1)).toBe("hello");
    expect(() => decryptString(enc, k2)).toThrow(CryptoError);
    expect(() => decryptString(encryptString("x"), k2)).toThrow(/wrong key|tampered/);
  });

  it("encrypts JSON", () => {
    const enc = encryptJson({ line1: "1 Main St", zip: "78701" });
    expect(enc).not.toContain("Main");
    expect(decryptJson(enc)).toEqual({ line1: "1 Main St", zip: "78701" });
  });
});

describe("hmacLookup", () => {
  it("is deterministic, keyed and hex", () => {
    const h = hmacLookup("jane@example.com");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacLookup("jane@example.com")).toBe(h);
    expect(hmacLookup("jane@example.org")).not.toBe(h);
    expect(hmacLookup("jane@example.com", "another-key-another-key-another-key")).not.toBe(h);
  });
});

describe("generateReference", () => {
  it("produces OAS-XXXX-XXXX from the unambiguous alphabet, matching the contract", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const r = generateReference();
      expect(r).toMatch(/^OAS-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
      expect(Reference.parse(r.toLowerCase())).toBe(r);
      seen.add(r);
    }
    expect(seen.size).toBe(500);
    expect(generateReference("esc")).toMatch(/^ESC-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    expect(() => generateReference("A1")).toThrow(CryptoError);
  });
});
