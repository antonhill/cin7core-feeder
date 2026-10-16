import { describe, expect, it, vi } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decryptInstanceKey, maskText, invoicePriority, sumField } from "../../../../scripts/lib/probe-support.mjs";

vi.mock("server-only", () => ({}));

const ROOT = join(__dirname, "..", "..", "..", "..");
const keyB64 = randomBytes(32).toString("base64");

describe("probe decrypt is byte-compatible with the Toolbox's own crypto module", () => {
  it("decrypts what src/cin7/crypto.ts encrypt() produced", async () => {
    process.env.ENCRYPTION_KEY = keyB64;
    const { encrypt, decrypt } = await import("@/cin7/crypto");
    const stored = encrypt("super-secret-application-key-123");
    expect(decryptInstanceKey(stored, keyB64)).toBe("super-secret-application-key-123");
    expect(decryptInstanceKey(stored, keyB64)).toBe(decrypt(stored)); // identical to the app's own decrypt
  });
  it("rejects a wrong key, a tampered ciphertext and malformed input (fails closed)", async () => {
    process.env.ENCRYPTION_KEY = keyB64;
    const { encrypt } = await import("@/cin7/crypto");
    const stored = encrypt("k");
    expect(() => decryptInstanceKey(stored, randomBytes(32).toString("base64"))).toThrow();
    const [iv, tag, data] = stored.split(".");
    const flipped = Buffer.from(data, "base64"); flipped[0] ^= 1;
    expect(() => decryptInstanceKey([iv, tag, flipped.toString("base64")].join("."), keyB64)).toThrow();
    expect(() => decryptInstanceKey("not-three-parts", keyB64)).toThrow(/Malformed/);
    expect(() => decryptInstanceKey(stored, "c2hvcnQ=")).toThrow(/32 bytes/);
  });
  it("independent re-encryption round-trips too", () => {
    const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", Buffer.from(keyB64, "base64"), iv);
    const ct = Buffer.concat([c.update("abc", "utf8"), c.final()]);
    expect(decryptInstanceKey([iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join("."), keyB64)).toBe("abc");
  });
});

describe("sanitising + prioritising helpers", () => {
  it("maskText keeps shape only and truncates", () => {
    expect(maskText("PRJ-001-C02")).toBe("AAA-999-A99");
    expect(maskText("Acme Corp project")).toBe("Aaaa Aaaa aaaaaaa");
    expect(maskText("x".repeat(60))).toHaveLength(24);
    expect(maskText(null)).toBe("");
  });
  it("sumField tolerates missing values", () => expect(sumField([{ q: 2 }, {}, { q: "3" }], "q")).toBe(5));
  it("partially-invoiced sales are inspected first, un-invoiced last", () => {
    expect(invoicePriority({ CombinedInvoiceStatus: "PARTIALLY INVOICED" })).toBe(0);
    expect(invoicePriority({ CombinedInvoiceStatus: "INVOICED" })).toBe(1);
    expect(invoicePriority({ SaleInvoicesTotalAmount: 10 })).toBe(1);
    expect(invoicePriority({ CombinedInvoiceStatus: "NOT INVOICED" })).toBe(2);
    expect(invoicePriority({ CombinedInvoiceStatus: "NOT INVOICED", SaleInvoicesTotalAmount: 0 })).toBe(2);
    expect(invoicePriority({ CombinedInvoiceStatus: "NOT INVOICED", SaleInvoicesTotalAmount: 50 })).toBe(1); // amount wins over label
    expect(invoicePriority({})).toBe(2);
    expect(invoicePriority({ CombinedInvoiceStatus: "PARTIALLY INVOICED", SaleInvoicesTotalAmount: 5 })).toBe(0);
  });
});

describe("the probe script itself stays read-only", () => {
  const script = readFileSync(join(ROOT, "scripts/probe-sale-invoices-readonly.mjs"), "utf8");
  it("has no write verbs, a single HTTP call site (GET) and select-only database reads", () => {
    expect(script).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
    expect(script).not.toMatch(/method:\s*["'](?!GET)/);
    expect(script.match(/\bfetch\(/g)).toHaveLength(1);
    expect(script).not.toMatch(/\.(insert|update|upsert|delete|rpc)\s*\(/);
    const froms = script.match(/\.from\(/g)?.length ?? 0;
    const selects = script.match(/\.from\([^)]*\)\s*\n?\s*\.select\(/g)?.length ?? 0;
    expect(froms).toBeGreaterThan(0);
    expect(selects).toBe(froms); // every .from() is immediately followed by .select()
  });
  it("never prints decrypted credentials or ciphertext", () => {
    expect(script).not.toMatch(/console\.\w+\(\s*(APP_KEY|ACCOUNT_ID|process\.env)/);
    expect(script).not.toMatch(/\$\{\s*(APP_KEY|process\.env\.(SUPABASE_SERVICE_ROLE_KEY|ENCRYPTION_KEY))/);
    expect(script).not.toMatch(/writeFile|appendFile|createWriteStream/);
    // the only thing done with the stored ciphertext is decrypting it in memory
    const uses = script.split("\n").filter((l) => /application_key_encrypted/.test(l) && !l.trim().startsWith("//"));
    expect(uses.every((l) => /select\(|decryptInstanceKey\(/.test(l))).toBe(true);
  });
  it("organisation / instance scoping guards are present (unique org, unique active instance, scoped key read)", () => {
    expect(script).toMatch(/orgs\.length !== 1/);
    expect(script).toMatch(/candidates\.length !== 1/);
    expect(script).toMatch(/\.eq\("id", inst\.id\)\.eq\("org_id", org\.id\)/);
    expect(script).toMatch(/DRY_RUN/);
  });
});
