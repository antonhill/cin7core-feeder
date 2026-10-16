// Helpers for scripts/probe-sale-invoices-readonly.mjs (read-only Cin7 probe). Dependency-free so they can be
// unit-tested without any credentials (see src/lib/projects/__tests__/probe-support.test.ts).
import { createDecipheriv } from "node:crypto";

/**
 * Decrypts a stored Cin7 application key. MUST stay byte-compatible with decrypt() in src/cin7/crypto.ts:
 * AES-256-GCM, stored as "iv.authTag.ciphertext" (each base64), key = ENCRYPTION_KEY (base64, 32 bytes).
 * The plaintext is returned to the caller for in-memory use only; this module never logs or stores it.
 */
export function decryptInstanceKey(stored, encryptionKeyB64) {
  const key = Buffer.from(encryptionKeyB64 ?? "", "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes");
  const parts = String(stored).split(".");
  if (parts.length !== 3) throw new Error("Malformed ciphertext");
  const [iv, tag, data] = parts.map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** Shape-only view of free text (letters -> a/A, digits -> 9, everything else kept) so reference-style fields can be
 * assessed (format, uniqueness pattern) without exposing the commercial content. Long values are truncated. */
export function maskText(value, max = 24) {
  if (value === null || value === undefined || value === "") return "";
  return String(value)
    .slice(0, max)
    .replace(/[a-z]/g, "a")
    .replace(/[A-Z]/g, "A")
    .replace(/[0-9]/g, "9");
}

/** Sum of a numeric field over an array, treating missing values as 0. */
export function sumField(items, field) {
  return (items ?? []).reduce((n, x) => n + (Number(x?.[field]) || 0), 0);
}

export const keyNames = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).sort() : []);

export const tally = (arr) => arr.reduce((m, k) => ((m[k ?? "?"] = (m[k ?? "?"] ?? 0) + 1), m), {});

/** Prioritise which sales get a detail call: sales whose list row suggests multiple/partial invoicing first. */
export function invoicePriority(row) {
  const inv = String(row?.CombinedInvoiceStatus ?? "").toUpperCase();
  const total = Number(row?.SaleInvoicesTotalAmount) || 0;
  const notInvoiced = inv.startsWith("NOT ") || inv.includes("NOT INVOICED") || inv === "";
  if (inv.includes("PARTIAL")) return 0; // partially invoiced -> most likely to carry several invoices
  if (total > 0) return 1; // an invoiced amount exists whatever the label says
  if (notInvoiced) return 2;
  if (inv.includes("INVOICED") || inv.includes("PAID") || inv.includes("AUTHORISED")) return 1;
  return 2; // unknown label and nothing invoiced
}
