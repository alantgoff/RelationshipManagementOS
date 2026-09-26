import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decrypt, encrypt, isEncrypted, safeEqual } from "@/lib/crypto";

const original = process.env.RMOS_ENCRYPTION_KEY;
beforeEach(() => {
  process.env.RMOS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});
afterEach(() => {
  process.env.RMOS_ENCRYPTION_KEY = original;
});

describe("encrypt/decrypt", () => {
  it("round-trips unicode text and uses a fresh IV each time", () => {
    const text = "Priya 🙌 soft-circled $250k — call back Friday";
    const a = encrypt(text);
    const b = encrypt(text);
    expect(a).not.toBe(b);
    expect(isEncrypted(a)).toBe(true);
    expect(decrypt(a)).toBe(text);
    expect(decrypt(b)).toBe(text);
  });

  it("rejects tampered ciphertext", () => {
    const parts = encrypt("secret").split(":");
    const body = Buffer.from(parts[3], "base64");
    body[0] ^= 0xff;
    parts[3] = body.toString("base64");
    expect(() => decrypt(parts.join(":"))).toThrow();
  });

  it("fails without a key or with a wrong-length key", () => {
    delete process.env.RMOS_ENCRYPTION_KEY;
    expect(() => encrypt("x")).toThrow(/RMOS_ENCRYPTION_KEY/);
    process.env.RMOS_ENCRYPTION_KEY = Buffer.from("short").toString("base64");
    expect(() => encrypt("x")).toThrow(/32 bytes/);
  });

  it("does not decrypt with a different key", () => {
    const payload = encrypt("secret");
    process.env.RMOS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    expect(() => decrypt(payload)).toThrow();
  });

  it("recognizes non-encrypted values", () => {
    expect(isEncrypted("plain text")).toBe(false);
    expect(() => decrypt("plain text")).toThrow(/Not an encrypted payload/);
  });
});

describe("safeEqual", () => {
  it("compares strings of equal and unequal length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});
