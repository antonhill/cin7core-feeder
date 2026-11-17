// Which column holds this deployment's encrypted Cin7 Application Key.
//
// Default: "application_key_encrypted" (the Toolbox column, sealed with the Toolbox ENCRYPTION_KEY).
// An independent NewQuip UAT deployment sets CIN7_CREDENTIAL_STORE=uat and a DIFFERENT ENCRYPTION_KEY; it then reads and writes ONLY
// "application_key_encrypted_uat", so the Toolbox ciphertext is never read, rewritten or invalidated by that deployment (and vice versa).
// There is deliberately NO fallback between the two columns: a UAT deployment with no UAT credential reports "not configured" instead of attempting to
// decrypt a value sealed with another key.
export type CredentialColumn = "application_key_encrypted" | "application_key_encrypted_uat";

export function credentialColumn(): CredentialColumn {
  return process.env.CIN7_CREDENTIAL_STORE === "uat" ? "application_key_encrypted_uat" : "application_key_encrypted";
}

/** The stored ciphertext for this deployment, or null when none is configured here. */
export function storedCiphertext(row: object): string | null {
  const v = (row as Record<string, unknown>)[credentialColumn()];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function requireCiphertext(row: object): string {
  const c = storedCiphertext(row);
  if (!c) throw new Error("Cin7 credentials are not configured for this environment");
  return c;
}
