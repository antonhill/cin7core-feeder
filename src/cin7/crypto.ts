import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;

function getKey(): Buffer {
  const b64 = process.env.ENCRYPTION_KEY;
  if (!b64) throw new Error("ENCRYPTION_KEY is not configured");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}

/** Encrypts a Cin7 application key for storage. Format: iv.authTag.ciphertext, each base64. */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((b) => b.toString("base64")).join(".");
}

/** Reverses encrypt(). Throws if ENCRYPTION_KEY doesn't match or the ciphertext was tampered with. */
export function decrypt(stored: string): string {
  const key = getKey();
  const parts = stored.split(".");
  if (parts.length !== 3) throw new Error("Malformed ciphertext");
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return plaintext.toString("utf8");
}
