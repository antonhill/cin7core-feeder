import { describe, expect, it, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt } from "@/cin7/crypto";

beforeEach(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

describe("encrypt/decrypt", () => {
  it("round-trips a plaintext value", () => {
    const plaintext = "super-secret-cin7-app-key";
    const ciphertext = encrypt(plaintext);
    expect(ciphertext).not.toBe(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encrypt("same-value");
    const b = encrypt("same-value");
    expect(a).not.toBe(b);
  });

  it("fails to decrypt with the wrong key", () => {
    const ciphertext = encrypt("secret");
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
    expect(() => decrypt(ciphertext)).toThrow();
  });

  it("fails to decrypt tampered ciphertext", () => {
    const ciphertext = encrypt("secret");
    const [iv, tag, data] = ciphertext.split(".");
    const tampered = [iv, tag, Buffer.from(data, "base64").reverse().toString("base64")].join(".");
    expect(() => decrypt(tampered)).toThrow();
  });

  it("throws a clear error when ENCRYPTION_KEY is missing", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encrypt("secret")).toThrow("ENCRYPTION_KEY is not configured");
  });
});
