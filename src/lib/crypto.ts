import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Application-level encryption for secrets and sensitive free text that the
 * app never needs to search in SQL: OAuth tokens, raw channel message bodies.
 *
 * Format: `v1:<iv b64>:<tag b64>:<ciphertext b64>` using AES-256-GCM.
 * Key: RMOS_ENCRYPTION_KEY, 32 random bytes encoded as base64
 * (generate with `openssl rand -base64 32`).
 *
 * Searchable CRM text (notes, summaries) is deliberately left to the
 * database's at-rest encryption, because the app searches it with SQL.
 */
const PREFIX = "v1";

function loadKey(): Buffer {
  const raw = process.env.RMOS_ENCRYPTION_KEY;
  if (!raw) throw new Error("RMOS_ENCRYPTION_KEY is not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("RMOS_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return key;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", loadKey(), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64"), tag.toString("base64"), body.toString("base64")].join(":");
}

export function decrypt(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error("Not an encrypted payload");
  const [, iv, tag, body] = parts;
  const decipher = createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(`${PREFIX}:`) && value.split(":").length === 4;
}

/** Constant-time string comparison for shared secrets (webhook signatures). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
