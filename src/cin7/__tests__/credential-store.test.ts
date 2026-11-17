import { describe, it, expect, afterEach } from "vitest";
import { credentialColumn, storedCiphertext, requireCiphertext } from "@/cin7/credential-store";

const original = process.env.CIN7_CREDENTIAL_STORE;
afterEach(() => { if (original === undefined) delete process.env.CIN7_CREDENTIAL_STORE; else process.env.CIN7_CREDENTIAL_STORE = original; });

describe("Cin7 credential store selection", () => {
  const row = { application_key_encrypted: "toolbox.sealed.value", application_key_encrypted_uat: "uat.sealed.value" };

  it("defaults to the Toolbox column", () => {
    delete process.env.CIN7_CREDENTIAL_STORE;
    expect(credentialColumn()).toBe("application_key_encrypted");
    expect(storedCiphertext(row)).toBe("toolbox.sealed.value");
  });

  it("uses only the UAT column when CIN7_CREDENTIAL_STORE=uat", () => {
    process.env.CIN7_CREDENTIAL_STORE = "uat";
    expect(credentialColumn()).toBe("application_key_encrypted_uat");
    expect(storedCiphertext(row)).toBe("uat.sealed.value");
  });

  it("never falls back to the Toolbox ciphertext in UAT mode", () => {
    process.env.CIN7_CREDENTIAL_STORE = "uat";
    const unset = { application_key_encrypted: "toolbox.sealed.value", application_key_encrypted_uat: null };
    expect(storedCiphertext(unset)).toBeNull();
    expect(() => requireCiphertext(unset)).toThrow("not configured for this environment");
  });

  it("treats any other value as the default store", () => {
    process.env.CIN7_CREDENTIAL_STORE = "UAT ";
    expect(credentialColumn()).toBe("application_key_encrypted");
  });
});
